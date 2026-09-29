import { test } from "node:test"
import assert from "node:assert/strict"
import { operation, replacementTokens, select, turns } from "../src/context.ts"
import { generateSummary, summaryPrompt } from "../src/summarize.ts"
import { messages } from "./fixtures.ts"

test("compact prompt favors preservation and treats 2x–20x as guidance, not an output quota", () => {
  const all = turns(messages())
  const prompt = summaryPrompt(operation("compact", [all[0]]), all)
  assert.match(prompt, /2x.*20x/)
  assert.match(prompt, /not a target or requirement/)
  assert.match(prompt, /information-poor|no useful information/)
  assert.match(prompt, /never pad|do not pad/i)
  assert.doesNotMatch(prompt, /Aim for no more than|locally measured token budget/)
})

test("compact band includes exactly 2x and 20x and retries only outside it", async () => {
  const all = turns(messages())
  const selected = select(all, 0, 0)
  const base = operation("compact", selected)
  const text = "Selected facts retained."
  const after = replacementTokens({ ...base, summary: text }, selected)
  for (const [before, attempts, direction] of [
    [after * 2 - 1, 2, "too long"], [after * 2, 1, ""], [after * 10, 1, ""],
    [after * 20, 1, ""], [after * 20 + 1, 2, "too short"],
  ] as const) {
    const calls: string[] = []
    const result = await generateSummary({ ...base, beforeTokens: before }, all, selected, async (prompt) => { calls.push(prompt); return text })
    assert.equal(result.attempts, attempts)
    assert.equal(calls.length, attempts)
    if (attempts === 1) continue
    assert.ok(calls[1].includes(direction))
    assert.ok(calls[1].includes(`Initial selected range size: ${before} tokens`))
    assert.ok(calls[1].includes(`Your complete replacement size: ${after} tokens`))
    assert.ok(calls[1].includes(`Reduction: x${(before / after).toFixed(2)}`))
    assert.match(calls[1], /not targets or requirements/)
    assert.match(calls[1], /selected_range/)
    assert.doesNotMatch(calls[1], /Question 2|<selected_range_/)
  }
})

test("second result is accepted even when it crosses to the opposite side of the compact band", async () => {
  const all = turns(messages())
  const selected = [all[0]]
  for (const responses of [["Brief.", "fact ".repeat(6000)], ["fact ".repeat(6000), "Brief."]]) {
    const expected = responses[1].trim()
    let calls = 0
    const result = await generateSummary(operation("compact", selected), all, selected, async () => responses[calls++])
    assert.equal(calls, 2)
    assert.equal(result.operation.summary, expected)
  }
})

test("brief never expands an overshort result and compact still rejects an empty retry", async () => {
  const all = turns(messages())
  const selected = [all[0]]
  let calls = 0
  const result = await generateSummary(operation("brief", selected), all, selected, async () => { calls++; return "Nothing useful." })
  assert.equal(calls, 1)
  assert.equal(result.attempts, 1)
  calls = 0
  await assert.rejects(generateSummary(operation("compact", selected), all, selected, async () => ++calls === 1 ? "Brief." : " "), /empty/)
  assert.equal(calls, 2)
})
