import { test } from "node:test"
import assert from "node:assert/strict"
import { settings, KEY } from "../src/config.ts"
import { chars, pruneText, spills, spillPreview } from "../src/text.ts"
import { append, blockMessages, emptyPolicy, hash, historyHash, nativeActive, operation, project, readPolicy, replacementTokens, select, serialize, turns } from "../src/context.ts"
import { distribution, snapshot } from "../src/snapshot.ts"
import { generateSummary, summaryPrompt } from "../src/summarize.ts"
import { legacyCursor, messages, pruneRule, session } from "./fixtures.ts"

test("settings validate configurable budgets and model pairing", () => {
  assert.equal(settings().spill.maxBytes, 51200)
  assert.throws(() => settings({ prune: { threshold: 1000 } }), /below/)
  assert.throws(() => settings({ spill: { headShare: 2 } }), /between/)
  assert.throws(() => settings({ summarizer: { modelID: "alone" } }), /both/)
  assert.throws(() => settings({ madeUp: 1 }), /Unknown/)
})

test("fingerprints ignore JSON object key ordering across HTTP/schema boundaries", () => {
  assert.equal(hash({ a: 1, b: { c: 2, d: 3 } }), hash({ b: { d: 3, c: 2 }, a: 1 }))
})

test("manual pruning has strict character threshold, both ends, Unicode and link", () => {
  const rule = { threshold: 8000, head: 2000, tail: 2000 }
  assert.equal(pruneText("😀".repeat(8000), rule), "😀".repeat(8000))
  const result = pruneText("😀".repeat(8001), rule, "/output.txt")
  assert.ok(result.startsWith("😀".repeat(2000)))
  assert.ok(result.includes("4001 characters omitted"))
  assert.ok(result.includes("😀".repeat(2000) + "\n\n[Full output: /output.txt]"))
  assert.equal(chars("a😀b"), 3)
})

test("spill threshold is either bytes or lines, preview preserves both ends", () => {
  const limits = settings().spill
  assert.equal(spills("x".repeat(51200), limits), false)
  assert.equal(spills("x".repeat(51201), limits), true)
  assert.equal(spills(Array(2000).fill("x").join("\n"), limits), false)
  assert.equal(spills(Array(2001).fill("x").join("\n"), limits), true)
  const preview = spillPreview("HEAD" + "😀".repeat(15000) + "TAIL", limits, "/full")
  assert.ok(preview.startsWith("HEAD"))
  assert.ok(preview.includes("TAIL\n\n[Full output: /full]"))
  assert.ok(!preview.includes("�"))
  assert.ok(Buffer.byteLength(preview) < 51500)
})

test("prune projection changes only chosen outputs, not originals, inputs or skills outside range", () => {
  const raw = messages()
  const original = structuredClone(raw)
  const all = turns(raw)
  const op = operation("tool-prune", select(all, 0, 0), pruneRule())
  const policy = append(emptyPolicy("ses_test"), op)
  const projected = blockMessages(project(raw, policy))
  assert.deepEqual(raw, original)
  const before = original[1].parts[0]
  const after = projected[1].parts[0]
  assert.ok(before.type === "tool" && after.type === "tool")
  assert.deepEqual(after.state.input, before.state.input)
  assert.deepEqual(projected.slice(2), original.slice(2))
  assert.deepEqual(projected[1].parts.slice(1), original[1].parts.slice(1))
  assert.ok(serialize(projected).includes("middle omitted"))
  const again = operation("tool-prune", select(project(raw, policy), 0, 0), pruneRule())
  assert.deepEqual(blockMessages(project(raw, append(policy, again))), projected)
})

test("tool-prune preserves provider metadata exactly, including absent metadata", () => {
  for (const metadata of [undefined, {}, { openai: { itemId: "fc_fixture" } }, { providerExecuted: true, anthropic: { signature: "fixture-signature" } }]) {
    const raw = messages()
    const original = raw[1].parts[0]
    assert.ok(original.type === "tool")
    if (metadata !== undefined) original.metadata = structuredClone(metadata)
    const op = operation("tool-prune", select(turns(raw), 0, 0), pruneRule())
    const projected = blockMessages(project(raw, append(emptyPolicy("ses_test"), op)))
    const result = projected[1].parts[0]
    assert.ok(result.type === "tool" && result.state.status === "completed")
    assert.ok(result.state.output.includes("middle omitted"))
    assert.deepEqual(result.metadata, original.metadata, "Pruning bookkeeping must not enter provider metadata")
    assert.equal(Object.hasOwn(result, "metadata"), Object.hasOwn(original, "metadata"))
  }
})

test("error and interrupted-result pruning preserve provider metadata", () => {
  for (const interrupted of [false, true]) {
    const raw = messages()
    const original = raw[1].parts[0]
    assert.ok(original.type === "tool")
    original.metadata = { openai: { itemId: "fc_error_fixture" } }
    original.state = {
      status: "error", input: { keep: "original" }, error: interrupted ? "Interrupted" : "E42!".repeat(3000),
      metadata: interrupted ? { interrupted: true, output: "INT_23 ".repeat(2000) } : {}, time: { start: 1, end: 2 },
    }
    const op = operation("tool-prune", select(turns(raw), 0, 0), pruneRule())
    const result = blockMessages(project(raw, append(emptyPolicy("ses_test"), op)))[1].parts[0]
    assert.ok(result.type === "tool" && result.state.status === "error")
    assert.deepEqual(result.metadata, original.metadata)
    assert.deepEqual(result.state.input, original.state.input)
    assert.ok(String(interrupted ? result.state.metadata?.output : result.state.error).includes("middle omitted"))
  }
})

test("identical repeated pruning is idempotent even when its notice exceeds the configured threshold", () => {
  const raw = messages()
  const rule = { threshold: 30, head: 5, tail: 5 }
  const first = operation("tool-prune", select(turns(raw), 0, 0), rule)
  const policy = append(emptyPolicy("ses_test"), first)
  const once = project(raw, policy)
  const again = operation("tool-prune", select(once, 0, 0), rule)
  assert.deepEqual(project(raw, append(policy, again)), once)
  const part = once[0].messages[1].parts[0]
  assert.ok(part.type === "tool" && part.state.status === "completed")
  assert.ok(chars(part.state.output) > rule.threshold)
  assert.equal(part.metadata, undefined)
})

test("old dependent-operation fingerprints replay without forwarding legacy pruning markers", () => {
  const raw = messages()
  const rule = { threshold: 8000, head: 2000, tail: 2000 }
  const first = operation("tool-prune", select(turns(raw), 0, 0), rule)
  let policy = append(emptyPolicy("ses_test"), first)
  const legacy = project(raw, policy)
  const legacyTool = legacy[0].messages[1].parts[0]
  assert.ok(legacyTool.type === "tool")
  legacyTool.metadata = { ...legacyTool.metadata, [KEY]: hash(rule) }
  const olderSummary = { ...operation("compact", select(legacy, 0, 0)), summary: "Summary saved by the old plugin" }
  assert.equal(project(raw, append(policy, olderSummary))[0].kind, "compact")
  const secondRule = { threshold: 2000, head: 500, tail: 500 }
  const olderSecond = operation("tool-prune", select(legacy, 0, 1), secondRule)
  policy = append(policy, olderSecond)
  const projected = project(raw, policy)
  for (const block of projected) for (const message of block.messages) for (const part of message.parts)
    if (part.type === "tool") assert.equal(part.metadata?.[KEY], undefined)
  const newerSummary = { ...operation("compact", select(projected, 0, 1)), summary: "Mixed old/new operation chain" }
  assert.equal(project(raw, append(policy, newerSummary))[0].kind, "compact")
  const broken = structuredClone(policy)
  broken.operations[1].beforeHash = "incorrect-source-fingerprint"
  assert.throws(() => project(raw, broken), /content changed/)
  const changedRaw = structuredClone(raw)
  const changedTool = changedRaw[1].parts[0]
  assert.ok(changedTool.type === "tool")
  changedTool.state.input = { changed: "must not bypass source checks" }
  assert.throws(() => project(changedRaw, policy), /content changed/)
})

test("summary blocks merge with summaries/turns and legacy saved cursors replay the exact view", () => {
  const raw = messages()
  const first = { ...operation("compact", select(turns(raw), 0, 0)), summary: "Learned fact A." }
  let state = append(emptyPolicy("ses_test"), first)
  const second = { ...operation("brief", select(project(raw, state), 1, 1)), summary: "Brief fact B." }
  state = append(state, second)
  const before = project(raw, state)
  const merged = { ...operation("compact", select(before, 0, 2)), summary: "Learned fact A; brief B; newest C." }
  state = append(state, merged)
  const effective = project(raw, state)
  assert.equal(effective.length, 1)
  assert.equal(effective[0].kind, "compact")
  assert.equal(effective[0].sourceIDs.length, 6)
  assert.deepEqual(project(raw, legacyCursor(state, -1)), before)
  assert.deepEqual(project(raw, legacyCursor(legacyCursor(state, -1), 1)), effective)
  assert.ok(!blockMessages(effective).some((m) => m.info.role === "assistant" && m.info.summary))
})

test("stale ranges fail; forked metadata does not apply; unfinished turns remain selectable", () => {
  const raw = messages()
  const state = append(emptyPolicy("ses_test"), operation("tool-prune", select(turns(raw), 0, 0), pruneRule()))
  raw[0].parts = []
  assert.throws(() => project(raw, state), /content changed/)
  const fork = { ...session("ses_fork"), metadata: { [KEY]: state } }
  assert.equal(readPolicy(fork).cursor, 0)
  const original = messages()
  original.pop()
  assert.equal(select(turns(original), 2, 2)[0].closed, false)
})

test("native pruned results are represented by placeholders, not resurrected", () => {
  const raw = messages()
  const p = raw[1].parts[0]
  assert.ok(p.type === "tool" && p.state.status === "completed")
  p.state.time.compacted = 100
  assert.ok(serialize(nativeActive(raw)).includes("Old tool result content cleared"))
  assert.ok(p.state.output.includes("HEAD"))
})

test("pruning covers skill text and interrupted tool output without touching inputs or attachments", () => {
  const raw = messages()
  const error = raw[1].parts[0]
  assert.ok(error.type === "tool")
  error.state = { status: "error", input: { large: "retain".repeat(4000) }, error: "Interrupted", metadata: { interrupted: true, output: "INT_23 ".repeat(2000) }, time: { start: 1, end: 2 } }
  const skill = raw[3].parts[0]
  assert.ok(skill.type === "tool" && skill.state.status === "completed")
  skill.state.attachments = [{ type: "file", id: "file", sessionID: "ses_test", messageID: "msg_1_a", mime: "image/png", url: "data:image/png;base64,AA==" }]
  const op = operation("tool-prune", turns(raw), pruneRule())
  const projected = blockMessages(project(raw, append(emptyPolicy("ses_test"), op)))
  const nextError = projected[1].parts[0]
  assert.ok(nextError.type === "tool" && nextError.state.status === "error")
  assert.deepEqual(nextError.state.input, error.state.input)
  assert.equal(nextError.state.error, "Interrupted")
  assert.ok(String(nextError.state.metadata?.output).includes("middle omitted"))
  const nextSkill = projected[3].parts[0]
  assert.ok(nextSkill.type === "tool" && nextSkill.state.status === "completed")
  assert.ok(nextSkill.state.output.includes("middle omitted"))
  assert.deepEqual(nextSkill.state.attachments, skill.state.attachments)
})

test("whole effective session marked; one revision maximum; second oversized output accepted", async () => {
  const all = turns(messages())
  const selected = select(all, 1, 1)
  const op = operation("compact", selected)
  const prompt = summaryPrompt(op, all)
  assert.ok(prompt.includes("Question 0"))
  assert.ok(prompt.includes("Question 2"))
  assert.ok(prompt.indexOf(`<selected_range_${op.id}>`) < prompt.indexOf("Question 1"))
  const calls: string[] = []
  const result = await generateSummary(op, all, selected, async (text) => { calls.push(text); return "long".repeat(10000) })
  assert.equal(calls.length, 2)
  assert.equal(result.attempts, 2)
  assert.ok(replacementTokens(result.operation, selected) > op.beforeTokens! / 2)
  assert.ok(calls[1].includes("previous summary"))
  assert.ok(!calls[1].includes("<selected_range_"))
})

test("brief does not retry for size, empty summary is not accepted", async () => {
  const all = turns(messages())
  const op = operation("brief", all)
  let calls = 0
  const result = await generateSummary(op, all, all, async () => { calls++; return "x".repeat(40000) })
  assert.equal(calls, 1)
  assert.equal(result.attempts, 1)
  await assert.rejects(generateSummary(op, all, all, async () => " "), /empty/)
})

test("distribution is disjoint; missing capture is explicit; export preserves effective view", () => {
  const blocks = turns(messages())
  const runtime = { sessionID: "ses_test", time: 1, system: ["abc<available_skills>xyz</available_skills>"], tools: [], warnings: [] }
  const counts = distribution(blocks, runtime, undefined, "characters")
  assert.equal(counts.counts.systemPrompts, 3)
  assert.equal(counts.counts.advertisedSkills, chars("<available_skills>xyz</available_skills>"))
  assert.ok(counts.counts.loadedSkills > 10000)
  assert.equal(counts.total, Object.values(counts.counts).reduce((a, b) => a + b, 0))
  const dump = snapshot("ses_test", "1.18.32", blocks, emptyPolicy("ses_test"))
  assert.equal(dump.runtime, null)
  assert.ok(dump.warnings.some((w) => w.includes("unavailable")))
  assert.equal(dump.historyHash, historyHash(blockMessages(blocks)))
})
