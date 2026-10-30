import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setupServer } from "../src/server.ts"
import { Autocompaction } from "../src/autocompaction.ts"
import { Storage } from "../src/storage.ts"
import { KEY } from "../src/config.ts"
import { AUTO_KEY } from "../src/auto-state.ts"
import { emptyPolicy, hash } from "../src/context.ts"
import { mockContext } from "./host-mock.ts"
import { nativeFixture, nativeSession } from "./native-fixtures.ts"
import { remoteHost } from "../src/control.ts"
import { Controller } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import type { OpenCodeClient } from "@opencode/client"

const call = { signal: new AbortController().signal, error: (...args: unknown[]) => { throw new Error(String(args[1])) } }
async function setup(t: { after(run: () => Promise<void>): void }) {
  const mock = mockContext(), dir = await mkdtemp(path.join(tmpdir(), "cm-observe-"))
  const close = await setupServer(mock.context, new Storage("/fixture", dir))
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }) })
  return { ...mock, close }
}

test("observation reads running context without initialization, gate validation or writes", async t => {
  const mock = await setup(t), { native } = nativeFixture()
  const session = mock.sessions.get("ses_native")!
  session.parentID = "ses_parent"
  session.metadata = { unrelated: { keep: true }, [AUTO_KEY]: { strategy: "AUTO_PER_TURN", pause: { id: "old", phase: "auto" } } }
  mock.messages.set(session.id, native)
  t.mock.method(Autocompaction.prototype, "state", async () => { throw new Error("Must not validate a gate") })
  t.mock.method(mock.context.session, "update", async () => { throw new Error("Must not write") })
  let finish!: () => void
  t.mock.method(mock.context.session, "wait", () => new Promise<void>(resolve => { finish = resolve }))
  const before = hash({ session, native })
  const observed = await mock.rpc.observe({ sessionID: session.id }, call)
  assert.ok("messages" in observed)
  assert.equal(observed.idle, false)
  assert.equal(observed.auto.pause, undefined)
  assert.equal(observed.messages.length, native.length)
  assert.equal(hash({ session, native }), before)
  assert.deepEqual(mock.state.created, [])
  assert.deepEqual(mock.state.interrupted, [])
  finish()
})

test("observation refuses foreign ledgers, changed snapshots, moved sessions and unload without repair", async t => {
  const mock = await setup(t), session = mock.sessions.get("ses_native")!
  session.parentID = "ses_parent"
  session.metadata = { [KEY]: emptyPolicy("ses_parent") }
  const original = hash(session.metadata)
  await assert.rejects(() => mock.rpc.observe({ sessionID: session.id }, call), /belongs/)
  assert.equal(hash(session.metadata), original)
  session.metadata = { [KEY]: emptyPolicy(session.id) }
  const context = mock.context.session.context
  t.mock.method(mock.context.session, "context", async (input: { sessionID: string }) => {
    session.metadata = { [KEY]: { ...emptyPolicy(session.id), epoch: "changed" } }
    return context(input)
  })
  await assert.rejects(() => mock.rpc.observe({ sessionID: session.id }, call), /changed/)
  session.location = { directory: "/elsewhere" }
  await assert.rejects(() => mock.rpc.observe({ sessionID: session.id }, call), /location/)
  await mock.close()
  await assert.rejects(() => mock.rpc.observe({ sessionID: session.id }, call), /unloaded/)
})

test("child browser pages direct children, excludes helpers and does not trust cursor filters", async t => {
  const mock = await setup(t)
  const child = { ...nativeSession("ses_child"), parentID: "ses_native", title: "Worker" }
  const helper = { ...nativeSession("ses_helper"), parentID: "ses_native", metadata: { context_manager_job: true } }
  const unrelated = { ...nativeSession("ses_other"), parentID: "ses_other_parent" }
  t.mock.method(mock.context.session, "list", async (input?: { parentID?: string | null; cursor?: string }) => {
    assert.equal(input?.parentID, "ses_native")
    return { data: input?.cursor ? [child] : [child, ...Array.from({ length: 48 }, () => helper), unrelated], cursor: { next: "next-page" } }
  })
  const page = await mock.rpc.children({ sessionID: "ses_native" }, call)
  assert.ok("items" in page)
  assert.deepEqual(page.items.map(item => item.id), [child.id])
  assert.equal(page.next, "next-page")
  assert.equal(page.items[0].status, "Idle")
  const last = await mock.rpc.children({ sessionID: "ses_native", cursor: page.next }, call)
  assert.ok("items" in last)
  assert.equal(last.next, undefined)
  assert.deepEqual(mock.state.created, [])
})

test("read-only remote coalesces snapshots and rejects every mutation without RPC side effects", async t => {
  const mock = await setup(t)
  mock.messages.set("ses_native", nativeFixture().native)
  const calls: string[] = []
  const client = { session: mock.context.session, rpc: () => new Proxy({}, { get: (_target, method: string) => async (input: unknown, options: { location: unknown }) => {
    calls.push(method)
    assert.deepEqual(options.location, { directory: "/fixture" })
    return (mock.rpc as unknown as Record<string, (input: unknown, call: unknown) => Promise<unknown>>)[method](input, call)
  } }) } as unknown as OpenCodeClient
  const remote = remoteHost(client, "ses_native", true)
  const controller = new Controller(remote.host, "ses_native", settings(), remote.artifacts)
  const loaded = await controller.load()
  assert.deepEqual(calls, ["observe"])
  assert.equal(loaded.idle, true)
  for (const run of [
    () => controller.pruneRanges([loaded.blocks[0].sourceIDs]),
    () => controller.restoreRanges([loaded.blocks[0].sourceIDs]),
    () => controller.summarize("brief", loaded.blocks[0].sourceIDs),
    () => remote.host.createJob(),
    () => remote.host.messages("ses_job"),
    () => remote.host.progress!("ses_job"),
    () => remote.host.generate("ses_job", { providerID: "fixture", modelID: "model" }, "Do not send"),
    () => remote.host.update("ses_native", {}, { revision: 0, fingerprint: "unchanged" }),
    () => remote.host.auto!.command("ses_native", { action: "abort", pauseID: "unused" }),
    () => remote.artifacts.write("unused", {}),
  ]) await assert.rejects(async () => run(), /read-only/)
  await controller.dispose()
  await remote.close()
  assert.deepEqual(calls, ["observe"])
  assert.deepEqual(mock.state.created, [])
  assert.deepEqual(mock.state.interrupted, [])
})
