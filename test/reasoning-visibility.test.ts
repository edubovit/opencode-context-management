import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import type { SessionMessageInfo } from "@opencode/client"
import { activeMessages, append, blockMessages, emptyPolicy, historyHash, operation, project, readPolicy, serialize, type Policy } from "../src/context.ts"
import { KEY } from "../src/config.ts"
import { contentTokens, distribution } from "../src/metrics.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest, validateNativePolicy } from "../src/projection.ts"
import { snapshot } from "../src/snapshot.ts"
import { summaryPrompt } from "../src/summarize.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { pruneRule } from "./fixtures.ts"

function fixture(interrupted = false, text = "") {
  const { session, native, canonical } = nativeFixture()
  const retry = native.find(message => message.type === "assistant")!
  const failed: Extract<SessionMessageInfo, { type: "assistant" }> = {
    id: "msg_failed_attempt", type: "assistant", agent: "build", model: session.model!,
    time: { created: 2, completed: 3 }, finish: "stop",
    ...(interrupted ? {} : { error: { type: "provider.transport", message: "Synthetic failure" } }),
    native: { opaque: "FAILED_MESSAGE_NATIVE" },
    content: [
      { type: "reasoning", text: "HIDDEN_REASONING_COMPLETED", time: { created: 2, completed: 3 }, native: { proof: "HIDDEN_REASONING_NATIVE" } },
      { type: "reasoning", text: "HIDDEN_REASONING_ATTEMPT", time: { created: 2, ...(interrupted ? {} : { completed: 3 }) } },
      { type: "text", text, native: { proof: "text-proof" } },
    ],
  }
  native.splice(native.indexOf(retry), 0, failed)
  if (text) canonical.splice(canonical.findIndex(message => message.id === retry.id), 0,
    Message.make({ id: failed.id, role: "assistant", content: [{ type: "text", text: "CURRENT_HOOK_REDACTED_TEXT" }] }))
  const raw = transcriptView(session, native)
  const empty = emptyPolicy(session.id)
  return { session, native, canonical, raw, empty, failed }
}

for (const interrupted of [false, true]) {
  const label = interrupted ? "interrupted" : "failed"
  test(`${label} reasoning-only host omission permits pruning, deletion, summary and restoration without resurrection`, () => {
    const { session, native, canonical, raw, empty, failed } = fixture(interrupted)
    const before = JSON.stringify({ native, raw, canonical })
    const blocks = project(activeMessages(raw), empty)
    for (const mode of ["prune-reason", "tool-prune-all", "tool-delete", "compact", "delete"] as const) {
      const op = { ...operation(mode, [blocks[0]]), ...(mode === "tool-delete" ? { pruneReason: true as const } : {}), ...(mode === "compact" ? { summary: "Approved summary" } : {}) }
      const policy = append(empty, op)
      validateNativePolicy(native, raw, policy)
      const output = projectRequest(native, raw, canonical, policy)
      assert.ok(!output.some(message => message.id === failed.id))
      assert.doesNotMatch(JSON.stringify(output), /HIDDEN_REASONING|FAILED_MESSAGE_NATIVE/)
      const reduced = project(activeMessages(raw), policy)
      const restored = append(policy, operation("expand", [reduced[0]]))
      const reloaded = readPolicy({ id: session.id, metadata: { [KEY]: JSON.parse(JSON.stringify(restored)) } })
      const nextIncoming = canonical.map(message => message.id === "msg_a0"
        ? Message.make({ ...message, content: message.content.map(part => part.type === "text" ? { ...part, text: "NEXT_REQUEST_REDACTION" } : part) }) : message)
      assert.deepEqual(projectRequest(native, raw, nextIncoming, reloaded), nextIncoming)
      assert.deepEqual(blockMessages(project(activeMessages(raw), restored)), activeMessages(raw))
    }
    assert.equal(JSON.stringify({ native, raw, canonical }), before)
  })

  test(`${label} mixed text uses current hook content and visible accounting without changing replay preimages`, () => {
    const { session, native, canonical, raw, empty, failed } = fixture(interrupted, "ORIGINAL_VISIBLE_TEXT")
    const before = JSON.stringify({ native, raw, canonical })
    const blocks = project(activeMessages(raw), empty)
    const normalized = raw.find(message => message.info.id === failed.id)!
    assert.equal(normalized.info.role === "assistant" && normalized.info.retainReasoning, true)
    assert.equal(normalized.parts.filter(part => part.type === "reasoning").length, 2)
    const withoutHidden = raw.map(message => message === normalized ? { ...message, parts: message.parts.filter(part => part.type !== "reasoning") } : message)
    assert.equal(contentTokens(raw), contentTokens(withoutHidden))
    assert.deepEqual(distribution(blocks, undefined, undefined, "characters"), distribution(project(activeMessages(withoutHidden), empty), undefined, undefined, "characters"))
    assert.doesNotMatch(serialize(raw), /HIDDEN_REASONING/)
    assert.match(serialize(raw), /ORIGINAL_VISIBLE_TEXT/)
    assert.doesNotMatch(summaryPrompt(operation("compact", [blocks[0]]), blocks), /HIDDEN_REASONING/)
    const policy = append(empty, operation("prune-reason", [blocks[0]]))
    const reduced = project(activeMessages(raw), policy)
    const output = projectRequest(native, raw, canonical, policy)
    assert.equal(output.find(message => message.id === failed.id), canonical.find(message => message.id === failed.id))
    assert.ok(output.find(message => message.id === "msg_a0")!.content.every(part => part.type !== "reasoning"))
    const exported = snapshot(session.id, "2.2.5", reduced, policy)
    assert.doesNotMatch(JSON.stringify(exported), /HIDDEN_REASONING/)
    assert.equal(exported.historyHash, historyHash(blockMessages(reduced)))
    const visible = exported.blocks[0].messages.find(message => message.info.id === failed.id)!
    assert.equal(visible.info.sourceHash, normalized.info.sourceHash)
    assert.deepEqual(visible.parts, normalized.parts.filter(part => part.type !== "reasoning"))
    assert.match(JSON.stringify(reduced[0].pruning), /HIDDEN_REASONING/)
    assert.equal(JSON.stringify({ native, raw, canonical }), before)
  })
}

test("empty omitted messages retain identity and source fingerprints in effective exports", () => {
  const { session, raw, empty, failed } = fixture()
  const exported = snapshot(session.id, "2.2.5", project(activeMessages(raw), empty), empty)
  const message = exported.blocks[0].messages.find(message => message.info.id === failed.id)!
  assert.equal(message.info.sourceHash, raw.find(message => message.info.id === failed.id)!.info.sourceHash)
  assert.ok(message.parts.every(part => part.type === "text" && part.text === ""))
  assert.doesNotMatch(JSON.stringify(exported), /HIDDEN_REASONING/)
})

test("native omissions do not excuse missing nonempty text, tools, successful reasoning or opaque empty reasoning", () => {
  for (const kind of ["text", "whitespace", "tool", "successful", "opaque"] as const) {
    const { session, native, canonical, failed, empty } = fixture()
    if (kind === "text" || kind === "whitespace") failed.content.push({ type: "text", text: kind === "text" ? "MISSING_VISIBLE_TEXT" : " " })
    if (kind === "tool") failed.content.push({ type: "tool", id: "missing_call", name: "fixture", time: { created: 2, completed: 3 }, state: { status: "completed", input: {}, content: [{ type: "text", text: "MISSING_RESULT" }] } })
    if (kind === "successful" || kind === "opaque") {
      delete failed.error
      if (kind === "opaque") failed.content = [{ type: "reasoning", text: "", native: { signature: "OPAQUE_SIGNED_REASONING" } }]
    }
    const raw = transcriptView(session, native)
    const policy = append(empty, operation("prune-reason", [project(activeMessages(raw), empty)[0]]))
    assert.throws(() => projectRequest(native, raw, canonical, policy), /absent/, kind)
  }
})

test("only an actual native omission may exempt a missing source, and source drift still fails", () => {
  const { session, native, canonical, raw, failed, empty } = fixture()
  const policy = append(empty, operation("prune-reason", [project(activeMessages(raw), empty)[0]]))
  assert.throws(() => projectRequest(native.filter(message => message !== failed), raw, canonical, policy), /absent/)
  for (const change of [
    (message: typeof failed) => { message.content[0].native = { proof: "CHANGED_NATIVE" } },
    (message: typeof failed) => { const part = message.content[1]; assert.equal(part.type, "reasoning"); part.text = "CHANGED_REASONING" },
    (message: typeof failed) => { delete message.error },
  ]) {
    const changed = structuredClone(native)
    const source = changed.find(message => message.id === failed.id)!
    assert.equal(source.type, "assistant")
    if (source.type !== "assistant") throw new Error("Missing fixture assistant")
    change(source)
    assert.throws(() => projectRequest(changed, transcriptView(session, changed), canonical, policy), /content changed/)
  }
})

test("legacy nested prune, summary, expansion and restoration retain exact replay hashes", () => {
  const { session, native, canonical, raw, empty } = fixture(true)
  const legacyRaw = structuredClone(raw)
  for (const message of legacyRaw) if (message.info.role === "assistant") Reflect.deleteProperty(message.info, "omitReasoning")
  const before = JSON.stringify({ native, raw, canonical })
  assert.equal(historyHash(legacyRaw), historyHash(raw))
  assert.match(serialize(legacyRaw), /HIDDEN_REASONING/)
  let policy: Policy = empty
  const phases = ["tool-prune", "compact", "compact", "expand", "expand", "expand"] as const
  for (const [index, mode] of phases.entries()) {
    const legacy = project(activeMessages(legacyRaw), policy)
    const selected = mode === "compact" && index === 2 ? legacy.slice(0, 2) : [legacy[0]]
    const op = { ...operation(mode, selected, mode === "tool-prune" ? { ...pruneRule({ threshold: 100, head: 15, tail: 15 }), library: "gpt-tokenizer@4.0.0" } : undefined),
      ...(mode === "tool-prune" ? { pruneReason: true as const } : {}), ...(mode === "compact" ? { summary: `Saved summary ${index}` } : {}) }
    policy = append(policy, op)
    const saved = JSON.stringify(policy)
    const current = project(activeMessages(raw), policy)
    assert.equal(historyHash(blockMessages(current)), historyHash(blockMessages(project(activeMessages(legacyRaw), policy))))
    assert.equal(JSON.stringify(policy), saved)
    assert.doesNotMatch(summaryPrompt(operation("compact", current), current), /HIDDEN_REASONING/)
    assert.doesNotMatch(JSON.stringify(snapshot(session.id, "2.2.5", current, policy)), /HIDDEN_REASONING/)
    assert.doesNotMatch(JSON.stringify(projectRequest(native, raw, canonical, policy)), /HIDDEN_REASONING/)
  }
  const reloaded = readPolicy({ id: session.id, metadata: { [KEY]: JSON.parse(JSON.stringify(policy)) } })
  assert.deepEqual(blockMessages(project(activeMessages(raw), reloaded)), activeMessages(raw))
  assert.deepEqual(projectRequest(native, raw, canonical, reloaded), canonical)
  assert.equal(JSON.stringify({ native, raw, canonical }), before)
})
