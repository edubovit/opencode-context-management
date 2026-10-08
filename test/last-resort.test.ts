import { test } from "node:test"
import assert from "node:assert/strict"
import { LastResort, lastResortRange, splitText } from "../src/last-resort.ts"
import { append, blockMessages, emptyPolicy, historyHash, operation, project, readPolicy, serialize, turns } from "../src/context.ts"
import { fixtureHost, messages } from "./fixtures.ts"
import { FALLBACK_BASIS, tokenCount } from "../src/tokens.ts"
import { contentTokens } from "../src/metrics.ts"
import { settings, KEY } from "../src/config.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { transcriptView } from "../src/v2/normalize.ts"
import { projectRequest } from "../src/v2/projection.ts"
import { Message } from "@opencode/ai"

test("last-resort tail configuration is strict, defaults to 20000, and permits zero", () => {
  assert.equal(settings().autocompaction.lastResortKeepTokens, 20000)
  assert.equal(settings({ autocompaction: { lastResortKeepTokens: 0 } }).autocompaction.lastResortKeepTokens, 0)
  for (const value of [-1, 1.5, "20000", null, Infinity, NaN]) assert.throws(() => settings({ autocompaction: { lastResortKeepTokens: value } }), /integer/)
})

test("last resort selects the largest prefix, retaining whole messages and tool pairs", () => {
  const raw = messages()
  const blocks = turns(raw)
  const last = contentTokens(raw.slice(-1))
  for (const keep of [1, last, last + 1]) {
    const range = lastResortRange(blocks, keep, FALLBACK_BASIS)
    assert.ok(contentTokens(blockMessages(range.tail)) >= keep)
    assert.ok(contentTokens(blockMessages(range.tail).slice(1)) < keep)
    assert.deepEqual(blockMessages([...range.selected, ...range.tail]), raw)
    const tools = blockMessages(range.tail).flatMap((m) => m.parts.filter((p) => p.type === "tool"))
    assert.equal(tools.at(-1)?.callID, "call_2")
  }
  assert.equal(lastResortRange(blocks, 0, FALLBACK_BASIS).tail.length, 0)
  assert.throws(() => lastResortRange(blocks, contentTokens(raw), FALLBACK_BASIS), /no eligible prefix/)
})

test("saved summaries remain indivisible at the exempt-tail boundary", () => {
  const raw = messages()
  const initial = turns(raw)
  const op = { ...operation("compact", initial.slice(1)), summary: "Keep this entire summary" }
  const blocks = project(raw, append(emptyPolicy("ses_test"), op))
  const range = lastResortRange(blocks, 1, FALLBACK_BASIS)
  assert.deepEqual(range.tail, [blocks[1]])
  assert.deepEqual(range.selected, [blocks[0]])
})

test("default tail preserves at least 20000 local tokens inside one unfinished turn", () => {
  const source = messages("ses_test", 8)
  const raw = [source[0], ...source.filter((message) => message.info.role === "assistant")]
  const range = lastResortRange(turns(raw), settings().autocompaction.lastResortKeepTokens, FALLBACK_BASIS)
  assert.ok(range.selected.length > 0)
  assert.ok(contentTokens(blockMessages(range.tail)) >= 20000)
  assert.ok(contentTokens(blockMessages(range.tail).slice(1)) < 20000)
  assert.deepEqual(blockMessages([...range.selected, ...range.tail]), raw)
})

test("repeated partial-turn checkpoints and nested expansion retain exact source boundaries", () => {
  const source = messages("ses_test", 6)
  const raw = [source[0], ...source.filter((message) => message.info.role === "assistant")]
  const first = raw.slice(0, 3)
  const selected = lastResortRange(turns(first), 1000, FALLBACK_BASIS).selected
  let policy = append(emptyPolicy("ses_test"), { ...operation("compact", selected), checkpoint: true, summary: "First unfinished snapshot" })
  const second = lastResortRange(project(raw, policy), 1000, FALLBACK_BASIS).selected
  policy = append(policy, { ...operation("compact", second), checkpoint: true, summary: "Updated unfinished snapshot" })
  const compacted = project(raw, policy)
  assert.equal(compacted[0].previous?.[0].kind, "compact")
  const layer = append(policy, operation("expand", [compacted[0]]))
  const expanded = project(raw, layer)
  assert.equal(expanded[0].messages[1].parts[0].type, "text")
  const original = project(raw, append(layer, operation("expand", [expanded[0]])))
  assert.equal(historyHash(blockMessages(original)), historyHash(raw))
  const stale = structuredClone(raw)
  stale[0].parts = []
  assert.throws(() => project(stale, policy), /content changed/)
})

test("active-prefix checkpoint replays after tool continuation, nesting, revision and expansion", () => {
  const { session, native, canonical } = nativeFixture()
  const raw = transcriptView(session, native)
  const active = raw.filter((m) => m.info.kind !== "idle" && m.info.kind !== "system")
  const earlier = { ...operation("prune-reason", turns(active).slice(0, 1)) }
  let policy = append(emptyPolicy(session.id), earlier)
  const range = lastResortRange(project(active, policy), 1, FALLBACK_BASIS)
  const checkpoint = { ...operation("compact", range.selected), checkpoint: true as const, summary: "Unfinished task: preserve ROOT_FACT and continue validation" }
  policy = append(policy, checkpoint)
  assert.equal(policy.version, 8)
  assert.equal(readPolicy({ id: session.id, nativeVersion: 2, metadata: { [KEY]: policy } }), policy)
  const output = projectRequest(native, raw, canonical, policy)
  assert.equal(output.at(-1), canonical.at(-1))
  const next = { ...structuredClone(native.find((m) => m.type === "assistant")!), id: "msg_continuation" }
  native.push(next)
  const continued = Message.make({ id: next.id, role: "assistant", content: "New work after checkpoint" })
  const newer = transcriptView(session, native)
  assert.deepEqual(projectRequest(native, newer, [...canonical, continued], policy).slice(0, -1), output)
  const blocks = project(newer.filter((m) => !["idle", "system"].includes(m.info.kind!)), policy)
  assert.equal(blocks.at(-1)?.sourceIDs.at(-1), next.id)
  const revised = { ...operation("revise", [blocks[0]]), targetID: checkpoint.id, summary: "Edited checkpoint facts" }
  policy = append(policy, revised)
  const modified = project(active, policy)
  const expanded = append(policy, operation("expand", [modified[0]]))
  const restored = project(active, expanded)
  assert.deepEqual(projectRequest(native, newer, [...canonical, continued], expanded), projectRequest(native, newer, [...canonical, continued], append(emptyPolicy(session.id), earlier)))
  assert.equal(historyHash(blockMessages(restored)), historyHash(blockMessages(project(active, append(emptyPolicy(session.id), earlier)))))
  assert.ok(!serialize(blockMessages(restored)).includes("REASON_0"))
  assert.throws(() => readPolicy({ id: session.id, metadata: { [KEY]: { ...policy, version: 7 } } }), /checkpoint/)
})

test("chunking preserves all Unicode text; bounded last-resort jobs are separate and cleaned", async () => {
  const text = "🧭漢字 café facts\n".repeat(1500)
  const chunks = splitText(text, 200, FALLBACK_BASIS)
  assert.equal(chunks.join(""), text)
  assert.ok(chunks.every((chunk) => tokenCount(chunk) <= 200 && !/[\uD800-\uDBFF]$/.test(chunk)))
  const { data, host } = fixtureHost()
  data.model.limit = { context: 9000, input: 7000, output: 2000 }
  const worker = new LastResort(host, data.session.id, settings())
  const answer = await worker.summarize(turns(data.messages), { providerID: "test", modelID: "model" })
  assert.ok(answer)
  assert.ok(data.calls.length > 1)
  assert.equal(data.calls.length, data.jobs)
  assert.equal(data.jobs, data.removed.length)
  assert.ok(data.calls.every((call) => call.text.includes("LAST-RESORT PREFIX SUMMARY")))
  await worker.dispose()
})
