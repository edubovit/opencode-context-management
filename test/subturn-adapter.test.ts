import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OpenCodeClient } from "@opencode/client"
import { Autocompaction } from "../src/autocompaction.ts"
import { AUTO_KEY } from "../src/auto-state.ts"
import { Controller } from "../src/controller.ts"
import { settings, KEY } from "../src/config.ts"
import { activeMessages, append, emptyPolicy, historyHash, operation, project, readPolicy, splitOperation } from "../src/context.ts"
import { pluginHost } from "../src/host.ts"
import { remoteHost } from "../src/control.ts"
import { Storage } from "../src/storage.ts"
import { mockContext } from "./host-mock.ts"
import { nativeFixture } from "./native-fixtures.ts"

async function fixture(t: { after(run: () => Promise<void>): void }, fold = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "cm-subturn-adapter-"))
  const mock = mockContext()
  const native = nativeFixture().native.filter(message => !fold || message.type === "assistant" || message.id === "msg_u0")
  mock.messages.set("ses_native", native)
  const adapter = pluginHost(mock.context)
  const store = new Storage(directory, directory)
  const config = settings({ subturns: { minTokens: 100, minSplitTokens: 200 }, autocompaction: { headroom: 167900 } })
  let writes = 0
  const update = mock.context.session.update
  mock.context.session.update = async input => {
    if (input.metadata?.[KEY] && readPolicy({ id: input.sessionID, metadata: input.metadata }).revision) writes++
    return update(input)
  }
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }) })
  return { ...mock, adapter, store, config, writes: () => writes }
}

function duringFinalContext(f: Awaited<ReturnType<typeof fixture>>, action: () => void | Promise<void>) {
  let armed = false, fired = false
  const update = f.adapter.host.update
  f.adapter.host.update = async (...args) => {
    armed = !!args[1][KEY] && readPolicy({ id: args[0], metadata: args[1] }).revision > 0
    try { return await update(...args) } finally { armed = false }
  }
  const context = f.context.session.context
  f.context.session.context = async input => {
    if (armed && !fired) { fired = true; await action() }
    return context(input)
  }
  return () => fired
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail("Adapter condition did not settle")
}

for (const structural of [true, false]) for (const revoke of ["Stop", "AUTO unload", "adapter unload"] as const)
  test(`real adapter rejects ${revoke} inside its final read before ${structural ? "partition" : "content"} persistence`, async t => {
    const f = await fixture(t, structural)
    const session = f.sessions.get("ses_native")!
    session.metadata![AUTO_KEY] = { strategy: "MANUAL" }
    f.context.session.wait = async () => new Promise<void>(() => {})
    const auto = new Autocompaction(f.adapter.host, f.config, f.store, () => {})
    const raw = await f.adapter.host.messages(session.id)
    const waiting = auto.beforeRequest(raw).catch(error => error)
    await until(() => !!auto.observe(session).pause)
    const controller = new Controller(f.adapter.host, session.id, f.config, f.store)
    const loaded = await controller.load()
    const op = structural ? splitOperation(loaded.blocks[0], 3, loaded.tokenizer, f.config.subturns).operation : operation("prune-reason", [loaded.blocks[0]])
    const fired = duringFinalContext(f, () => revoke === "adapter unload" ? f.adapter.close() : revoke === "AUTO unload" ? auto.close() : auto.cancel(session.id))
    try {
      const result = await auto.commit(session.id, { [KEY]: append(loaded.policy, op) }, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }).then(() => undefined, error => error)
      assert.equal(fired(), true)
      assert.equal(f.writes(), 0, "revoked authority must not reach the native metadata writer")
      assert.equal(readPolicy(session).revision, 0)
      assert.ok(result instanceof Error)
    } finally { auto.close(); await waiting; await controller.dispose() }
  })

for (const structural of [true, false]) for (const revoke of ["cancel", "dispose", "caller guard"] as const)
  test(`controller ${revoke} inside real adapter final read prevents ${structural ? "partition" : "content"} writes`, async t => {
    const f = await fixture(t, structural)
    const controller = new Controller(f.adapter.host, "ses_native", f.config, f.store)
    const loaded = await controller.load()
    const op = structural ? splitOperation(loaded.blocks[0], 3, loaded.tokenizer, f.config.subturns).operation : operation("prune-reason", [loaded.blocks[0]])
    let valid = true
    const fired = duringFinalContext(f, () => revoke === "cancel" ? controller.cancel() : revoke === "dispose" ? controller.dispose() : void (valid = false))
    try {
      const result = await controller.applyOperations([op], { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }, () => { if (!valid) throw new Error("Caller no longer owns this operation") })
        .then(() => undefined, error => error)
      assert.equal(fired(), true)
      assert.equal(f.writes(), 0, "revoked controller must not reach the native metadata writer")
      assert.equal(readPolicy(f.sessions.get("ses_native")!).revision, 0)
      assert.ok(result instanceof Error)
    } finally { await controller.dispose() }
  })

for (const change of ["unselected history", "policy", "native revert", "location"] as const)
  test(`real adapter validates ${change} after its awaited read before native persistence`, async t => {
    const f = await fixture(t)
    const session = f.sessions.get("ses_native")!
    const controller = new Controller(f.adapter.host, session.id, f.config, f.store)
    const loaded = await controller.load()
    const op = operation("prune-reason", [loaded.blocks[0]])
    const foreign = append(emptyPolicy(session.id), operation("prune-reason", [loaded.blocks[1]]))
    const fired = duringFinalContext(f, () => {
      if (change === "unselected history") {
        const last = f.messages.get(session.id)!.findLast(message => message.type === "user")!
        assert.equal(last.type, "user")
        last.text += " changed outside the selected range"
      } else if (change === "policy") session.metadata![KEY] = foreign
      else if (change === "native revert") session.revert = { messageID: "msg_u2" }
      else session.location = { directory: "/moved" }
    })
    try {
      const result = await controller.applyOperations([op], { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }).then(() => undefined, error => error)
      assert.equal(fired(), true)
      assert.equal(f.writes(), 0, "stale snapshot must not reach the native metadata writer")
      assert.deepEqual(readPolicy(session), change === "policy" ? foreign : loaded.policy)
      assert.ok(result instanceof Error)
    } finally { await controller.dispose() }
  })

test("real adapter preserves latest unrelated metadata and optional unchecked initialization", async t => {
  const f = await fixture(t)
  const session = f.sessions.get("ses_native")!
  session.metadata!.obsolete = "must stay removed"
  const raw = await f.adapter.host.messages(session.id)
  const policy = append(readPolicy(session), operation("prune-reason", [project(activeMessages(raw), readPolicy(session))[0]]))
  const stale = structuredClone(session.metadata!)
  const fired = duringFinalContext(f, () => { session.metadata!.unrelated = "latest"; delete session.metadata!.obsolete })
  await f.adapter.host.update(session.id, { ...stale, [KEY]: policy })
  assert.equal(fired(), true)
  assert.equal(session.metadata!.unrelated, "latest")
  assert.equal(session.metadata!.obsolete, undefined)
  assert.equal(readPolicy(session).revision, 1)
  assert.equal(historyHash(await f.adapter.host.messages(session.id)), historyHash(raw))
})

test("remote adapter rechecks local authority after location lookup without sending callback fields", async () => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let entered = false, valid = true
  const requests: unknown[] = []
  const client = {
    session: { get: async () => { entered = true; await barrier; return { location: { directory: "/fixture" } } } },
    rpc: () => ({ commit: async (input: unknown) => { requests.push(input); return null } }),
  } as unknown as OpenCodeClient
  const remote = remoteHost(client, "ses_native")
  const policy = emptyPolicy("ses_native")
  const expected = { revision: 0, fingerprint: "fixture" }
  const authorize = () => { if (!valid) throw new Error("Caller cancelled") }
  const pending = remote.host.update("ses_native", { [KEY]: policy }, expected, authorize).then(() => undefined, error => error)
  await until(() => entered)
  valid = false
  release()
  assert.ok(await pending instanceof Error)
  assert.deepEqual(requests, [])
  valid = true
  await remote.host.update("ses_native", { [KEY]: policy }, expected, authorize)
  assert.deepEqual(requests, [{ sessionID: "ses_native", policy, expected }])
  await remote.close()
  await assert.rejects(remote.host.update("ses_native", { [KEY]: policy }, expected, authorize), /closed/)
  assert.equal(requests.length, 1)
})
