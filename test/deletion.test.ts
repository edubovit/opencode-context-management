import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import { activeMessages, append, blockMessages, emptyPolicy, operation, project, readPolicy, type Operation } from "../src/context.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest, validateNativePolicy } from "../src/projection.ts"
import { Controller } from "../src/controller.ts"
import { KEY, settings } from "../src/config.ts"
import { policySchema } from "../src/ledger.ts"
import { distribution } from "../src/metrics.ts"
import { snapshot } from "../src/snapshot.ts"
import { summaryPrompt } from "../src/summarize.ts"
import { lastResortRange } from "../src/last-resort.ts"
import { FALLBACK_BASIS } from "../src/tokens.ts"
import { selectedModes, toggleMode } from "../src/compaction.ts"
import { rangePreview } from "../src/range-rows.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { fixtureHost } from "./fixtures.ts"

function fixture() {
  const { session, native, canonical } = nativeFixture()
  const raw = transcriptView(session, native)
  let policy = emptyPolicy(session.id)
  return {
    session, native, canonical, raw,
    get policy() { return policy },
    blocks: () => project(activeMessages(raw), policy),
    save: (op: Operation) => { policy = append(policy, op) },
    request: (incoming = canonical) => projectRequest(native, raw, incoming, policy),
  }
}

test("delete collapses a range to one empty DELETED block, removes whole request pairs and expands exactly", () => {
  const f = fixture()
  const original = JSON.stringify({ native: f.native, raw: f.raw, canonical: f.canonical })
  const before = f.blocks()
  const deletion = operation("delete", before.slice(0, 2))
  f.save(deletion)
  const blocks = f.blocks()
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].kind, "deleted")
  assert.equal(blocks[0].deletionID, deletion.id)
  assert.deepEqual(blocks[0].sourceIDs, before.slice(0, 2).flatMap((block) => block.sourceIDs))
  assert.deepEqual(blocks[0].messages, [])
  assert.equal(distribution([blocks[0]]).total, 0)
  assert.deepEqual(blocks[1], before[2])
  assert.deepEqual(f.request(), f.canonical.filter((message) => message.role === "system" || message.id === "msg_u2" || message.id === "msg_a2" || message.content.some((part) => part.type === "tool-result" && part.id === "call_2")))
  const restore = operation("expand", [blocks[0]])
  assert.deepEqual(restore.deletedIDs, [deletion.id])
  f.save(restore)
  assert.deepEqual(f.blocks(), before)
  assert.deepEqual(f.request(), f.canonical)
  assert.equal(JSON.stringify({ native: f.native, raw: f.raw, canonical: f.canonical }), original)
})

test("deletion restores earlier summaries, pruning and nested deletions one layer at a time", () => {
  const f = fixture()
  f.save(operation("tool-prune-all", [f.blocks()[0]]))
  f.save({ ...operation("brief", [f.blocks()[1]]), summary: "KEEP_SAVED_SUMMARY" })
  const before = f.blocks()
  const request = f.request()
  f.save(operation("delete", f.blocks().slice(0, 2)))
  const inner = f.blocks()
  f.save(operation("delete", f.blocks()))
  f.save(operation("expand", f.blocks()))
  assert.deepEqual(f.blocks(), inner)
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.blocks(), before)
  assert.deepEqual(f.request(), request)
  f.save(operation("expand", f.blocks().slice(0, 2)))
  assert.deepEqual(f.request(), f.canonical)
})

test("mixed summary, deletion and pruning restore targets apply together without touching another range", () => {
  const f = fixture()
  f.save(operation("delete", [f.blocks()[0]]))
  f.save({ ...operation("compact", [f.blocks()[1]]), summary: "Middle" })
  f.save(operation("prune-reason", [f.blocks()[2]]))
  const restore = operation("expand", f.blocks())
  assert.equal(restore.deletedIDs?.length, 1)
  assert.equal(restore.summaryIDs?.length, 1)
  assert.equal(restore.pruneTargets?.length, 1)
  f.save(restore)
  assert.deepEqual(f.request(), f.canonical)
})

test("deleted content stays absent from helpers, counts, previews and effective exports, even inside a later summary", () => {
  const f = fixture()
  f.save(operation("delete", [f.blocks()[0]]))
  const blocks = f.blocks()
  const prompt = summaryPrompt(operation("brief", blocks), blocks)
  const exported = snapshot(f.session.id, "2.0.27", blocks, f.policy)
  for (const text of [prompt, JSON.stringify(exported.blocks), exported.text, rangePreview(blocks[0], f.policy)]) {
    assert.doesNotMatch(text, /QUESTION_0|HEAD_0|REASON_0|ANSWER_0|"previous"|"pruning"/)
  }
  assert.equal(exported.schemaVersion, 7)
  const request = f.request()
  f.save({ ...operation("brief", blocks), summary: "VISIBLE_ONLY" })
  f.save(operation("expand", f.blocks()))
  assert.deepEqual(f.request(), request)
  assert.equal(f.blocks()[0].kind, "deleted")
  const range = lastResortRange(f.blocks(), 0, FALLBACK_BASIS)
  assert.deepEqual(range.selected.map((block) => block.kind), ["deleted", "turn", "turn"])
  assert.doesNotMatch(JSON.stringify(blockMessages(range.selected)), /QUESTION_0/)
})

test("deletion expansion uses current-hook redactions and restores complete media/error wrappers", () => {
  const f = fixture()
  const redacted = f.canonical.map((message) => message.role === "tool" && message.content.some((part) => part.type === "tool-result" && part.id === "call_0")
    ? Message.tool({ id: "call_0", name: "fixture", result: { type: "error", value: { error: { message: "REDACTED" }, content: [{ type: "file", mime: "image/png", uri: "data:image/png;base64,AA==" }] } }, providerMetadata: { fixture: { state: "keep" } } })
    : message)
  f.save(operation("delete", [f.blocks()[0]]))
  assert.doesNotMatch(JSON.stringify(f.request(redacted)), /REDACTED|data:image/)
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.request(redacted), redacted)
})

test("deletion persistence accepts prior ledger 10 without rewriting it and rejects foreign, hidden and legacy targets", () => {
  const f = fixture()
  f.save(operation("tool-prune-all", [f.blocks()[0]]))
  const saved = JSON.parse(JSON.stringify({ ...f.policy, version: 10 }))
  const before = JSON.stringify(saved)
  const decoded = readPolicy({ id: f.session.id, metadata: { [KEY]: saved } })
  assert.equal(decoded.version, 13)
  assert.equal(JSON.stringify(saved), before)
  f.save(operation("delete", [f.blocks()[0]]))
  const restore = operation("expand", [f.blocks()[0]])
  for (const version of [7, 8, 9, 10]) assert.throws(() => readPolicy({ id: f.session.id, metadata: { [KEY]: { ...f.policy, version, ...(version < 9 ? { cursor: f.policy.revision } : {}) } } }), /format 11/)
  for (const deletedIDs of [["missing"], [restore.deletedIDs![0], restore.deletedIDs![0]]]) {
    const bad = append(f.policy, { ...restore, deletedIDs })
    assert.throws(() => { policySchema.parse(bad); project(activeMessages(f.raw), bad) })
  }
  f.save(operation("delete", f.blocks()))
  assert.throws(() => project(activeMessages(f.raw), append(f.policy, { ...operation("expand", f.blocks()), deletedIDs: restore.deletedIDs })), /delet/)
  const persisted = readPolicy({ id: f.session.id, metadata: { [KEY]: JSON.parse(JSON.stringify(f.policy)) } })
  assert.deepEqual(projectRequest(f.native, f.raw, f.canonical, persisted), f.request())
  assert.equal(policySchema.safeParse(append(f.policy, { ...operation("delete", f.blocks()), deletedIDs: restore.deletedIDs })).success, false)
})

test("saved format-10 pruning restorations retain their meaning before and after a deletion", () => {
  const f = fixture()
  f.save(operation("tool-prune-all", f.blocks()))
  f.save(operation("expand", [f.blocks()[0]]))
  const saved = JSON.parse(JSON.stringify({ ...f.policy, version: 10 }))
  const before = JSON.stringify(saved)
  let policy = readPolicy({ id: f.session.id, metadata: { [KEY]: saved } })
  const blocks = project(activeMessages(f.raw), policy)
  const request = projectRequest(f.native, f.raw, f.canonical, policy)
  policy = append(policy, operation("delete", blocks.slice(0, 2)))
  policy = append(policy, operation("expand", [project(activeMessages(f.raw), policy)[0]]))
  assert.deepEqual(projectRequest(f.native, f.raw, f.canonical, policy), request)
  assert.deepEqual(policy.operations.slice(0, saved.operations.length), saved.operations)
  assert.equal(JSON.stringify(saved), before)
})

test("deleting every turn leaves zero effective content and later user turns survive expansion", () => {
  const f = fixture()
  const before = f.blocks()
  f.save(operation("delete", before))
  assert.deepEqual(blockMessages(f.blocks()), [])
  assert.deepEqual(f.request(), f.canonical.filter((message) => message.role === "system"))
  const later = { id: "msg_later", type: "user" as const, text: "KEEP_NEW_INPUT", time: { created: 100 } }
  f.native.push(later)
  f.raw.push(...transcriptView(f.session, [later]))
  f.canonical.push(Message.make({ id: later.id, role: "user", content: later.text }))
  assert.deepEqual(f.request(), f.canonical.filter((message) => message.role === "system" || message.id === later.id))
  const deleted = f.blocks()[0]
  assert.throws(() => project(activeMessages(f.raw), append(f.policy, { ...operation("expand", [deleted]), sourceIDs: deleted.sourceIDs.slice(0, 2) })), /range/)
  const initialHash = f.raw[0].info.sourceHash
  f.raw[0].info.sourceHash = "changed-hidden-source"
  assert.throws(() => f.blocks(), /content changed/)
  f.raw[0].info.sourceHash = initialHash
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.request(), f.canonical)
  assert.deepEqual(f.blocks().slice(0, 3), before)
})

test("delete keeps missing-source, active-tool and native-checkpoint guards", () => {
  const f = fixture()
  f.save(operation("delete", [f.blocks()[0]]))
  assert.throws(() => f.request(f.canonical.filter((message) => message.id !== "msg_u0")), /absent/)
  const assistant = f.native.find((message) => message.type === "assistant")!
  assert.equal(assistant.type, "assistant")
  const tool = assistant.content.find((part) => part.type === "tool")!
  assert.equal(tool.type, "tool")
  tool.state = { status: "running", input: {}, metadata: {} }
  const raw = transcriptView(f.session, f.native)
  const blocks = project(activeMessages(raw), emptyPolicy(f.session.id))
  assert.throws(() => validateNativePolicy(f.native, raw, append(emptyPolicy(f.session.id), operation("delete", [blocks[0]]))), /settle/)
  const checkpoint = { id: "msg_checkpoint", type: "compaction" as const, status: "completed" as const, reason: "manual" as const, summary: "Native", recent: "", time: { created: 0 } }
  const native = [checkpoint, ...f.native]
  const normalized = transcriptView(f.session, native)
  const selected = project(activeMessages(normalized), emptyPolicy(f.session.id)).slice(0, 1)
  assert.throws(() => validateNativePolicy(native, normalized, append(emptyPolicy(f.session.id), operation("delete", selected))), /checkpoints/)
})

test("controller deletes disjoint ranges atomically without helpers and rejects no-op, busy or stale restoration", async () => {
  const { data, host } = fixtureHost()
  let writes = 0
  const controller = new Controller({ ...host, update: async (...args) => { writes++; await host.update(...args) } }, data.session.id, settings(), { capture: async () => undefined, write: async () => "unused" })
  const before = await controller.load()
  const original = JSON.stringify(data.messages)
  await controller.deleteRanges([before.blocks[0].sourceIDs, before.blocks[2].sourceIDs])
  assert.equal(writes, 1)
  const deleted = await controller.load()
  assert.deepEqual(deleted.blocks.map((block) => block.kind), ["deleted", "turn", "deleted"])
  await assert.rejects(controller.deleteRanges([deleted.blocks[0].sourceIDs]), /already deleted|No .*content/i)
  await assert.rejects(controller.summarize("brief", deleted.blocks[0].sourceIDs), /visible|user message/)
  const preview = await controller.prepareRestoreRanges("expand", [deleted.blocks[0].sourceIDs, deleted.blocks[2].sourceIDs])
  assert.equal(preview.deletions, 2)
  assert.equal(preview.beforeTokens, 0)
  data.idle = false
  await assert.rejects(controller.deleteRanges([deleted.blocks[1].sourceIDs]), /idle/)
  await assert.rejects(controller.applyOperations(preview.operations, preview), /idle/)
  data.idle = true
  await controller.prune(deleted.blocks[1].sourceIDs, { reasoning: true })
  await assert.rejects(controller.applyOperations(preview.operations, preview), /changed/)
  const fresh = await controller.prepareRestoreRanges("expand", preview.ranges)
  await controller.applyOperations(fresh.operations, fresh)
  const restored = await controller.load()
  assert.deepEqual(restored.blocks[0], before.blocks[0])
  assert.deepEqual(restored.blocks[2], before.blocks[2])
  assert.equal(restored.blocks[1].reasonPruned, true)
  assert.equal(data.jobs, 0)
  assert.equal(JSON.stringify(data.messages), original)
  assert.equal(data.session.metadata?.unrelated, "keep")
})

test("Delete is a standalone mode, separate from whole-tool deletion", () => {
  const deletion = toggleMode({ kind: "summary", mode: "compact" }, 6)
  assert.deepEqual(deletion, { kind: "delete" })
  assert.deepEqual(selectedModes(deletion), [6])
  assert.deepEqual(toggleMode(deletion, 0), { kind: "prune", reasoning: true })
  assert.deepEqual(toggleMode(deletion, 4), { kind: "summary", mode: "compact" })
  assert.deepEqual(selectedModes(toggleMode(deletion, 3)), [0, 3])
})
