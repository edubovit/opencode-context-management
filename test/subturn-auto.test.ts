import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Autocompaction } from "../src/autocompaction.ts"
import { AUTO_KEY, type AutoWarning, type Strategy } from "../src/auto-state.ts"
import { settings, KEY } from "../src/config.ts"
import { Controller } from "../src/controller.ts"
import { activeMessages, append, blockMessages, emptyPolicy, historyHash, operation, project, readPolicy, splitOperation } from "../src/context.ts"
import { contentTokens } from "../src/metrics.ts"
import { Storage } from "../src/storage.ts"
import { FALLBACK_BASIS } from "../src/tokens.ts"
import { fixtureHost } from "./fixtures.ts"
import { setupServer } from "../src/server.ts"
import { transcriptView } from "../src/normalize.ts"
import { rememberPolicy } from "../src/revert.ts"
import { mockContext } from "./host-mock.ts"
import { nativeFixture, nativeSession } from "./native-fixtures.ts"

async function fixture(t: { after(run: () => Promise<void>): void }, strategy: Strategy = "AUTO_PER_TURN") {
  const directory = await mkdtemp(path.join(tmpdir(), "cm-subturn-auto-"))
  const value = fixtureHost()
  value.data.idle = false
  value.data.session.metadata![AUTO_KEY] = { strategy }
  value.data.messages = [value.data.messages[0], ...value.data.messages.filter(message => message.info.role === "assistant")]
  const config = settings({ subturns: { minTokens: 100, minSplitTokens: 200 }, autocompaction: { headroom: 160000, splitThresholdTokens: 7000, maxSubturnTokens: 7000, minRangeTokens: 0 } })
  const warnings: AutoWarning[] = []
  const store = new Storage(directory, directory)
  const auto = new Autocompaction(value.host, config, store, warning => { warnings.push(warning) })
  const maintenance = new Controller({ ...value.host, auto, idle: async () => value.data.idle || auto.observe(value.data.session).pause?.phase === "manual", update: (id, metadata, expected) => auto.commit(id, metadata, expected!) }, value.data.session.id, config, store)
  t.after(async () => { auto.close(); await maintenance.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { ...value, auto, config, store, warnings, maintenance }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail("Subturn automatic condition did not settle")
}

test("AUTO splits active history once, summarizes continuations and releases the original request once", async t => {
  const { auto, data, warnings, host } = await fixture(t)
  const original = structuredClone(data.messages)
  const fingerprint = historyHash(original)
  let resumed = 0
  const estimates: number[] = []
  const generate = host.generate
  host.generate = async (...args) => {
    const state = auto.observe(data.session)
    assert.deepEqual(state.pause?.protectedIDs, [original.at(-1)!.info.id])
    assert.equal(readPolicy(data.session).operations.filter(op => op.mode === "partition").length, 1)
    return generate(...args)
  }
  await auto.beforeRequest(data.messages, { model: { providerID: data.model.providerID, modelID: data.model.id }, protectedIDs: original.map(message => message.info.id), estimate: policy => {
    const tokens = contentTokens(blockMessages(project(data.messages, policy)), FALLBACK_BASIS)
    estimates.push(tokens)
    return tokens
  } }).then(() => { resumed++ })
  const policy = readPolicy(data.session)
  assert.equal(policy.operations[0].mode, "partition")
  assert.equal(policy.operations.filter(op => op.mode === "partition").length, 1)
  assert.equal(policy.operations.filter(op => op.mode === "compact").length, 2)
  assert.ok(policy.operations.slice(1).every(op => !op.sourceIDs.includes(original.at(-1)!.info.id)))
  assert.equal(estimates[0], estimates[1])
  assert.equal(resumed, 1)
  assert.equal(historyHash(data.messages), fingerprint)
  assert.deepEqual(data.messages, original)
  assert.equal(auto.observe(data.session).pause, undefined)
  assert.deepEqual(warnings, [])
})

test("an oversized member of the next qualifying range splits before small-prefix grouping", async t => {
  const { host, store, data } = await fixture(t)
  const small = structuredClone(data.messages[0])
  small.info.id = "msg_small_user"
  small.parts = small.parts.map(part => ({ ...part, messageID: small.info.id }))
  data.messages.unshift(small)
  const active = structuredClone(small)
  active.info.id = "msg_new_active"
  active.parts = active.parts.map(part => ({ ...part, messageID: active.info.id }))
  data.messages.push(active)
  const sized = new Autocompaction(host, settings({ subturns: { minTokens: 100, minSplitTokens: 200 }, autocompaction: { headroom: 160000, splitThresholdTokens: 7000, maxSubturnTokens: 7000, minRangeTokens: 1000 } }), store, () => {})
  t.after(async () => { sized.close() })
  await sized.beforeRequest(data.messages)
  const policy = readPolicy(data.session)
  assert.equal(policy.operations[0].mode, "partition")
  assert.equal(policy.operations[1].mode, "compact")
  assert.ok(policy.operations[1].sourceIDs.includes(small.info.id))
  assert.ok(!policy.operations[1].sourceIDs.includes(data.messages.at(-2)!.info.id))
})

test("a sufficient earlier eligible range is summarized before splitting the active turn", async t => {
  const { auto, data } = await fixture(t)
  const earlier = fixtureHost().data.messages.slice(0, 2)
  earlier.forEach(message => { message.info.id += "_earlier"; message.parts = message.parts.map(part => ({ ...part, messageID: message.info.id })) })
  data.messages.unshift(...earlier)
  await auto.beforeRequest(data.messages)
  const policy = readPolicy(data.session)
  assert.equal(policy.operations[0].mode, "compact")
  assert.equal(policy.operations[1].mode, "partition")
})

test("manual split/merge remaps protection without changing raw history or permitting protected edits", async t => {
  const { auto, data, maintenance } = await fixture(t, "MANUAL")
  const original = structuredClone(data.messages)
  const waiting = auto.beforeRequest(data.messages).catch(error => error)
  await until(() => !!auto.observe(data.session).pause)
  let loaded = await maintenance.load()
  assert.equal(await maintenance.splitTurn(loaded.blocks[0].sourceIDs, 3), 3)
  const pause = auto.observe(data.session).pause!
  assert.deepEqual(pause.protectedIDs, [original.at(-1)!.info.id])
  assert.equal(pause.tokens, contentTokens(original, FALLBACK_BASIS))
  loaded = await maintenance.load()
  await assert.rejects(maintenance.deleteRanges([loaded.blocks.at(-1)!.sourceIDs]), /protected/)
  const forged = append(loaded.policy, operation("delete", [loaded.blocks.at(-1)!]))
  await assert.rejects(auto.commit(data.session.id, { [KEY]: forged }, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }), /protected/)
  await maintenance.mergeSubturns(loaded.blocks.flatMap(block => block.sourceIDs))
  assert.deepEqual(auto.observe(data.session).pause!.protectedIDs, original.map(message => message.info.id))
  assert.deepEqual(data.messages, original)
  await assert.rejects(auto.command(data.session.id, { action: "resume", pauseID: pause.id }), /Resume blocked/)
  auto.cancel(data.session.id)
  assert.ok(await waiting instanceof Error)
})

test("split does not weaken other steered input groups and observation stays passive", async t => {
  const { auto, data, maintenance, config } = await fixture(t, "MANUAL")
  const earlier = fixtureHost().data.messages.slice(0, 2)
  earlier.forEach(message => { message.info.id += "_steered"; message.parts = message.parts.map(part => ({ ...part, messageID: message.info.id })) })
  data.messages.unshift(...earlier)
  const waiting = auto.beforeRequest(data.messages, { model: { providerID: data.model.providerID, modelID: data.model.id }, protectedIDs: data.messages.map(message => message.info.id), estimate: policy => contentTokens(blockMessages(project(data.messages, policy))) }).catch(error => error)
  await until(() => !!auto.observe(data.session).pause)
  const loaded = await maintenance.load()
  const split = splitOperation(loaded.blocks[1], 3, loaded.tokenizer, config.subturns)
  await auto.commit(data.session.id, { [KEY]: append(loaded.policy, split.operation) }, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint })
  assert.deepEqual(auto.observe(data.session).pause!.protectedIDs, [...earlier.map(message => message.info.id), data.messages.at(-1)!.info.id])
  const metadata = JSON.stringify(data.session.metadata)
  const observed = auto.observe(data.session)
  observed.pause!.protectedIDs!.length = 0
  const state = await auto.state(data.session.id)
  state.pause!.protectedIDs!.length = 0
  assert.equal(JSON.stringify(data.session.metadata), metadata)
  assert.equal(auto.observe(data.session).pause!.protectedIDs!.length, 3)
  await assert.rejects(maintenance.deleteRanges([earlier.map(message => message.info.id)]), /protected/)
  data.messages[0].parts = []
  await assert.rejects(auto.command(data.session.id, { action: "resume", pauseID: observed.pause!.id }), /source changed/)
  auto.cancel(data.session.id)
  assert.ok(await waiting instanceof Error)
})

test("ordinary AUTO gate rejects external structural writes and source drift after splitting", async t => {
  const { auto, host, data, maintenance, config } = await fixture(t)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const generate = host.generate
  host.generate = async (...args) => { await barrier; return generate(...args) }
  const waiting = auto.beforeRequest(data.messages).catch(error => error)
  await until(() => data.jobs === 1)
  const loaded = await maintenance.load()
  const split = splitOperation(project(data.messages, { ...loaded.policy, revision: 0, operations: [] })[0], 2, loaded.tokenizer, config.subturns)
  await assert.rejects(auto.commit(data.session.id, { [KEY]: append(loaded.policy, split.operation) }, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }), /not available for manual changes/)
  data.messages.at(-1)!.parts = []
  release()
  const error = await waiting
  assert.ok(error instanceof Error)
  assert.match(error.message, /source changed|session or model configuration changed/)
  assert.equal(readPolicy(data.session).operations.length, 1)
})

test("boundary scarcity reduces the count; max is soft and oversized siblings are not split repeatedly", async t => {
  const { auto, data, warnings } = await fixture(t)
  const first = data.messages[1].parts.find(part => part.type === "tool")!
  assert.ok(first.type === "tool" && first.state.status === "completed")
  first.state.output = "very large output ".repeat(9000)
  data.messages.splice(2, 1)
  await auto.beforeRequest(data.messages)
  const policy = readPolicy(data.session)
  assert.equal(policy.operations.filter(op => op.mode === "partition").length, 1)
  assert.equal(policy.operations[0].cuts?.length, 1)
  const parts = project(data.messages, { ...policy, revision: 1, operations: policy.operations.slice(0, 1) })
  assert.ok(contentTokens(parts[0].messages) > 7000)
  assert.equal(policy.operations[1].mode, "compact")
  assert.deepEqual(warnings, [])
})

test("nonreducing subturn attempts never overlap or re-split sources and do not count structural writes as savings", async t => {
  const { auto, data, warnings } = await fixture(t)
  data.responses = Array(6).fill("padding ".repeat(30000))
  await assert.rejects(auto.beforeRequest(data.messages), /no eligible prefix/)
  const policy = readPolicy(data.session)
  assert.equal(policy.operations.length, 1)
  assert.equal(policy.operations[0].mode, "partition")
  assert.equal(data.jobs, 3)
  assert.equal(data.calls.length, 6)
  assert.equal(warnings.length, 1)
})

test("new gates protect the final existing subturn, not an earlier summarized sibling", async t => {
  const { auto, data, config } = await fixture(t, "MANUAL")
  let policy = readPolicy(data.session)
  const split = splitOperation(project(data.messages, policy)[0], 3, FALLBACK_BASIS, config.subturns)
  policy = append(policy, split.operation)
  const blocks = project(data.messages, policy)
  policy = append(policy, { ...operation("compact", [blocks[0]]), summary: "Earlier work" })
  data.session.metadata![KEY] = policy
  const waiting = auto.beforeRequest(data.messages).catch(error => error)
  await until(() => !!auto.observe(data.session).pause)
  assert.deepEqual(auto.observe(data.session).pause!.protectedIDs, [data.messages.at(-1)!.info.id])
  auto.cancel(data.session.id)
  assert.ok(await waiting instanceof Error)
})

test("idle structural writes validate safe plans and cannot rewrite boundaries or provenance", async t => {
  const { auto, data, maintenance, config } = await fixture(t)
  data.idle = true
  const loaded = await maintenance.load()
  const split = splitOperation(loaded.blocks[0], 3, loaded.tokenizer, config.subturns)
  const next = append(loaded.policy, split.operation)
  const expected = { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }
  for (const changed of [{ turnEnds: [data.messages[1].info.id] }, { epoch: "forged" }, { sources: [{ id: data.messages[0].info.id, hash: "0".repeat(64), user: true, created: 0 }] }])
    await assert.rejects(auto.commit(data.session.id, { [KEY]: { ...next, ...changed } }, expected), /boundaries|provenance/)
  const invalid = { ...split.operation, cuts: [data.messages[0].info.id] }
  await assert.rejects(auto.commit(data.session.id, { [KEY]: append(loaded.policy, invalid) }, expected), /tool batch|boundar/)
  await auto.commit(data.session.id, { [KEY]: next }, expected)
  assert.equal(readPolicy(data.session).revision, 1)
  assert.equal(historyHash(data.messages), loaded.fingerprint)
})

test("authoritative structural validation enforces minimum sizes and rechecks source drift", async t => {
  const { auto, host, data, maintenance } = await fixture(t)
  data.idle = true
  const last = data.messages.at(-1)!
  last.parts = [{ type: "text", id: "prt_tiny_tail", messageID: last.info.id, sessionID: data.session.id, text: "tiny" }]
  const loaded = await maintenance.load()
  const expected = { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }
  const op = { ...operation("partition", loaded.blocks), cuts: [data.messages.at(-2)!.info.id] }
  await assert.rejects(auto.commit(data.session.id, { [KEY]: append(loaded.policy, op) }, expected), /safe subturn plan/)
  const partitioned = append(loaded.policy, op)
  const mixed = append(partitioned, operation("delete", [project(data.messages, partitioned)[0]]))
  await assert.rejects(auto.commit(data.session.id, { [KEY]: mixed }, expected), /cannot be combined/)
  const valid = { ...op, cuts: [data.messages[1].info.id] }
  const messages = host.messages
  let reads = 0
  host.messages = async id => {
    if (id === data.session.id && ++reads === 2) data.messages[0].parts = []
    return messages(id)
  }
  await assert.rejects(auto.commit(data.session.id, { [KEY]: append(loaded.policy, valid) }, expected), /changed before structural/)
  assert.equal(readPolicy(data.session).operations.length, 0)
})

for (const change of ["Stop", "move", "unload", "host idle", "source mutation", "native revert", "model configuration"] as const)
  test(`structural revalidation rejects ${change} before writing any partition`, async t => {
    const { auto, host, data, maintenance, config } = await fixture(t, "MANUAL")
    let valid = true
    const waiting = auto.beforeRequest(data.messages, {
      model: { providerID: data.model.providerID, modelID: data.model.id },
      protectedIDs: data.messages.map(message => message.info.id),
      estimate: policy => contentTokens(blockMessages(project(data.messages, policy))),
      valid: async () => valid,
    }).catch(error => error)
    await until(() => !!auto.observe(data.session).pause)
    const loaded = await maintenance.load()
    const split = splitOperation(loaded.blocks[0], 3, loaded.tokenizer, config.subturns)
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    let entered = false
    const models = host.models
    host.models = async () => { entered = true; await barrier; return models() }
    let writes = 0
    const update = host.update
    host.update = async (id, metadata, expected) => {
      if (readPolicy({ id, metadata }).revision !== loaded.policy.revision) writes++
      return update(id, metadata, expected)
    }
    const pending = auto.commit(data.session.id, { [KEY]: append(loaded.policy, split.operation) }, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint })
      .then(() => undefined, error => error)
    try {
      await until(() => entered)
      if (change === "Stop") auto.cancel(data.session.id)
      else if (change === "move") {
        auto.cancel(data.session.id)
        host.session = async () => { throw new Error("Session location changed") }
      } else if (change === "unload") auto.close()
      else if (change === "host idle") data.idle = true
      else if (change === "source mutation") data.messages[0].parts = []
      else if (change === "native revert") data.session.revert = { messageID: data.messages.at(-1)!.info.id }
      else valid = false
      release()
      assert.ok(await pending instanceof Error, "the structural write must reject stale authority")
      assert.equal(writes, 0, "no stale policy may reach host.update")
      assert.equal(readPolicy(data.session).revision, loaded.policy.revision)
      assert.deepEqual(readPolicy(data.session).operations, loaded.policy.operations)
    } finally {
      release()
      auto.cancel(data.session.id)
      await pending
      await waiting
    }
  })

test("AUTO Stop during structural revalidation cannot persist a late partition", async t => {
  const { auto, host, data } = await fixture(t)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let reads = 0, entered = false, writes = 0
  const models = host.models
  host.models = async () => {
    if (++reads === 3) { entered = true; await barrier }
    return models()
  }
  const update = host.update
  host.update = async (id, metadata, expected) => {
    if (readPolicy({ id, metadata }).revision) writes++
    return update(id, metadata, expected)
  }
  const waiting = auto.beforeRequest(data.messages).catch(error => error)
  try {
    await until(() => entered)
    auto.cancel(data.session.id)
    release()
    assert.ok(await waiting instanceof Error)
    assert.equal(writes, 0, "cancelled AUTO must not write a structural operation")
    assert.equal(readPolicy(data.session).revision, 0)
    assert.equal(data.jobs, 0)
  } finally { release(); auto.cancel(data.session.id); await waiting }
})

test("idle structural revalidation cannot write after its owner unloads", async t => {
  const { auto, host, data, maintenance, config } = await fixture(t)
  data.idle = true
  const loaded = await maintenance.load()
  const split = splitOperation(loaded.blocks[0], 3, loaded.tokenizer, config.subturns)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let entered = false, writes = 0
  const models = host.models
  host.models = async () => { entered = true; await barrier; return models() }
  const update = host.update
  host.update = async (...args) => { writes++; return update(...args) }
  const pending = auto.commit(data.session.id, { [KEY]: append(loaded.policy, split.operation) }, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint })
    .then(() => undefined, error => error)
  try {
    await until(() => entered)
    auto.close()
    release()
    assert.ok(await pending instanceof Error)
    assert.equal(writes, 0)
    assert.equal(readPolicy(data.session).revision, 0)
  } finally { release(); await pending }
})

const rpcCall = { signal: new AbortController().signal, error: (...args: unknown[]) => { throw new Error(String(args[1])) } }

test("RPC maintenance cannot forge native-valid subturn lineage provenance", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "cm-subturn-origin-rpc-"))
  const mock = mockContext()
  const { native } = nativeFixture()
  mock.messages.set("ses_native", native)
  const close = await setupServer(mock.context, new Storage(directory, directory))
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }) })
  const inspected = await mock.rpc.inspect({ sessionID: "ses_native" }, rpcCall)
  assert.ok("messages" in inspected)
  const before = readPolicy(inspected.session)
  const blocks = project(activeMessages(inspected.messages), before)
  const policy = { ...append(before, operation("prune-reason", [blocks[0]])), subturnOrigins: [blocks[0].sourceIDs[0]] }
  assert.doesNotThrow(() => project(activeMessages(inspected.messages), policy))
  await assert.rejects(mock.rpc.commit({ sessionID: "ses_native", policy, expected: { revision: before.revision, fingerprint: historyHash(inspected.messages) } }, rpcCall), /Subturn provenance/)
  assert.deepEqual(readPolicy(mock.sessions.get("ses_native")!), before)
})

for (const initializer of ["fork", "revert"] as const) test(`RPC maintenance preserves ${initializer}-initialized lineage and rejects removal or replacement`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "cm-subturn-origin-owner-"))
  const mock = mockContext()
  const source = mock.sessions.get("ses_native")!
  const native = nativeFixture().native.filter(message => message.type === "assistant" || message.id === "msg_u0")
  const raw = activeMessages(transcriptView(source, native))
  const empty = emptyPolicy(source.id)
  const original = rememberPolicy(raw, append(empty, splitOperation(project(raw, empty)[0], 3, FALLBACK_BASIS, { minTokens: 1, minSplitTokens: 2 }).operation))
  source.metadata = { ...source.metadata, [KEY]: original }
  mock.messages.set(source.id, initializer === "revert" ? native.slice(0, -1) : native)
  let sessionID = source.id
  if (initializer === "fork") {
    const target = { ...nativeSession("ses_origin_fork"), metadata: structuredClone(source.metadata), fork: { sessionID: source.id, boundary: { type: "through" as const, messageID: native.at(-1)!.id } } }
    sessionID = target.id
    mock.sessions.set(target.id, target)
    mock.messages.set(target.id, native.map((message, index) => ({ ...structuredClone(message), id: `msg_copied_${index}` })))
  }
  const close = await setupServer(mock.context, new Storage(directory, directory))
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }) })
  const inspected = await mock.rpc.inspect({ sessionID }, rpcCall)
  assert.ok("messages" in inspected)
  const before = readPolicy(inspected.session)
  assert.deepEqual(before.subturnOrigins, [inspected.messages[0].info.id])
  const blocks = project(activeMessages(inspected.messages), before)
  const policy = append(before, operation("prune-reason", [blocks[0]]))
  const expected = { revision: before.revision, fingerprint: historyHash(inspected.messages) }
  const { subturnOrigins: _origins, ...removed } = policy
  for (const forged of [removed, { ...policy, subturnOrigins: ["msg_foreign_origin"] }])
    await assert.rejects(mock.rpc.commit({ sessionID, policy: forged, expected }, rpcCall), /Subturn provenance/)
  assert.deepEqual(readPolicy(mock.sessions.get(sessionID)!), before)
  await mock.rpc.commit({ sessionID, policy, expected }, rpcCall)
  const saved = readPolicy(mock.sessions.get(sessionID)!)
  assert.deepEqual(saved.subturnOrigins, before.subturnOrigins)
  assert.equal(saved.revision, before.revision + 1)
})
