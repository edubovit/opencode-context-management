import assert from "node:assert/strict"
import { test } from "node:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { activeMessages, append, blockMessages, emptyPolicy, hash, historyHash, operation, POLICY_VERSION, project, readPolicy, splitAfter, splitOperation, type Block, type Envelope, type Operation, type Policy } from "../src/context.ts"
import { KEY } from "../src/config.ts"
import { inheritFork } from "../src/fork.ts"
import { policySchema } from "../src/ledger.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest } from "../src/projection.ts"
import { retainPolicy } from "../src/retention.ts"
import { rememberPolicy, revertPolicy } from "../src/revert.ts"
import { snapshot } from "../src/snapshot.ts"
import { FALLBACK_BASIS } from "../src/tokens.ts"
import { nativeSession } from "./native-fixtures.ts"
import { persistenceFixture } from "./persistence-fixture.ts"

function fixture() {
  const session = nativeSession("ses_subturn_persistence")
  const native: SessionMessageInfo[] = [
    { id: "user", type: "user", text: "SOURCE_QUESTION", time: { created: 1 } },
    ...Array.from({ length: 4 }, (_, index): Extract<SessionMessageInfo, { type: "assistant" }> => ({
      id: `batch_${index}`, type: "assistant", agent: "build", model: session.model!,
      finish: index === 3 ? "stop" : "tool-calls", time: { created: index * 10 + 2, completed: index * 10 + 3 },
      content: [
        { type: "reasoning", text: `REASON_${index}` },
        { type: "tool", id: `call_${index}`, name: "read", time: { created: index * 10 + 2, completed: index * 10 + 3 }, state: {
          status: "completed", input: { index }, content: [{ type: "text", text: `OUTPUT_${index} ${"detail ".repeat(20)}` }], metadata: {},
        } },
        { type: "text", text: `ANSWER_${index}` },
      ],
    })),
  ]
  const raw = activeMessages(transcriptView(session, native))
  let policy = emptyPolicy(session.id)
  const blocks = () => project(raw, policy)
  const save = (op: Operation) => {
    policy = rememberPolicy(raw, append(policy, { ...op, id: `saved_${policy.revision}`, created: 100 + policy.revision }))
  }
  const partition = (cuts = ["batch_0", "batch_1", "batch_2"], selected = blocks()) => save({ ...operation("partition", selected), cuts })
  return { session, native, raw, blocks, save, partition, get policy() { return policy } }
}

function reload(policy: Policy) {
  return readPolicy({ id: policy.sessionID, metadata: { [KEY]: JSON.parse(JSON.stringify(policy)) } })
}

function groups(blocks: Block[]) {
  return blocks.map(block => block.sourceIDs)
}

function restore(raw: Envelope[], policy: Policy) {
  for (let count = 0; count < 10; count++) {
    const blocks = project(raw, policy)
    const op = operation("expand", blocks)
    if (!op.summaryIDs?.length && !op.deletedIDs?.length && !op.pruneTargets?.length) return blocks
    policy = append(policy, op)
  }
  assert.fail("Restoration did not exhaust retained layers")
}

function frozenTextEndpoint(summary: boolean, future = false) {
  const base = fixture()
  const batch = structuredClone(base.native[1])
  const final = structuredClone(base.native[2])
  assert.equal(final.type, "assistant")
  final.id = "text_final"
  final.finish = "stop"
  final.content = [{ type: "reasoning", text: "FINAL_REASON" }, { type: "text", text: "FINAL_TEXT" }]
  const native: SessionMessageInfo[] = [base.native[0], batch, final]
  let raw = activeMessages(transcriptView(base.session, native))
  let policy = emptyPolicy(base.session.id)
  policy = append(policy, { ...operation("partition", project(raw, policy)), cuts: ["batch_0"] })
  policy = append(policy, operation("prune-reason", [project(raw, policy)[1]]))
  native.push({ ...structuredClone(final), id: "appended", time: { created: 100, completed: 101 }, content: [{ type: "text", text: "APPENDED_FACT" }] })
  raw = activeMessages(transcriptView(base.session, native))
  assert.deepEqual(project(raw, policy).map(block => block.subturn?.originID), ["user", "user", "user"])
  if (summary) policy = append(policy, { ...operation("brief", [project(raw, policy)[2]]), summary: "APPENDED_SUMMARY" })
  if (future) {
    native.push({ id: "future_user", type: "user", text: "FUTURE_QUESTION", time: { created: 200 } })
    native.push({ ...structuredClone(final), id: "future_answer", time: { created: 201, completed: 202 } })
    raw = activeMessages(transcriptView(base.session, native))
    policy = append(policy, { ...operation("brief", [project(raw, policy).at(-1)!]), summary: "FUTURE_SUMMARY" })
  }
  policy = rememberPolicy(raw, policy)
  return { session: base.session, native, raw, policy }
}

for (const summary of [false, true]) test(`frozen non-tool endpoints retain verified appended subturn identity (summary=${summary})`, () => {
  const f = frozenTextEndpoint(summary)
  const inherited = project(f.raw, f.policy)
  const before = hash({ raw: f.raw, policy: f.policy })
  const ids = new Map(f.raw.map(message => [message.info.id, message.info.id]))
  const policy = retainPolicy(f.raw, inherited, f.policy, ids, f.session.id)
  const blocks = project(f.raw, reload(policy))
  assert.deepEqual(groups(blocks), groups(inherited))
  assert.deepEqual(blocks.map(block => block.subturn?.originID), ["user", "user", "user"])
  assert.equal(blocks[1].reasonPruned, true)
  if (summary) assert.match(JSON.stringify(blocks[2].messages), /APPENDED_SUMMARY/)
  assert.deepEqual(blockMessages(restore(f.raw, policy)), f.raw)
  assert.equal(hash({ raw: f.raw, policy: f.policy }), before)
})

for (const summary of [false, true]) test(`full fork preserves appended subturn provenance past a frozen non-tool endpoint (summary=${summary})`, () => {
  const f = frozenTextEndpoint(summary)
  const copied = f.native.map((message, index) => ({ ...structuredClone(message), id: `fork_text_${index}` }))
  const target: SessionInfo = { ...nativeSession("ses_text_fork"), fork: { sessionID: f.session.id, boundary: { type: "through", messageID: "appended" } } }
  const raw = activeMessages(transcriptView(target, copied))
  const policy = inheritFork(f.session, f.native, target, copied, f.policy)
  const blocks = project(raw, reload(policy))
  assert.deepEqual(groups(blocks), [["fork_text_0", "fork_text_1"], ["fork_text_2"], ["fork_text_3"]])
  assert.deepEqual(blocks.map(block => block.subturn?.originID), Array(3).fill("fork_text_0"))
  assert.equal(blocks[1].reasonPruned, true)
  assert.deepEqual(blockMessages(restore(raw, policy)), raw)
})

for (const summary of [false, true]) test(`staged and cold revert preserve appended subturn provenance past a frozen non-tool endpoint (summary=${summary})`, () => {
  const f = frozenTextEndpoint(summary, true)
  const prefix = f.raw.slice(0, f.raw.findIndex(message => message.info.id === "future_user"))
  const staged = revertPolicy(f.raw, f.policy, "future_user")
  const cold = revertPolicy(prefix, reload(f.policy))
  assert.deepEqual(cold, staged)
  const blocks = project(prefix, reload(cold))
  assert.deepEqual(groups(blocks), [["user", "batch_0"], ["text_final"], ["appended"]])
  assert.deepEqual(blocks.map(block => block.subturn?.originID), ["user", "user", "user"])
  assert.equal(blocks[1].reasonPruned, true)
  assert.doesNotMatch(JSON.stringify(blocks), /FUTURE_SUMMARY|FUTURE_QUESTION/)
  assert.deepEqual(blockMessages(restore(prefix, cold)), prefix)
})

for (const summary of [false, true]) test(`clipping every safe cut still retains text-boundary subturn provenance (summary=${summary})`, () => {
  const f = fixture()
  const first = structuredClone(f.native[1])
  const second = structuredClone(f.native[2])
  assert.equal(first.type, "assistant")
  assert.equal(second.type, "assistant")
  first.id = "text_first"
  first.content = [{ type: "text", text: "EARLY_TEXT" }]
  second.id = "text_second"
  second.content = [{ type: "reasoning", text: "TEXT_REASON" }, { type: "text", text: "SECOND_TEXT" }]
  const native = [f.native[0], first, second, f.native[3], f.native[4]]
  const raw = activeMessages(transcriptView(f.session, native))
  let policy = emptyPolicy(f.session.id)
  policy = append(policy, { ...operation("partition", project(raw, policy)), cuts: ["batch_2"] })
  policy = append(policy, { ...operation("brief", [splitAfter(project(raw, policy), "text_first")[0]]), summary: "EARLY_SUMMARY" })
  policy = append(policy, operation("prune-reason", [splitAfter(project(raw, policy), "text_second")[1]]))
  if (summary) policy = append(policy, { ...operation("brief", [project(raw, policy)[1]]), summary: "SECOND_SUMMARY" })
  policy = rememberPolicy(raw, policy)
  const prefix = raw.slice(0, 3)
  const staged = revertPolicy(raw, policy, "batch_2")
  const cold = revertPolicy(prefix, reload(policy))
  assert.deepEqual(staged, cold)
  const blocks = project(prefix, cold)
  assert.deepEqual(groups(blocks), [["user", "text_first"], ["text_second"]])
  assert.deepEqual(blocks.map(block => block.subturn?.originID), ["user", "user"])
  assert.deepEqual(cold.subturnOrigins, ["user"])
  assert.equal(cold.operations.some(op => op.mode === "partition"), false)
  const retainedAgain = retainPolicy(prefix, blocks, cold, new Map(prefix.map(message => [message.info.id, message.info.id])), f.session.id)
  assert.deepEqual(project(prefix, retainedAgain).map(block => block.subturn?.originID), ["user", "user"])
  const copied = native.slice(0, 3).map((message, index) => ({ ...structuredClone(message), id: `clipped_${index}` }))
  const target: SessionInfo = { ...nativeSession("ses_clipped"), fork: { sessionID: f.session.id, boundary: { type: "before", messageID: "batch_2" } } }
  const forked = inheritFork(f.session, native, target, copied, policy)
  const forkRaw = activeMessages(transcriptView(target, copied))
  assert.deepEqual(project(forkRaw, forked).map(block => block.subturn?.originID), ["clipped_0", "clipped_0"])
  assert.deepEqual(blockMessages(restore(prefix, cold)), prefix)
})

test("retained subturn roots require native USER provenance and are rejected in formats 7–13", () => {
  const f = fixture()
  const seeded = { ...f.policy, subturnOrigins: ["user"] }
  assert.deepEqual(reload(seeded), seeded)
  assert.equal(project(f.raw, seeded)[0].subturn?.originID, "user")
  for (const id of ["batch_0", "missing"]) assert.throws(() => project(f.raw, { ...seeded, subturnOrigins: [id] }), /native USER/)
  assert.throws(() => reload({ ...seeded, subturnOrigins: ["user", "user"] }))
  for (const version of [7, 8, 9, 10, 11, 12, 13]) {
    const value = { ...seeded, version, ...(version < 9 ? { cursor: 0 } : {}) }
    const before = structuredClone(value)
    assert.throws(() => readPolicy({ id: f.session.id, metadata: { [KEY]: value } }), /provenance requires ledger format 14/)
    assert.deepEqual(value, before)
  }
})

test("prune, restore, then split replays in ledger order and survives a cold codec round trip", () => {
  const f = fixture()
  const original = hash({ native: f.native, raw: f.raw })
  f.save({ ...operation("tool-delete", f.blocks()), pruneReason: true })
  f.save(operation("expand", f.blocks()))
  assert.deepEqual(blockMessages(f.blocks()), f.raw)
  const planned = splitOperation(f.blocks()[0], 2, FALLBACK_BASIS, { minTokens: 1, minSplitTokens: 1 })
  f.save(planned.operation)
  const visits: { mode: string; groups: string[][] }[] = []
  const saved = reload(f.policy)
  const blocks = project(f.raw, saved, (op, selected) => visits.push({ mode: op.mode, groups: groups(selected) }))
  assert.deepEqual(visits.map(visit => visit.mode), ["tool-delete", "expand", "partition"])
  assert.ok(visits.every(visit => visit.groups.length === 1))
  assert.equal(blocks.length, 2)
  assert.ok(blocks.every(block => block.subturn?.originID === "user"))
  assert.deepEqual(blockMessages(blocks), f.raw)
  assert.deepEqual(blocks, f.blocks())
  assert.deepEqual(saved, f.policy)
  assert.equal(hash({ native: f.native, raw: f.raw }), original)
})

test("divergent sibling pruning survives merge and restores each hidden segment one layer at a time", () => {
  const f = fixture()
  f.partition()
  f.save(operation("prune-reason", [f.blocks()[0]]))
  const reasonOnly = blockMessages(f.blocks())
  f.save(operation("tool-prune-all", [f.blocks()[0]]))
  f.save({ ...operation("tool-delete", [f.blocks()[1]]), pruneReason: true })
  f.save(operation("tool-prune-all", [f.blocks()[2]]))
  const pruned = blockMessages(f.blocks())
  f.partition([])
  assert.equal(f.blocks().length, 1)
  assert.deepEqual(blockMessages(f.blocks()), pruned)
  assert.deepEqual(project(f.raw, reload(f.policy)), f.blocks())
  const saved = hash(f.policy)
  f.save(operation("expand", f.blocks()))
  assert.equal(f.blocks().length, 1)
  assert.deepEqual(blockMessages(f.blocks()), reasonOnly)
  assert.deepEqual(project(f.raw, reload(f.policy)), f.blocks())
  f.save(operation("expand", f.blocks()))
  assert.equal(f.blocks().length, 1)
  assert.deepEqual(blockMessages(f.blocks()), f.raw)
  assert.equal(hash({ ...f.policy, revision: f.policy.revision - 2, operations: f.policy.operations.slice(0, -2) }), saved)
})

for (const mode of ["brief", "delete"] as const) test(`${mode} retains merged hidden segments and expansion preserves their grouping and pruning`, () => {
  const f = fixture()
  f.partition()
  f.save({ ...operation("tool-delete", [f.blocks()[0]]), pruneReason: true })
  f.save(operation("prune-reason", [f.blocks()[1]]))
  f.partition([])
  const grouped = f.blocks()
  f.save({ ...operation(mode, grouped), ...(mode === "brief" ? { summary: "GROUPED_SUMMARY" } : {}) })
  assert.equal(f.blocks()[0].kind, mode === "brief" ? "brief" : "deleted")
  f.save(operation("expand", f.blocks()))
  assert.deepEqual(f.blocks(), grouped)
  assert.deepEqual(project(f.raw, reload(f.policy)), grouped)
  f.save(operation("expand", f.blocks()))
  assert.equal(f.blocks().length, 1)
  assert.deepEqual(blockMessages(f.blocks()), f.raw)
})

test("snapshot 8 exports subturn identity but never hidden merged restoration content", () => {
  const f = fixture()
  f.partition()
  const split = snapshot(f.session.id, "2.2.5", f.blocks(), f.policy)
  assert.equal(split.schemaVersion, 8)
  assert.deepEqual(split.blocks.map(block => block.subturn), f.blocks().map(block => block.subturn))
  assert.equal(split.historyHash, historyHash(f.raw))
  f.save({ ...operation("tool-delete", [f.blocks()[0]]), pruneReason: true })
  f.partition([])
  const exported = snapshot(f.session.id, "2.2.5", f.blocks(), f.policy)
  assert.equal(exported.blocks.length, 1)
  assert.doesNotMatch(JSON.stringify(exported), /OUTPUT_0|REASON_0|"segments"|"pruning"|"previous"/)
  assert.match(exported.text, /OUTPUT_1/)
  assert.equal(exported.historyHash, historyHash(blockMessages(f.blocks())))
})

test("the selected source endpoint does not freeze the final subturn when assistants arrive later", () => {
  const f = fixture()
  f.partition(["batch_0", "batch_2"])
  const appended = structuredClone(f.native.at(-1)!)
  appended.id = "batch_later"
  appended.time = { created: 200, completed: 201 }
  const raw = activeMessages(transcriptView(f.session, [...f.native, appended]))
  const replayed = project(raw, reload(f.policy))
  assert.deepEqual(groups(replayed), [["user", "batch_0"], ["batch_1", "batch_2"], ["batch_3", "batch_later"]])
  assert.deepEqual(blockMessages(replayed), raw)
  const nextUser: SessionMessageInfo = { id: "next_user", type: "user", text: "NEW_QUESTION", time: { created: 202 } }
  const next = project(activeMessages(transcriptView(f.session, [...f.native, appended, nextUser])), f.policy)
  assert.deepEqual(groups(next), [...groups(replayed), ["next_user"]])
  assert.equal(next.at(-1)!.subturn, undefined)
})

test("staged and committed internal reverts agree across split, pruning, summary and deletion layers", () => {
  const f = fixture()
  const policies: Policy[] = []
  f.partition(["batch_0", "batch_2"])
  policies.push(f.policy)
  f.save({ ...operation("tool-delete", [f.blocks()[1]]), pruneReason: true })
  policies.push(f.policy)
  f.save({ ...operation("brief", f.blocks()), summary: "CROSSES_INTERNAL_CUTOFF" })
  policies.push(f.policy)
  f.save(operation("delete", f.blocks()))
  policies.push(f.policy)
  for (const policy of policies) {
    const before = hash(policy)
    for (const boundary of ["batch_0", "batch_1", "batch_2", "batch_3"]) {
      const prefix = f.raw.slice(0, f.raw.findIndex(message => message.info.id === boundary))
      const staged = revertPolicy(f.raw, policy, boundary)
      const committed = revertPolicy(prefix, reload(policy))
      assert.deepEqual(committed, staged, `${policy.revision} / ${boundary}`)
      const blocks = project(prefix, reload(committed))
      assert.deepEqual(blocks.flatMap(block => block.sourceIDs), prefix.map(message => message.info.id))
      assert.doesNotMatch(JSON.stringify(blocks), /CROSSES_INTERNAL_CUTOFF/)
      assert.deepEqual(blockMessages(restore(prefix, committed)), prefix)
      assert.equal(hash(policy), before)
    }
    assert.deepEqual(revertPolicy(f.raw, policy), policy)
  }
})

test("a committed revert may replay missing cut placeholders only after proving the retained source prefix", () => {
  const f = fixture()
  f.partition(["batch_0", "batch_2"])
  const prefix = f.raw.slice(0, 2)
  const committed = revertPolicy(prefix, reload(f.policy))
  assert.deepEqual(committed, revertPolicy(f.raw, f.policy, "batch_1"))
  assert.deepEqual(blockMessages(project(prefix, committed)), prefix)
  const { sources: _sources, ...unproven } = f.policy
  assert.throws(() => revertPolicy(prefix, unproven), /provenance|original|source/i)
  const changed = structuredClone(prefix)
  changed[0].parts[0] = { ...changed[0].parts[0], type: "text", text: "CHANGED_PREFIX" }
  assert.throws(() => revertPolicy(changed, f.policy), /changed|prefix/i)
  assert.throws(() => revertPolicy(f.raw.filter(message => message.info.id !== "batch_1"), f.policy), /prefix|missing/i)
})

for (const partial of [false, true]) test(`${partial ? "partial" : "full"} fork remaps internal cuts and retains independent hidden restoration layers`, () => {
  const f = fixture()
  f.partition(["batch_0", "batch_2"])
  f.save(operation("prune-reason", [f.blocks()[0]]))
  f.save({ ...operation("tool-delete", [f.blocks()[1]]), pruneReason: true })
  f.save({ ...operation("brief", f.blocks()), summary: "FORK_GROUPED_SUMMARY" })
  const original = hash({ native: f.native, policy: f.policy })
  const source = partial ? f.native.slice(0, 3) : f.native
  const copied = source.map((message, index) => ({ ...structuredClone(message), id: `fork_${index}` }))
  const target: SessionInfo = {
    ...nativeSession("ses_subturn_fork"),
    fork: { sessionID: f.session.id, boundary: { type: partial ? "before" : "through", messageID: partial ? "batch_2" : "batch_3" } },
  }
  const raw = activeMessages(transcriptView(target, copied))
  const ids = new Map(source.map((message, index) => [message.id, copied[index].id]))
  const policy = inheritFork(f.session, f.native, target, copied, f.policy)
  assert.deepEqual(policy, retainPolicy(raw, f.blocks(), f.policy, ids, target.id))
  assert.equal(policy.sessionID, target.id)
  let blocks = project(raw, reload(policy))
  if (partial) {
    assert.deepEqual(groups(blocks), [["fork_0", "fork_1"], ["fork_2"]])
    assert.doesNotMatch(JSON.stringify(blocks), /FORK_GROUPED_SUMMARY|OUTPUT_2|OUTPUT_3/)
    assert.equal(blocks[0].reasonPruned, true)
    assert.equal(blocks[1].toolsDeleted, true)
  } else {
    assert.equal(blocks[0].kind, "brief")
    blocks = project(raw, append(policy, operation("expand", blocks)))
    assert.deepEqual(groups(blocks), [["fork_0", "fork_1"], ["fork_2", "fork_3"], ["fork_4"]])
    assert.equal(blocks[0].reasonPruned, true)
    assert.equal(blocks[1].toolsDeleted, true)
  }
  assert.ok(blocks.every(block => block.subturn?.originID === "fork_0"))
  assert.deepEqual(blockMessages(restore(raw, policy)), raw)
  assert.ok(policy.operations.every(op => op.sourceIDs.every(id => id.startsWith("fork_")) && (op.cuts ?? []).every(id => id.startsWith("fork_"))))
  assert.equal(hash({ native: f.native, policy: f.policy }), original)
})

test("retaining a merged group preserves divergent segments without exposing their old partition", () => {
  const f = fixture()
  f.partition()
  f.save(operation("prune-reason", [f.blocks()[0]]))
  f.save({ ...operation("tool-delete", [f.blocks()[1]]), pruneReason: true })
  f.partition([])
  const ids = new Map(f.raw.map(message => [message.info.id, message.info.id]))
  const policy = retainPolicy(f.raw, f.blocks(), f.policy, ids, f.session.id)
  const retained = project(f.raw, reload(policy))
  assert.equal(retained.length, 1)
  assert.deepEqual(blockMessages(retained), blockMessages(f.blocks()))
  const expanded = project(f.raw, append(policy, operation("expand", retained)))
  assert.equal(expanded.length, 1)
  assert.deepEqual(blockMessages(expanded), f.raw)
})

test("partition replay rejects unsafe user, unfinished, nonnative, text-only and running-tool cuts", () => {
  const f = fixture()
  for (const kind of ["user", "unfinished", "nonnative", "text-only", "running"] as const) {
    const raw = structuredClone(f.raw)
    const assistant = raw[1]
    if (kind === "unfinished") delete assistant.info.time.completed
    if (kind === "nonnative") assistant.info.kind = "synthetic"
    if (kind === "text-only") assistant.parts = assistant.parts.filter(part => part.type !== "tool")
    if (kind === "running") {
      const tool = assistant.parts.find(part => part.type === "tool")!
      assert.equal(tool.type, "tool")
      tool.state = { status: "running", input: {} }
    }
    const op = { ...operation("partition", project(raw, emptyPolicy(f.session.id))), cuts: [kind === "user" ? "user" : "batch_0"] }
    const saved = reload(append(emptyPolicy(f.session.id), op))
    const before = hash({ raw, saved })
    assert.throws(() => project(raw, saved), /cut|boundary|partition|completed|pending|running/i, kind)
    assert.equal(hash({ raw, saved }), before)
  }
})

test("format 14 validates cut ownership, ordering, uniqueness and partition-only fields", () => {
  const f = fixture()
  const base = operation("partition", f.blocks())
  const valid = append(f.policy, { ...base, cuts: ["batch_0", "batch_2"] })
  assert.equal(POLICY_VERSION, 14)
  assert.equal(policySchema.safeParse(valid).success, true)
  assert.deepEqual(reload(valid), valid)
  for (const cuts of [undefined, [""], ["missing"], ["batch_0", "batch_0"], ["batch_2", "batch_0"], ["batch_3"]]) {
    const policy = { ...valid, operations: [{ ...base, cuts }] }
    assert.equal(policySchema.safeParse(policy).success, false, JSON.stringify(cuts))
    assert.throws(() => readPolicy({ id: f.session.id, metadata: { [KEY]: policy } }))
  }
  for (const extra of [{ summary: "ILLEGAL" }, { pruneReason: true }, { checkpoint: true }, { targetID: "other" }, { summaryIDs: ["other"] }, { deletedIDs: ["other"] }]) {
    assert.equal(policySchema.safeParse({ ...valid, operations: [{ ...valid.operations[0], ...extra }] }).success, false)
  }
  const ordinary = append(f.policy, { ...operation("prune-reason", f.blocks()), cuts: [] })
  assert.equal(policySchema.safeParse(ordinary).success, false)
  f.partition()
  const merge = append(f.policy, { ...operation("partition", f.blocks()), cuts: [] })
  assert.deepEqual(reload(merge), merge)
  assert.equal(project(f.raw, merge).length, 1)
})

for (const version of [7, 8, 9, 10, 11, 12, 13]) test(`format ${version} rejects partition/cuts while preserving the frozen legacy hash codec`, () => {
  const f = fixture()
  for (const op of [
    { ...operation("partition", f.blocks()), cuts: ["batch_0"] },
    { ...operation("prune-reason", f.blocks()), cuts: [] },
  ]) {
    const value = { ...append(f.policy, op), version, ...(version < 9 ? { cursor: 1 } : {}) }
    const before = structuredClone(value)
    assert.throws(() => readPolicy({ id: f.session.id, metadata: { [KEY]: value } }))
    assert.deepEqual(value, before)
  }
  const legacy = persistenceFixture()
  assert.equal(legacy.states[0].source, "cace141d423d57c5b8077de5a0cb0b5f8e2081653250e406102387e08bb1c5f4")
  assert.equal(legacy.states.at(-1)!.source, "b982ba78d9e2def13c069a50587a038d1b46e5b47f453542e2999d40ed399471")
  const value = { ...legacy.policy, version, ...(version < 9 ? { cursor: legacy.policy.operations.length } : {}) }
  const before = structuredClone(value)
  const migrated = readPolicy({ id: legacy.session.id, metadata: { [KEY]: value } })
  assert.equal(migrated.version, 14)
  assert.deepEqual(migrated.operations, legacy.policy.operations)
  assert.deepEqual(reload(migrated), migrated)
  assert.equal(hash(blockMessages(project(activeMessages(legacy.raw), migrated))), legacy.effective)
  assert.equal(hash(projectRequest(legacy.native, legacy.raw, legacy.canonical, migrated)), "e1d21f474c9bb4fc221a27a4446cf39c8d26edd8c20bcfc404f0982e70786989")
  assert.deepEqual(value, before)
})
