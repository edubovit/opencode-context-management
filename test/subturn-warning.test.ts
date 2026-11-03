import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { Message } from "@opencode/ai"
import { Autocompaction } from "../src/autocompaction.ts"
import { AUTO_KEY, type AutoWarning } from "../src/auto-state.ts"
import { settings } from "../src/config.ts"
import { readPolicy } from "../src/context.ts"
import { setupServer } from "../src/server.ts"
import { Storage } from "../src/storage.ts"
import { fixtureHost } from "./fixtures.ts"
import { mockContext } from "./host-mock.ts"

async function fixture(t: { after(run: () => Promise<void>): void }, keep = 20000) {
  const directory = await mkdtemp(path.join(tmpdir(), "cm-subturn-warning-"))
  const value = fixtureHost()
  value.data.idle = false
  value.data.session.metadata![AUTO_KEY] = { strategy: "AUTO_PER_TURN" }
  const warnings: AutoWarning[] = []
  const auto = new Autocompaction(value.host, settings({ autocompaction: { headroom: 160000, lastResortKeepTokens: keep } }), new Storage(directory, directory), warning => { warnings.push(warning) })
  t.after(async () => { auto.close(); await rm(directory, { recursive: true, force: true }) })
  return { ...value, auto, warnings }
}

test("normal automatic summaries and below-threshold requests do not warn", async t => {
  const { auto, data, warnings } = await fixture(t)
  await auto.beforeRequest(data.messages)
  assert.equal(readPolicy(data.session).operations.length, 1)
  assert.deepEqual(warnings, [])
  await auto.beforeRequest(data.messages)
  assert.deepEqual(warnings, [])
})

test("an unsplittable last-resort range emits exactly one warning before failing", async t => {
  const { auto, data, warnings } = await fixture(t)
  data.messages = [data.messages[0], ...data.messages.filter(message => message.info.role === "assistant")]
  await assert.rejects(auto.beforeRequest(data.messages), /no eligible prefix/)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].sessionID, data.session.id)
  assert.ok(warnings[0].pauseID)
  assert.match(warnings[0].message, /last-resort/)
  assert.equal(data.jobs, 0)
  assert.equal(auto.observe(data.session).pause, undefined)
})

for (const fail of [false, true]) test(`last-resort warning precedes helper work even when generation ${fail ? "fails" : "succeeds"}`, async t => {
  const { auto, host, data, warnings } = await fixture(t, 1000)
  data.messages = [data.messages[0], ...data.messages.filter(message => message.info.role === "assistant")]
  const generate = host.generate
  host.generate = async (...args) => {
    assert.equal(warnings.length, 1)
    if (fail) throw new Error("Fixture fallback failure")
    return generate(...args)
  }
  if (fail) await assert.rejects(auto.beforeRequest(data.messages), /Fixture fallback failure/)
  else await auto.beforeRequest(data.messages)
  assert.equal(warnings.length, 1)
  assert.equal(data.jobs, data.removed.length)
})

test("server emits a typed warning and logs it once even when fallback selection fails", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "cm-subturn-warning-server-"))
  const mock = mockContext()
  Object.assign(mock.context, { options: { autocompaction: { headroom: 167900 } } })
  mock.context.session.wait = async () => new Promise<void>(() => {})
  const emitted: unknown[][] = []
  const register = mock.context.rpc.register
  t.mock.method(mock.context.rpc, "register", async (...args: Parameters<typeof register>) => {
    const registered = await register(...args)
    return { ...registered, events: { emit: async (...event: unknown[]) => { emitted.push(event) } } }
  })
  const logged = t.mock.method(console, "warn", () => {})
  const text = "oversized input ".repeat(1000)
  mock.messages.set("ses_native", [{ id: "msg_input", type: "user", text, time: { created: 1 } }])
  const close = await setupServer(mock.context, new Storage(directory, directory))
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }) })
  await assert.rejects(mock.hooks.get("context")!({ sessionID: "ses_native", agent: "build", model: { providerID: "fixture", id: "model" }, system: [], tools: {}, options: {}, messages: [Message.make({ id: "msg_input", role: "user", content: text })] }), /no eligible prefix/)
  assert.equal(logged.mock.calls.length, 1)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0][0], "warning")
  assert.equal((emitted[0][1] as AutoWarning).sessionID, "ses_native")
  assert.equal(mock.state.prompts.length, 0)
})

test("production TUI warning subscription deduplicates, renews and cleans up without navigation", () => {
  const require = createRequire(import.meta.url)
  const platform = process.platform === "win32" ? "windows" : process.platform
  const suffix = process.platform === "linux" && !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? "-musl" : ""
  const executable = require.resolve(`@oven/bun-${platform}-${process.arch === "arm64" ? "aarch64" : process.arch}${suffix}/bin/bun${process.platform === "win32" ? ".exe" : ""}`)
  execFileSync(executable, ["--conditions=browser", "--preload", "@opentui/solid/preload", "-e", `
    import assert from "node:assert/strict";
    import { watchWarnings } from "./src/tui.tsx";
    let listener, reconnect, removed = 0, disconnected = 0;
    const toasts = [];
    const api = {
      client: { rpc: () => ({ events: { on: (name, callback) => { assert.equal(name, "warning"); listener = callback; return () => removed++; } } }) },
      data: { on: (name, callback) => { assert.equal(name, "server.connected"); reconnect = callback; return () => disconnected++; } },
      ui: { toast: { show: value => toasts.push(value) }, router: { navigate: () => assert.fail("warnings must not navigate") } },
    };
    const event = { data: { sessionID: "ses_child", pauseID: "pause_one", message: "Fallback warning" } };
    const off = watchWarnings(api);
    listener(event); listener(event);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].sessionID, "ses_child");
    assert.equal(toasts[0].variant, "warning");
    const stale = listener;
    reconnect();
    assert.equal(removed, 1);
    listener(event);
    stale({ data: { ...event.data, pauseID: "stale" } });
    assert.equal(toasts.length, 1);
    listener({ data: { ...event.data, pauseID: "pause_two" } });
    assert.equal(toasts.length, 2);
    off(); reconnect(); listener({ data: { ...event.data, pauseID: "closed" } });
    assert.equal(toasts.length, 2);
    assert.equal(removed, 2);
    assert.equal(disconnected, 1);
  `], { cwd: process.cwd(), stdio: "pipe", timeout: 60000 })
})
