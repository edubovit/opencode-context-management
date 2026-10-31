import { test } from "node:test"
import assert from "node:assert/strict"
import { Autocompaction, perTurnRange } from "../src/autocompaction.ts"
import { AUTO_KEY } from "../src/auto-state.ts"
import { settings } from "../src/config.ts"
import { turns, readPolicy, type Block } from "../src/context.ts"
import { contentTokens } from "../src/metrics.ts"
import { FALLBACK_BASIS } from "../src/tokens.ts"
import { messages } from "./fixtures.ts"
import { setupController } from "./controller-fixture.ts"

function sizedTurns(sizes: number[]) {
  const raw = messages("ses_test", sizes.length)
  for (const [index, size] of sizes.entries()) {
    raw[index * 2].parts = [{ ...raw[index * 2].parts[0], type: "text", text: " x".repeat(size) }]
    raw[index * 2 + 1].parts = []
  }
  const blocks = turns(raw)
  assert.deepEqual(blocks.map(block => contentTokens(block.messages, FALLBACK_BASIS)), sizes)
  return { raw, blocks }
}

test("per-turn range is the oldest contiguous range strictly above its local token minimum", () => {
  const { blocks } = sizedTurns([4000, 5000, 2000, 6000, 7000])
  const select = (minimum: number) => perTurnRange(blocks, new Set(), minimum, FALLBACK_BASIS)
  assert.deepEqual(select(10000), blocks.slice(0, 3))
  assert.deepEqual(select(9000), blocks.slice(0, 3))
  assert.deepEqual(select(8999), blocks.slice(0, 2))
  assert.deepEqual(select(0), blocks.slice(0, 1))
  assert.equal(select(24000), undefined)
  assert.deepEqual(perTurnRange(blocks, new Set(blocks.slice(0, 3).map(block => block.sourceIDs[0])), 10000, FALLBACK_BASIS), blocks.slice(3))
})

test("summaries, deleted and attempted blocks separate eligible ranges", () => {
  const { blocks } = sizedTurns([4000, 5000, 2000, 6000, 7000])
  for (const kind of ["compact", "brief", "deleted"] as const) {
    const divided: Block[] = blocks.map((block, index) => index === 1 ? { ...block, kind } : block)
    assert.deepEqual(perTurnRange(divided, new Set(), 10000, FALLBACK_BASIS), divided.slice(2))
    assert.equal(perTurnRange(divided.slice(0, 4), new Set(), 10000, FALLBACK_BASIS), undefined)
  }
  assert.deepEqual(perTurnRange(blocks, new Set([blocks[1].sourceIDs[0]]), 10000, FALLBACK_BASIS), blocks.slice(2))
})

test("ordinary continuation blocks cannot start a range but can extend a valid one", () => {
  const { blocks } = sizedTurns([4000, 8000, 6000])
  const continuation: Block = { ...blocks[1], messages: [{ ...blocks[1].messages[1], parts: blocks[1].messages[0].parts }], closed: true }
  assert.equal(perTurnRange([continuation], new Set(), 1000, FALLBACK_BASIS), undefined)
  assert.deepEqual(perTurnRange([continuation, blocks[2]], new Set(), 1000, FALLBACK_BASIS), [blocks[2]])
  assert.deepEqual(perTurnRange([blocks[0], continuation, blocks[2]], new Set(), 10000, FALLBACK_BASIS), [blocks[0], continuation])
})

test("range sizing uses effective content and the consuming tokenizer, with no hidden-layer or runtime allowance", () => {
  const { blocks } = sizedTurns([4000, 5000, 2000])
  const pruned = { ...blocks[0], messages: [], previous: [blocks[0]] }
  assert.equal(perTurnRange([pruned, ...blocks.slice(1)], new Set(), 10000, FALLBACK_BASIS), undefined)
  const invisible = structuredClone(blocks[0])
  const assistant = invisible.messages[1]
  if (assistant.info.role !== "assistant") throw new Error("Missing fixture assistant")
  assistant.info.omitReasoning = true
  assistant.parts = [{ ...invisible.messages[0].parts[0], type: "reasoning", text: " hidden".repeat(20000) }]
  assert.deepEqual(perTurnRange([invisible, blocks[1], blocks[2]], new Set(), 10000, FALLBACK_BASIS), [invisible, blocks[1], blocks[2]])
  const unicode = sizedTurns([1]).blocks[0]
  unicode.messages[0].parts = [{ ...unicode.messages[0].parts[0], type: "text", text: "世界😀" }]
  const o200k = contentTokens(unicode.messages, FALLBACK_BASIS)
  const cl100k = { ...FALLBACK_BASIS, encoding: "cl100k_base" as const }
  assert.ok(contentTokens(unicode.messages, cl100k) > o200k)
  assert.equal(perTurnRange([unicode], new Set(), o200k, FALLBACK_BASIS), undefined)
  assert.deepEqual(perTurnRange([unicode], new Set(), o200k, cl100k), [unicode])
})

for (const mode of ["AUTO_PER_TURN", "AUTO_SESSION"] as const) test(`${mode} uses its range policy and resumes the original request without touching the active turn`, async t => {
  const { host, data, storage } = await setupController(t, 6)
  const { raw, blocks } = sizedTurns([4000, 5000, 2000, 6000, 7000, 1000])
  data.messages = raw
  data.idle = false
  data.model.limit = { input: 50000, context: 100000, output: 10000 }
  data.session.metadata![AUTO_KEY] = { strategy: mode }
  const config = settings({ autocompaction: { headroom: 0 } })
  const auto = new Autocompaction(host, config, storage)
  t.after(() => auto.close())
  const before = structuredClone(raw)
  let resumed = 0
  await auto.beforeRequest(raw, { model: { providerID: "test", modelID: "model" }, protectedIDs: blocks.at(-1)!.sourceIDs,
    estimate: policy => policy.operations.length ? 40000 : 60000 }).then(() => { resumed++ })
  const policy = readPolicy(data.session)
  assert.equal(policy.operations.length, 1)
  assert.deepEqual(policy.operations[0].sourceIDs, blocks.slice(0, mode === "AUTO_PER_TURN" ? 3 : 5).flatMap(block => block.sourceIDs))
  assert.equal(policy.operations[0].checkpoint, undefined)
  assert.equal(data.jobs, 1)
  assert.equal(resumed, 1)
  assert.deepEqual(raw, before)
  assert.equal(auto.observe(data.session).pause, undefined)
})

for (const minimum of [0, 100000]) test(`AUTO_PER_TURN minimum ${minimum} preserves protected multi-input spans and prefix fallback`, async t => {
  const { host, data, storage } = await setupController(t, 6)
  const { raw, blocks } = sizedTurns([4000, 5000, 2000, 6000, 7000, 1000])
  data.messages = raw
  data.idle = false
  data.model.limit = { input: 50000, context: 100000, output: 10000 }
  const auto = new Autocompaction(host, settings({ autocompaction: { headroom: 0, minRangeTokens: minimum } }), storage)
  t.after(() => auto.close())
  await auto.beforeRequest(raw, { model: { providerID: "test", modelID: "model" }, protectedIDs: blocks.slice(4).flatMap(block => block.sourceIDs),
    estimate: policy => policy.operations.length ? 40000 : 60000 })
  const policy = readPolicy(data.session)
  assert.equal(policy.operations.length, 1)
  assert.deepEqual(policy.operations[0].sourceIDs, blocks.slice(0, minimum === 0 ? 1 : 4).flatMap(block => block.sourceIDs))
  assert.equal(policy.operations[0].checkpoint, undefined)
  assert.equal(data.jobs, 1)
})

test("a nonreducing batch marks every member attempted before selecting the next sufficient range", async t => {
  const { host, data, storage } = await setupController(t, 6)
  const { raw, blocks } = sizedTurns([4000, 5000, 2000, 6000, 7000, 1000])
  data.messages = raw
  data.idle = false
  data.model.limit = { input: 50000, context: 100000, output: 10000 }
  const seen: string[][] = []
  const auto = new Autocompaction(host, settings({ autocompaction: { headroom: 0 } }), storage)
  t.after(() => auto.close())
  await auto.beforeRequest(raw, { model: { providerID: "test", modelID: "model" }, protectedIDs: blocks.at(-1)!.sourceIDs,
    estimate: policy => {
      const ids = policy.operations.at(-1)?.sourceIDs
      if (ids) seen.push(ids)
      return ids?.[0] === blocks[3].sourceIDs[0] ? 40000 : 60000
    } })
  const expected = [blocks.slice(0, 3).flatMap(block => block.sourceIDs), blocks.slice(3, 5).flatMap(block => block.sourceIDs)]
  assert.deepEqual(seen[0], expected[0])
  assert.ok(seen.slice(1).every(ids => JSON.stringify(ids) === JSON.stringify(expected[1])))
  assert.deepEqual(readPolicy(data.session).operations.map(op => op.sourceIDs), [expected[1]])
  assert.equal(data.jobs, 2)
  assert.equal(data.jobs, data.removed.length)
})
