import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import { activeMessages, append, blockMessages, emptyPolicy, operation, project, readPolicy, splitAfter, type Operation } from "../src/context.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest } from "../src/projection.ts"
import { snapshot } from "../src/snapshot.ts"
import { summaryPrompt } from "../src/summarize.ts"
import { KEY } from "../src/config.ts"
import { policySchema } from "../src/ledger.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { pruneRule } from "./fixtures.ts"

function fixture() {
  const { session, native, canonical } = nativeFixture()
  const raw = transcriptView(session, native)
  let policy = emptyPolicy(session.id)
  const blocks = () => project(activeMessages(raw), policy)
  return {
    session, native, canonical, raw, blocks,
    get policy() { return policy },
    save: (op: Operation) => { policy = append(policy, op) },
    request: (incoming = canonical) => projectRequest(native, raw, incoming, policy),
  }
}

for (const mode of ["tool-prune", "tool-prune-all", "tool-delete", "prune-reason"] as const) {
  test(`${mode} restores its exact prior view and canonical request without changing stored history`, () => {
    const f = fixture()
    const original = JSON.stringify({ native: f.native, raw: f.raw, canonical: f.canonical })
    const before = f.blocks()
    f.save({ ...operation(mode, [before[0]], mode === "tool-prune" ? pruneRule({ threshold: 200, head: 10, tail: 10 }) : undefined), ...(mode === "tool-delete" ? { pruneReason: true as const } : {}) })
    assert.notDeepEqual(f.request(), f.canonical)
    const restore = operation("expand", [f.blocks()[0]])
    f.save(restore)
    assert.deepEqual(f.blocks(), before)
    assert.deepEqual(f.request(), f.canonical)
    assert.equal(JSON.stringify({ native: f.native, raw: f.raw, canonical: f.canonical }), original)
    assert.deepEqual(readPolicy({ id: f.session.id, metadata: { [KEY]: JSON.parse(JSON.stringify(f.policy)) } }), f.policy)
  })
}

test("reasoning and tool pruning form independent layers; combined actions restore together", () => {
  const f = fixture()
  const initial = f.blocks()
  f.save(operation("prune-reason", [f.blocks()[0]]))
  const reasonOnly = f.blocks()
  const reasonRequest = f.request()
  f.save(operation("tool-prune", [f.blocks()[0]], pruneRule({ threshold: 200, head: 10, tail: 10 })))
  const large = f.blocks()
  const largeRequest = f.request()
  f.save({ ...operation("tool-prune-all", [f.blocks()[0]]), pruneReason: true })
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.blocks(), large)
  assert.deepEqual(f.request(), largeRequest)
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.blocks(), reasonOnly)
  assert.deepEqual(f.request(), reasonRequest)
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.blocks(), initial)
  assert.deepEqual(f.request(), f.canonical)
  f.save({ ...operation("tool-prune-all", [f.blocks()[0]]), pruneReason: true })
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.blocks(), initial)
})

test("restoring a subset of a wider prune leaves other turns and later edits alone", () => {
  const f = fixture()
  const before = f.blocks()
  f.save(operation("tool-prune-all", f.blocks()))
  f.save(operation("prune-reason", [f.blocks()[2]]))
  const pruned = f.blocks()
  f.save(operation("expand", [f.blocks()[1]]))
  const restored = f.blocks()
  assert.deepEqual(restored[0], pruned[0])
  assert.deepEqual(restored[1], before[1])
  assert.deepEqual(restored[2], pruned[2])
  const wire = JSON.stringify(f.request())
  assert.ok(wire.includes("HEAD_1") && !wire.includes("HEAD_0") && !wire.includes("HEAD_2"))
  assert.ok(!wire.includes("REASON_2"))
})

test("nested summary expansion keeps hidden pruning until a later explicit restore", () => {
  const f = fixture()
  f.save(operation("tool-prune-all", [f.blocks()[0]]))
  f.save({ ...operation("compact", [f.blocks()[0]]), summary: "Inner summary" })
  f.save({ ...operation("tool-delete", [f.blocks()[1]]), pruneReason: true })
  f.save({ ...operation("brief", f.blocks().slice(0, 2)), summary: "Outer summary" })
  f.save(operation("expand", [f.blocks()[0]]))
  assert.equal(f.blocks()[0].kind, "compact")
  f.save(operation("expand", f.blocks().slice(0, 2)))
  let wire = JSON.stringify(f.request())
  assert.ok(!wire.includes("HEAD_0") && wire.includes("HEAD_1"))
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.request(), f.canonical)
})

test("restoring a checkpoint-split tail cannot resurrect its summarized prefix", () => {
  const f = fixture()
  f.save({ ...operation("tool-delete", [f.blocks()[0]]), pruneReason: true })
  const prefix = splitAfter(f.blocks(), "msg_u0").slice(0, 1)
  f.save({ ...operation("compact", prefix), checkpoint: true, summary: "PREFIX_ONLY" })
  assert.deepEqual(f.blocks()[1].sourceIDs, ["msg_a0"])
  f.save(operation("expand", [f.blocks()[1]]))
  assert.ok(JSON.stringify(f.request()).includes("PREFIX_ONLY"))
  assert.ok(JSON.stringify(f.request()).includes("HEAD_0"))
  assert.ok(!JSON.stringify(f.request()).includes("QUESTION_0"))
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.request(), f.canonical)
  assert.equal(blockMessages(f.blocks()).filter((message) => message.info.id === "msg_a0").length, 1)
})

test("restoration uses the current incoming canonical context, preserving earlier hook redactions", () => {
  const f = fixture()
  f.save({ ...operation("tool-prune-all", [f.blocks()[0]]), pruneReason: true })
  f.save(operation("expand", [f.blocks()[0]]))
  const redacted = f.canonical.map((message) => message.role === "tool" && message.content.some((part) => part.type === "tool-result" && part.id === "call_0")
    ? Message.tool({ id: "call_0", name: "fixture", result: { type: "text", value: "ALREADY_REDACTED" } })
    : message.role === "assistant" ? Message.make({ ...message, content: message.content.filter((part) => part.type !== "reasoning") }) : message)
  assert.deepEqual(f.request(redacted), redacted)
  assert.ok(!JSON.stringify(f.request(redacted)).includes("HEAD_0"))
})

test("hidden pre-pruning content never enters effective exports or helper prompts", () => {
  const f = fixture()
  f.save({ ...operation("tool-delete", [f.blocks()[0]]), pruneReason: true })
  const blocks = f.blocks()
  const exported = snapshot(f.session.id, "2.0.26", blocks, f.policy)
  assert.ok(!JSON.stringify(exported).includes("HEAD_0"))
  assert.ok(!JSON.stringify(exported).includes("REASON_0"))
  assert.ok(!summaryPrompt(operation("brief", blocks), blocks).includes("HEAD_0"))
})

test("no-op pruning does not add phantom restoration layers", () => {
  const f = fixture()
  const first = operation("prune-reason", [f.blocks()[0]])
  f.save(first)
  f.save(operation("prune-reason", [f.blocks()[0]]))
  const restored = operation("expand", [f.blocks()[0]])
  assert.equal(restored.pruneTargets?.[0].operationID, first.id)
  f.save(restored)
  assert.deepEqual(f.request(), f.canonical)
  assert.throws(() => project(activeMessages(f.raw), append(f.policy, { ...operation("expand", [f.blocks()[0]]), pruneTargets: restored.pruneTargets })), /pruning layer/)
})

test("older, foreign, hidden and overlapping restore targets fail without rewriting state", () => {
  const f = fixture()
  const first = operation("prune-reason", [f.blocks()[0]])
  f.save(first)
  f.save(operation("tool-prune-all", [f.blocks()[0]]))
  const restore = operation("expand", [f.blocks()[0]])
  const target = restore.pruneTargets![0]
  for (const operationID of [first.id, "missing"]) {
    const policy = append(f.policy, { ...restore, pruneTargets: [{ ...target, operationID }] })
    assert.throws(() => project(activeMessages(f.raw), policy), /pruning layer/)
    assert.throws(() => projectRequest(f.native, f.raw, f.canonical, policy), /pruning layer|layer unavailable/)
  }
  for (const pruneTargets of [[target, target], [{ ...target, sourceIDs: ["outside"] }], [{ ...target, before: { messages: f.raw } }]]) {
    assert.equal(policySchema.safeParse({ ...append(f.policy, restore), operations: [...f.policy.operations, { ...restore, pruneTargets }] }).success, false)
  }
  f.save({ ...operation("brief", [f.blocks()[0]]), summary: "Hidden prune" })
  const hidden = { ...operation("expand", [f.blocks()[0]]), pruneTargets: [target] }
  assert.throws(() => project(activeMessages(f.raw), append(f.policy, hidden)), /pruning layer/)
})

test("format-9 pruning gains restoration without rewriting old operations or old summary expansion", () => {
  const f = fixture()
  f.save(operation("tool-prune-all", f.blocks()))
  f.save({ ...operation("brief", [f.blocks()[0]]), summary: "Old summary" })
  const { pruneTargets: _targets, ...oldExpansion } = operation("expand", f.blocks())
  f.save(oldExpansion)
  const saved = JSON.parse(JSON.stringify({ ...f.policy, version: 9 }))
  const original = JSON.stringify(saved)
  const policy = readPolicy({ id: f.session.id, metadata: { [KEY]: saved } })
  const blocks = project(activeMessages(f.raw), policy)
  assert.ok(blocks.every((block) => block.pruning?.length === 1))
  assert.ok(!JSON.stringify(projectRequest(f.native, f.raw, f.canonical, policy)).includes("HEAD_"))
  const next = append(policy, operation("expand", blocks))
  assert.equal(next.version, 10)
  assert.deepEqual(next.operations.slice(0, policy.operations.length), saved.operations)
  assert.equal(JSON.stringify(saved), original)
  assert.deepEqual(projectRequest(f.native, f.raw, f.canonical, next), f.canonical)
  assert.throws(() => readPolicy({ id: f.session.id, metadata: { [KEY]: { ...next, version: 9 } } }), /format 10/)
})

test("error content, attachments and metadata restore exactly after all-output pruning", () => {
  const f = fixture()
  const assistant = f.native.find((message) => message.type === "assistant")!
  assert.equal(assistant.type, "assistant")
  const tool = assistant.content.find((part) => part.type === "tool")!
  assert.equal(tool.type, "tool")
  tool.state = { status: "error", input: { keep: "input" }, error: { type: "tool.interrupted", message: "ERROR_PRIVATE" }, content: [{ type: "text", text: "INTERRUPTED_PRIVATE" }, { type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" }], metadata: { output: "METADATA_PRIVATE", interrupted: true } }
  f.raw.splice(0, f.raw.length, ...transcriptView(f.session, f.native))
  const index = f.canonical.findIndex((message) => message.role === "tool")
  f.canonical[index] = Message.tool({ id: tool.id, name: tool.name, result: { type: "error", value: { error: tool.state.error, content: tool.state.content } }, providerMetadata: { fixture: { proof: "current-result-state" } } })
  f.save(operation("tool-prune-all", [f.blocks()[0]]))
  assert.ok(!JSON.stringify(f.request()).includes("PRIVATE"))
  assert.ok(!JSON.stringify(snapshot(f.session.id, "2.0.26", f.blocks(), f.policy)).includes("PRIVATE"))
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.request(), f.canonical)
})

test("whole-call restoration recreates dropped empty assistant and result wrappers", () => {
  const f = fixture()
  const assistant = f.native.find((message) => message.type === "assistant")!
  assert.equal(assistant.type, "assistant")
  assistant.content = assistant.content.filter((part) => part.type !== "text")
  f.raw.splice(0, f.raw.length, ...transcriptView(f.session, f.native))
  const index = f.canonical.findIndex((message) => message.id === assistant.id)
  f.canonical[index] = Message.make({ ...f.canonical[index], content: f.canonical[index].content.filter((part) => part.type !== "text") })
  f.save({ ...operation("tool-delete", [f.blocks()[0]]), pruneReason: true })
  assert.ok(!f.request().some((message) => message.id === assistant.id))
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.request(), f.canonical)
})
