import { test } from "node:test"
import assert from "node:assert/strict"
import { activeMessages, append, emptyPolicy, hash, operation, project, readPolicy, splitAfter, type Policy } from "../src/context.ts"
import { rememberPolicy, revertPolicy } from "../src/revert.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest } from "../src/projection.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { KEY } from "../src/config.ts"
import { pluginHost } from "../src/host.ts"
import { mockContext } from "./host-mock.ts"

function fixture() {
  const data = nativeFixture()
  const raw = transcriptView(data.session, data.native)
  let policy = emptyPolicy(data.session.id)
  const blocks = () => project(activeMessages(raw), policy)
  const save = (op: Policy["operations"][number]) => { policy = rememberPolicy(raw, append(policy, op)) }
  return { ...data, raw, blocks, save, get policy() { return policy } }
}

test("revert opens a crossing summary without changing the saved redo state; committed replay matches the staged prefix", () => {
  const f = fixture()
  f.save({ ...operation("compact", f.blocks()), summary: "LATER_FACTS" })
  const saved = hash(f.policy)
  const prefix = f.raw.slice(0, f.raw.findIndex((message) => message.info.id === "msg_u2"))
  const staged = revertPolicy(f.raw, f.policy, "msg_u2")
  const committed = revertPolicy(prefix, f.policy)
  assert.deepEqual(committed, staged)
  assert.equal(hash(f.policy), saved)
  assert.deepEqual(project(activeMessages(prefix), staged).map((block) => block.kind), ["turn", "turn"])
  assert.doesNotMatch(JSON.stringify(staged), /LATER_FACTS/)
  assert.equal(f.blocks()[0].kind, "compact")
  assert.deepEqual(revertPolicy(f.raw, f.policy), f.policy)
})

test("nested revised summaries and pruning retain only complete earlier layers and remain independently restorable", () => {
  const f = fixture()
  f.save({ ...operation("tool-prune-all", f.blocks()), pruneReason: true })
  f.save({ ...operation("brief", [f.blocks()[0]]), summary: "INNER" })
  f.save({ ...operation("revise", [f.blocks()[0]]), targetID: f.blocks()[0].summaryID, summary: "REVISED_INNER" })
  f.save({ ...operation("compact", f.blocks()), summary: "OUTER_FUTURE" })
  const native = f.native.slice(0, f.native.findIndex((message) => message.id === "msg_u2"))
  const raw = transcriptView(f.session, native)
  let policy = revertPolicy(raw, f.policy)
  let blocks = project(activeMessages(raw), policy)
  assert.deepEqual(blocks.map((block) => block.kind), ["brief", "turn"])
  assert.match(JSON.stringify(blocks[0].messages), /REVISED_INNER/)
  assert.equal(blocks[1].allToolsPruned, true)
  assert.doesNotMatch(JSON.stringify(blocks), /OUTER_FUTURE|QUESTION_2/)
  policy = append(policy, operation("expand", blocks))
  blocks = project(activeMessages(raw), policy)
  assert.equal(blocks[0].allToolsPruned, true)
  assert.equal(blocks[1].allToolsPruned, undefined)
  policy = append(policy, operation("expand", [blocks[0]]))
  const incoming = f.canonical.slice(0, f.canonical.findIndex((message) => message.id === "msg_u2"))
  assert.deepEqual(projectRequest(native, raw, incoming, policy), incoming)
})

for (const mode of ["brief", "delete", "tool-prune-all"] as const) test(`already restored ${mode} does not leave stale replay references after revert`, () => {
  const f = fixture()
  f.save({ ...operation(mode, f.blocks()), ...(mode === "brief" ? { summary: "OLD" } : {}) })
  f.save(operation("expand", f.blocks()))
  const prefix = f.raw.slice(0, f.raw.findIndex((message) => message.info.id === "msg_u1"))
  const policy = revertPolicy(prefix, f.policy)
  assert.equal(policy.operations.length, 0)
  assert.deepEqual(project(activeMessages(prefix), policy).flatMap((block) => block.messages), activeMessages(prefix))
})

test("retained-prefix identity rejects payload drift, interior holes and missing legacy provenance", () => {
  const f = fixture()
  f.save({ ...operation("brief", f.blocks()), summary: "ALL" })
  const prefix = f.raw.slice(0, f.raw.findIndex((message) => message.info.id === "msg_u2"))
  const changed = structuredClone(prefix)
  changed[0].parts[0] = { ...changed[0].parts[0], type: "text", text: "CHANGED" }
  assert.throws(() => revertPolicy(changed, f.policy), /changed|prefix/i)
  assert.throws(() => revertPolicy(f.raw.filter((message) => message.info.id !== "msg_a0"), f.policy), /prefix|missing/i)
  const { sources: _sources, ...legacy } = f.policy
  assert.throws(() => revertPolicy(prefix, legacy), /provenance|original|range/i)
  assert.deepEqual(revertPolicy(f.raw, legacy), legacy)
  const remembered = rememberPolicy(f.raw, legacy)
  assert.deepEqual(remembered.operations, legacy.operations)
  assert.doesNotMatch(JSON.stringify(remembered.sources), /QUESTION_|HEAD_|REASON_/)
})

test("revert reconciles saved fork boundaries and preserves new input after a complete or partial cutoff", () => {
  const f = fixture()
  const original = rememberPolicy(f.raw, { ...f.policy, turnEnds: f.blocks().map((block) => block.sourceIDs.at(-1)!) })
  const prefix = f.raw.slice(0, f.raw.findIndex((message) => message.info.id === "msg_u1"))
  const newInput = structuredClone(f.raw.find((message) => message.info.id === "msg_u2")!)
  newInput.info.id = "msg_new"
  newInput.info.time.created = 1000
  newInput.parts = []
  const policy = revertPolicy([...prefix, newInput], original)
  assert.ok(policy.turnEnds?.every((id) => prefix.some((message) => message.info.id === id)))
  assert.equal(project(activeMessages([...prefix, newInput]), policy).length, 2)
  assert.equal(project([newInput], revertPolicy([newInput], original)).length, 1)
})

test("host reconciles committed reverts once, preserves unrelated metadata and survives adapter restart", async () => {
  const f = fixture()
  f.save({ ...operation("compact", f.blocks()), summary: "CROSSES" })
  const mock = mockContext()
  const session = { ...f.session, metadata: { unrelated: "KEEP", [KEY]: f.policy } }
  mock.sessions.set(session.id, session)
  mock.messages.set(session.id, f.native.slice(0, f.native.findIndex((message) => message.id === "msg_u2")))
  let writes = 0
  const update = mock.context.session.update
  mock.context.session.update = async (...args) => { writes++; await update(...args) }
  const adapter = pluginHost(mock.context)
  const [first, second] = await Promise.all([adapter.nativeSession(session.id), adapter.nativeSession(session.id)])
  assert.equal(writes, 1)
  assert.deepEqual(first, second)
  assert.equal(first.metadata?.unrelated, "KEEP")
  assert.equal(readPolicy(first).operations.length, 0)
  await adapter.close()
  const restarted = pluginHost(mock.context)
  assert.deepEqual(readPolicy(await restarted.nativeSession(session.id)), readPolicy(first))
  assert.equal(writes, 1)
  await restarted.close()
})

test("host backfills timestamp-less format-13 sources without changing reductions or unrelated metadata", async () => {
  const f = fixture()
  f.save({ ...operation("brief", f.blocks()), summary: "KEEP_SUMMARY" })
  const legacy = { ...f.policy, sources: f.policy.sources!.map(({ created: _created, ...source }) => source) }
  const metadata = { unrelated: "KEEP", [KEY]: legacy }
  const before = structuredClone(metadata)
  const mock = mockContext()
  mock.sessions.set(f.session.id, { ...f.session, metadata })
  mock.messages.set(f.session.id, f.native)
  let writes = 0
  const update = mock.context.session.update
  mock.context.session.update = async (...args) => { writes++; await update(...args) }
  const adapter = pluginHost(mock.context)
  try {
    const [first, second] = await Promise.all([adapter.nativeSession(f.session.id), adapter.nativeSession(f.session.id)])
    assert.equal(writes, 1)
    assert.deepEqual(first, second)
    assert.deepEqual(first.metadata, { ...metadata, [KEY]: f.policy })
    assert.deepEqual(metadata, before)
    const policy = readPolicy(first)
    assert.deepEqual(projectRequest(f.native, f.raw, f.canonical, policy), projectRequest(f.native, f.raw, f.canonical, f.policy))
    await adapter.nativeSession(f.session.id)
    assert.equal(writes, 1)
    assert.deepEqual(mock.messages.get(f.session.id), f.native)
    assert.equal(mock.state.prompts.length, 0)
  } finally {
    await adapter.close()
  }
})

test("timestamp-less sources do not authorize reconciliation of missing or changed history", async () => {
  const f = fixture()
  f.save({ ...operation("brief", f.blocks()), summary: "KEEP_SUMMARY" })
  const legacy = { ...f.policy, sources: f.policy.sources!.map(({ created: _created, ...source }) => source) }
  const policy = readPolicy({ ...f.session, metadata: { [KEY]: legacy } })
  assert.throws(() => revertPolicy(f.raw.slice(0, 1), policy), /timestamps|provenance/i)
  const changed = structuredClone(f.native)
  changed[0].time.created++
  for (const native of [f.native.slice(0, 1), changed]) {
    const mock = mockContext()
    const metadata = { unrelated: "KEEP", [KEY]: legacy }
    const before = structuredClone(metadata)
    mock.sessions.set(f.session.id, { ...f.session, metadata })
    mock.messages.set(f.session.id, native)
    const adapter = pluginHost(mock.context)
    try {
      await assert.rejects(adapter.nativeSession(f.session.id), /timestamps|provenance|changed/i)
      assert.deepEqual(mock.sessions.get(f.session.id)!.metadata, before)
    } finally {
      await adapter.close()
    }
  }
  for (const created of [null, "1", -1, 0.5]) {
    const invalid = { ...legacy, sources: legacy.sources.map((source) => ({ ...source, created })) }
    assert.throws(() => readPolicy({ ...f.session, metadata: { [KEY]: invalid } }))
  }
})

test("staged and cold committed cutoffs agree through nested checkpoint, deletion, pruning and restoration layers", () => {
  const f = fixture()
  const policies: Policy[] = []
  const save = (op: Policy["operations"][number]) => { f.save(op); policies.push(f.policy) }
  save({ ...operation("tool-prune-all", f.blocks()), pruneReason: true })
  save({ ...operation("compact", splitAfter(f.blocks(), "msg_u0").slice(0, 1)), checkpoint: true, summary: "CHECKPOINT_PREFIX" })
  save({ ...operation("revise", [f.blocks()[0]]), targetID: f.blocks()[0].summaryID, summary: "REVISED_CHECKPOINT" })
  save({ ...operation("brief", f.blocks().slice(0, 3)), summary: "OUTER_SUMMARY" })
  save(operation("delete", f.blocks()))
  save(operation("expand", f.blocks()))
  save(operation("expand", [f.blocks()[0]]))
  for (const policy of policies) for (const boundary of activeMessages(f.raw)) {
    const prefix = f.raw.slice(0, f.raw.findIndex((message) => message.info.id === boundary.info.id))
    const staged = revertPolicy(f.raw, policy, boundary.info.id)
    const committed = revertPolicy(prefix, JSON.parse(JSON.stringify(policy)))
    assert.deepEqual(committed, staged, `${policy.revision} / ${boundary.info.id}`)
    const blocks = project(activeMessages(prefix), committed)
    assert.ok(blocks.every((block) => block.sourceIDs.every((id) => prefix.some((message) => message.info.id === id))))
    const restorable = blocks.filter((block) => block.summaryID || block.deletionID || block.pruning?.length)
    if (restorable.length) {
      const expanded = restorable.reduce((next, block) => append(next, operation("expand", [block])), committed)
      assert.ok(project(activeMessages(prefix), expanded).every((block) => block.sourceIDs.every((id) => prefix.some((message) => message.info.id === id))))
    }
  }
})

test("reconciliation refuses hidden native checkpoint windows and older replacement history", () => {
  const f = fixture()
  f.save({ ...operation("brief", f.blocks()), summary: "ALL" })
  const replacement = structuredClone(f.raw[0])
  replacement.info.id = "msg_unknown"
  assert.throws(() => revertPolicy([replacement], f.policy), /not new input/)
  replacement.info.time.created = 1000
  replacement.info.kind = "compaction"
  assert.throws(() => revertPolicy([replacement], f.policy), /Native checkpoint/)
})

test("an unchanged retained native checkpoint stays read-only while a later crossing summary opens", () => {
  const f = nativeFixture()
  const checkpoint = { id: "msg_checkpoint", type: "compaction" as const, status: "completed" as const, reason: "manual" as const, summary: "NATIVE_CHECKPOINT", recent: "", time: { created: 0 } }
  const native = [checkpoint, ...f.native]
  const raw = transcriptView(f.session, native)
  const original = emptyPolicy(f.session.id)
  const blocks = project(activeMessages(raw), original)
  const policy = rememberPolicy(raw, append(original, { ...operation("brief", blocks.slice(1)), summary: "CROSSING_LATER_SUMMARY" }))
  const prefix = raw.slice(0, raw.findIndex((message) => message.info.id === "msg_u2"))
  const next = revertPolicy(prefix, policy)
  assert.deepEqual(next, revertPolicy(raw, policy, "msg_u2"))
  assert.equal(next.operations.length, 0)
  assert.deepEqual(project(activeMessages(prefix), next).flatMap((block) => block.messages), activeMessages(prefix))
  const retainedNative = native.slice(0, native.findIndex((message) => message.id === "msg_u2"))
  const incoming = f.canonical.slice(0, f.canonical.findIndex((message) => message.id === "msg_u2"))
  assert.deepEqual(projectRequest(retainedNative, prefix, incoming, next), incoming)
})

for (const change of ["policy", "boundary", "location", "history", "unload"] as const) test(`reconciliation refuses ${change} changes before its write`, async () => {
  const f = fixture()
  f.save({ ...operation("brief", f.blocks()), summary: "ALL" })
  const mock = mockContext()
  mock.sessions.set(f.session.id, { ...f.session, metadata: { unrelated: "KEEP", [KEY]: f.policy } })
  mock.messages.set(f.session.id, f.native.slice(0, f.native.findIndex((message) => message.id === "msg_u2")))
  const adapter = pluginHost(mock.context)
  const get = mock.context.session.get
  let reads = 0
  let closing: Promise<void> | undefined
  mock.context.session.get = async (input) => {
    if (++reads === 2) {
      const session = mock.sessions.get(f.session.id)!
      if (change === "policy") session.metadata = { ...session.metadata, [KEY]: { ...f.policy, revision: -1 } }
      if (change === "boundary") session.revert = { messageID: "msg_u1" }
      if (change === "location") session.location = { directory: "/moved" }
      if (change === "history") mock.messages.get(f.session.id)![0].time.created++
      if (change === "unload") closing = adapter.close()
    }
    return get(input)
  }
  let writes = 0
  mock.context.session.update = async () => { writes++ }
  await assert.rejects(adapter.nativeSession(f.session.id), /changed|unloaded/i)
  assert.equal(writes, 0)
  await (closing ?? adapter.close())
})

test("unrelated metadata arriving during reconciliation is merged without replacing another namespace", async () => {
  const f = fixture()
  f.save({ ...operation("brief", f.blocks()), summary: "ALL" })
  const mock = mockContext()
  mock.sessions.set(f.session.id, { ...f.session, metadata: { [KEY]: f.policy } })
  mock.messages.set(f.session.id, f.native.slice(0, f.native.findIndex((message) => message.id === "msg_u1")))
  const get = mock.context.session.get
  let reads = 0
  mock.context.session.get = async (input) => {
    if (++reads === 2) mock.sessions.get(f.session.id)!.metadata!.another_plugin = "NEW_VALUE"
    return get(input)
  }
  const adapter = pluginHost(mock.context)
  assert.equal((await adapter.nativeSession(f.session.id)).metadata?.another_plugin, "NEW_VALUE")
  assert.equal(mock.sessions.get(f.session.id)!.metadata?.another_plugin, "NEW_VALUE")
  await adapter.close()
})

test("a commit racing a staged read cannot return the old staged policy to the next request", async () => {
  const f = fixture()
  f.save({ ...operation("brief", f.blocks()), summary: "CROSSES" })
  const mock = mockContext()
  mock.sessions.set(f.session.id, { ...f.session, revert: { messageID: "msg_u2" }, metadata: { [KEY]: f.policy } })
  const context = mock.context.session.context
  let reads = 0
  mock.context.session.context = async (input) => {
    if (++reads === 1) {
      delete mock.sessions.get(f.session.id)!.revert
      mock.messages.set(f.session.id, f.native.slice(0, f.native.findIndex((message) => message.id === "msg_u2")))
    }
    return context(input)
  }
  const adapter = pluginHost(mock.context)
  const session = await adapter.nativeSession(f.session.id)
  assert.equal(session.revert, undefined)
  assert.equal(readPolicy(session).operations.length, 0)
  await adapter.close()
})
