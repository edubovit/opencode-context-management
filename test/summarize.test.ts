import { test } from "node:test"
import assert from "node:assert/strict"
import { operation, select } from "../src/context.ts"
import { generateSummary, refinementPrompt, summaryPrompt, SUMMARIZER_SYSTEM } from "../src/summarize.ts"
import { scopeFixture } from "./scope-fixture.ts"

test("brief puts only the exact selected block in the selected payload, after all background", () => {
  for (const position of ["first", "middle", "last"] as const) {
    const fixture = scopeFixture(position)
    const prompt = summaryPrompt(fixture.op, fixture.blocks, fixture.runtime)
    const open = `<selected_range_${fixture.op.id}>`
    const close = `</selected_range_${fixture.op.id}>`
    const start = prompt.indexOf(open)
    const end = prompt.indexOf(close)
    assert.ok(start >= 0 && end > start)
    assert.equal(prompt.split(open).length, 2)
    const payload = prompt.slice(start + open.length, end)
    assert.match(payload, /help\.txt/)
    assert.match(payload, /--color/)
    assert.doesNotMatch(payload, /AtlasCluster|Kubernetes|MercuryLaunch|billing/)
    assert.ok(prompt.lastIndexOf("AtlasCluster") < start, "Unselected background must not trail the selected source")
    assert.ok(prompt.indexOf(`</runtime_background_${fixture.op.id}>`) < start)
    assert.ok(prompt.slice(end).includes("Only the selected range"))
    for (let i = 0; i < fixture.blocks.length; i++) {
      if (i === fixture.target) continue
      assert.equal(prompt.split(`Background request ${i}:`).length, 2, "Preserve each background block exactly once")
    }
    assert.ok(prompt.includes(`Selected effective blocks: ${fixture.target + 1}–${fixture.target + 1} of ${fixture.blocks.length}`))
  }
})

test("range prompt rejects missing, noncontiguous or reversed boundaries before calling a model", async () => {
  const { blocks } = scopeFixture()
  for (const selected of [[blocks[0], blocks[2]], [blocks[2], blocks[0]]]) {
    const op = operation("brief", selected)
    await assert.rejects(generateSummary(op, blocks, selected, async () => { assert.fail("Model must not be called") }), /range/i)
  }
  const missing = { ...operation("brief", [blocks[0]]), sourceIDs: ["missing", "missing-end"] }
  assert.throws(() => summaryPrompt(missing, blocks), /range/i)
  assert.throws(() => summaryPrompt(operation("brief", []), blocks), /range/i)
})

test("the system contract and revision prompt forbid importing background-only facts", () => {
  assert.match(SUMMARIZER_SYSTEM, /selected range/i)
  assert.match(SUMMARIZER_SYSTEM, /background-only/i)
  const request = refinementPrompt("Human-edited draft", "Add detail")
  assert.match(request, /Human-edited draft/)
  assert.match(request, /background-only/i)
})

test("compact and full-range selections use the same explicit scope framing", () => {
  const { blocks, runtime } = scopeFixture()
  const selected = select(blocks, 0, blocks.length - 1)
  const op = operation("compact", selected)
  const prompt = summaryPrompt(op, blocks, runtime)
  assert.ok(prompt.includes(`<selected_range_${op.id}>`))
  assert.ok(prompt.includes("Selected effective blocks: 1–13 of 13"))
  assert.match(prompt, /detailed/i)
})
