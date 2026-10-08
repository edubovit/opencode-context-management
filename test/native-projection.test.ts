import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import { nativeFixture } from "./native-fixtures.ts"
import { sessionView, transcriptView } from "../src/v2/normalize.ts"
import { projectRequest, validateNativePolicy } from "../src/v2/projection.ts"
import { append, emptyPolicy, historyHash, nativeActive, operation, project, readPolicy } from "../src/context.ts"
import { KEY } from "../src/config.ts"
import { TOKENIZER_ID } from "../src/tokens.ts"
import { distribution } from "../src/metrics.ts"
import { toolText } from "../src/text.ts"

test("native normalization pins source identity, excludes unselectable controls, and retains user spans", () => {
  const { session, native } = nativeFixture()
  const raw = transcriptView(session, native)
  assert.equal(raw.length, native.length)
  const blocks = project(nativeActive(raw), emptyPolicy(session.id))
  assert.equal(blocks.length, 3)
  assert.ok(blocks.every((block) => block.closed))
  assert.deepEqual(blocks[0].sourceIDs, ["msg_u0", "msg_a0"])
  const changed = structuredClone(native)
  changed[0].metadata = { modified: true }
  assert.notEqual(historyHash(raw), historyHash(transcriptView(session, changed)))
  assert.equal(historyHash(raw), historyHash(transcriptView({ ...session, model: { providerID: "other", id: "other" } }, native)))
})

test("actual V2 ledger renders nested summaries, revisions and exact expansion around chronological system context", () => {
  const { session, native, canonical } = nativeFixture()
  const source = JSON.stringify({ native, canonical })
  const raw = transcriptView(session, native)
  let policy = emptyPolicy(session.id)
  const blocks = () => project(nativeActive(raw), policy)
  const rule = { unit: "tokens" as const, threshold: 200, head: 10, tail: 10, encoding: "o200k_base" as const, library: TOKENIZER_ID }
  policy = append(policy, { ...operation("tool-prune", [blocks()[0]], rule), pruneReason: true })
  const pruned = projectRequest(native, raw, canonical, policy)
  const first = { ...operation("compact", blocks().slice(0, 2)), summary: "FIRST_SUMMARY" }
  policy = append(policy, first)
  let projected = projectRequest(native, raw, canonical, policy)
  assert.ok(JSON.stringify(projected).includes("FIRST_SUMMARY"))
  assert.ok(JSON.stringify(projected).includes("PRESERVE_CHRONOLOGICAL_INSTRUCTION"))
  assert.ok(!JSON.stringify(projected).includes("QUESTION_0"))
  const revision = { ...operation("revise", [blocks()[0]]), targetID: first.id, summary: "REVISED_SUMMARY" }
  policy = append(policy, revision)
  const revised = projectRequest(native, raw, canonical, policy)
  assert.ok(!JSON.stringify(revised).includes("FIRST_SUMMARY"))
  const outer = { ...operation("brief", blocks()), summary: "OUTER_SUMMARY" }
  policy = append(policy, outer)
  policy = append(policy, operation("expand", blocks()))
  assert.deepEqual(projectRequest(native, raw, canonical, policy), revised)
  policy = append(policy, operation("expand", [blocks()[0]]))
  projected = projectRequest(native, raw, canonical, policy)
  assert.deepEqual(projected, pruned)
  assert.equal(JSON.stringify({ native, canonical }), source)
})

test("canonical projection preserves earlier hook redactions and keeps unselected gaps unchanged", () => {
  const { session, native, canonical } = nativeFixture()
  const raw = transcriptView(session, native)
  let policy = emptyPolicy(session.id)
  const blocks = project(nativeActive(raw), policy)
  policy = append(policy, { ...operation("brief", [blocks[0]]), summary: "ONE" })
  policy = append(policy, { ...operation("brief", [blocks[2]]), summary: "THREE" })
  const gap = canonical.find((message) => message.id === "msg_u1")!
  const result = projectRequest(native, raw, canonical, policy)
  assert.equal(result.find((message) => message.id === gap.id), gap)
  assert.ok(JSON.stringify(result).includes("QUESTION_1"))
  const redacted = canonical.map((message) => message.role === "tool" && message.content.some((part) => part.type === "tool-result" && part.id === "call_0") ? Message.tool({ id: "call_0", name: "fixture", result: { type: "text", value: "ALREADY_REDACTED" } }) : message)
  policy = append(emptyPolicy(session.id), operation("tool-prune", [blocks[0]], { threshold: 10, head: 1, tail: 1 }))
  assert.ok(!JSON.stringify(projectRequest(native, raw, redacted, policy)).includes("HEAD_0"))
})

test("source changes and native checkpoints fail before a V2 policy write", () => {
  const { session, native } = nativeFixture()
  const raw = transcriptView(session, native)
  const blocks = project(nativeActive(raw), emptyPolicy(session.id))
  const policy = append(emptyPolicy(session.id), operation("prune-reason", [blocks[0]]))
  const changed = structuredClone(native)
  changed[0].metadata = { changed: true }
  assert.throws(() => validateNativePolicy(changed, transcriptView(session, changed), policy), /content changed/)
  const checkpoint = { id: "msg_checkpoint", type: "compaction" as const, status: "completed" as const, reason: "manual" as const, summary: "native", recent: "", time: { created: 0 } }
  const prefixed = [checkpoint, ...native]
  const normalized = transcriptView(session, prefixed)
  const checkpointBlock = project(nativeActive(normalized), emptyPolicy(session.id))[0]
  const invalid = append(emptyPolicy(session.id), operation("prune-reason", [checkpointBlock]))
  assert.throws(() => validateNativePolicy(prefixed, normalized, invalid), /read-only/)
})

test("V2 accepts only native-format ledgers and refuses inherited/V1 state without resetting it", () => {
  const { session } = nativeFixture()
  const legacy = { ...emptyPolicy(session.id), version: 6 }
  assert.throws(() => readPolicy({ ...sessionView(session), metadata: { [KEY]: legacy } }), /V1 or inherited/)
  assert.equal(legacy.version, 6)
  assert.throws(() => readPolicy({ ...sessionView(session), metadata: { [KEY]: emptyPolicy("ses_parent") } }), /inherited/)
  assert.equal(readPolicy({ ...sessionView(session), metadata: { [KEY]: emptyPolicy(session.id) } }).version, 7)
})

test("background shell records intentionally omitted by the host do not block saved edits", () => {
  const { session, native, canonical } = nativeFixture()
  const shell = { id: "msg_shell", type: "shell" as const, shellID: "sh_fixture", command: "RAW_SHELL_COMMAND", status: "exited" as const, metadata: { background: true }, time: { created: 4, completed: 5 } }
  const completion = { id: "msg_completion", type: "synthetic" as const, text: "SHELL_COMPLETION", time: { created: 6 } }
  native.splice(3, 0, shell, completion)
  canonical.splice(4, 0, Message.make({ id: completion.id, role: "user", content: completion.text }))
  const raw = transcriptView(session, native)
  const original = JSON.stringify({ native, raw, canonical })
  const selected = project(nativeActive(raw), emptyPolicy(session.id)).slice(0, 1)
  for (const mode of ["prune-reason", "tool-prune", "tool-prune-all", "tool-delete"] as const) {
    const policy = append(emptyPolicy(session.id), { ...operation(mode, selected, { threshold: 200, head: 10, tail: 10 }), ...(mode === "tool-delete" ? { pruneReason: true as const } : {}) })
    const result = projectRequest(native, raw, canonical, policy)
    assert.ok(result.some((message) => message.id === completion.id))
    assert.ok(!JSON.stringify(result).includes("RAW_SHELL_COMMAND"))
    assert.ok(!result.some((message) => message.id === shell.id))
  }
  let policy = append(emptyPolicy(session.id), { ...operation("brief", selected), summary: "Saved shell completion facts" })
  const summarized = JSON.stringify(projectRequest(native, raw, canonical, policy))
  assert.ok(!summarized.includes("SHELL_COMPLETION"))
  assert.ok(summarized.includes("Saved shell completion facts"))
  policy = append(policy, operation("expand", project(nativeActive(raw), policy).slice(0, 1)))
  assert.deepEqual(projectRequest(native, raw, canonical, policy), canonical)
  assert.equal(JSON.stringify({ native, raw, canonical }), original)
})

test("missing foreground shells, completion messages, user/assistant messages and tool results still fail closed", () => {
  const { session, native, canonical } = nativeFixture()
  const check = (source: typeof native, incoming: typeof canonical) => {
    const raw = transcriptView(session, source)
    const policy = append(emptyPolicy(session.id), operation("prune-reason", project(nativeActive(raw), emptyPolicy(session.id)).slice(0, 1)))
    assert.throws(() => projectRequest(source, raw, incoming, policy), /absent from.*context/)
  }
  for (const background of [undefined, false, "true"]) {
    const shell = { id: "msg_shell", type: "shell" as const, shellID: "sh_fixture", command: "FOREGROUND", status: "exited" as const, ...(background === undefined ? {} : { metadata: { background } }), time: { created: 4 } }
    check([...native.slice(0, 3), shell, ...native.slice(3)], canonical)
  }
  check([...native.slice(0, 3), { id: "msg_completion", type: "synthetic", text: "COMPLETION", time: { created: 4 } }, ...native.slice(3)], canonical)
  for (const id of ["msg_u0", "msg_a0"]) check(native, canonical.filter((message) => message.id !== id))
  check(native, canonical.filter((message) => !(message.role === "tool" && message.content.some((part) => part.type === "tool-result" && part.id === "call_0"))))
})

test("native error attachments and interruption text remain visible until all-output pruning removes them", () => {
  const { session, native } = nativeFixture()
  const assistant = native.find((message) => message.type === "assistant")!
  assert.equal(assistant.type, "assistant")
  const tool = assistant.content.find((part) => part.type === "tool")!
  assert.equal(tool.type, "tool")
  tool.state = { status: "error", input: {}, error: { type: "tool.interrupted", message: "Terminal error" }, metadata: { interrupted: true, output: "not model-visible metadata" }, content: [{ type: "text", text: "Visible interrupted output" }, { type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" }] }
  const raw = transcriptView(session, native)
  const blocks = project(nativeActive(raw), emptyPolicy(session.id))
  assert.equal(distribution(blocks).attachments, 1)
  const part = blocks[0].messages.flatMap((message) => message.parts).find((part) => part.type === "tool")!
  assert.equal(part.type, "tool")
  assert.match(toolText(part), /Terminal error[\s\S]*Visible interrupted output/)
  const policy = append(emptyPolicy(session.id), operation("tool-prune-all", [blocks[0]]))
  const after = project(nativeActive(raw), policy)
  assert.equal(distribution(after).attachments, 0)
  assert.ok(!JSON.stringify(after[0]).includes("Visible interrupted output"))
  assert.ok(!JSON.stringify(after[0]).includes("not model-visible metadata"))
})

test("native textual attachments remain available to summaries while binary media stays descriptive", () => {
  const { session, native } = nativeFixture()
  const user = native[0]
  assert.equal(user.type, "user")
  user.files = [
    { mime: "text/plain", data: Buffer.from("IMPORTANT_FILE_FACT 漢字").toString("base64"), source: { type: "uri", uri: "file:///fixture/readme.txt" } },
    { mime: "image/png", data: "AA==", name: "diagram.png", source: { type: "inline" } },
  ]
  const raw = transcriptView(session, native)
  assert.ok(raw[0].parts.some((part) => part.type === "text" && part.text.includes("IMPORTANT_FILE_FACT 漢字") && part.text.includes("readme.txt")))
  assert.equal(raw[0].parts.filter((part) => part.type === "file").length, 1)
  assert.equal(distribution(project(nativeActive(raw), emptyPolicy(session.id))).attachments, 1)
})
