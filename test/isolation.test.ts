import { test } from "node:test"
import assert from "node:assert/strict"
import { operation, turns } from "../src/context.ts"
import { summaryPrompt } from "../src/summarize.ts"
import { Controller } from "../src/controller.ts"
import { SummaryBatch } from "../src/batch.ts"
import { settings } from "../src/config.ts"
import { selectedModes, toggleMode } from "../src/compaction.ts"
import { fixtureHost, messages } from "./fixtures.ts"

for (const mode of ["compact", "brief"] as const) for (const isolation of ["off", "head", "total"] as const) {
  test(`${mode}/${isolation} sends exactly the permitted background`, () => {
    const blocks = turns(messages())
    const prompt = summaryPrompt(operation(mode, [blocks[1]]), blocks, "PRIVATE_RUNTIME", isolation)
    assert.ok(prompt.includes("Question 1"))
    assert.equal(prompt.includes("Question 0"), isolation !== "total")
    assert.equal(prompt.includes("Question 2"), isolation === "off")
    assert.equal(prompt.includes("PRIVATE_RUNTIME"), isolation === "off")
    assert.equal(prompt.includes("<background_after_"), isolation === "off")
    assert.equal(prompt.includes("<background_before_"), isolation !== "total")
  })
}

test("isolated batches freeze scope across failed-job retries and automatic size review", async () => {
  const { host, data } = fixtureHost()
  const controller = new Controller(host, data.session.id, settings(), { capture: async () => ({ sessionID: data.session.id, time: 1, warnings: [], system: ["PRIVATE_RUNTIME"] }), write: async () => "unused" })
  const loaded = await controller.load()
  const generate = host.generate
  let fail = true
  host.generate = async (...args) => { if (fail) { fail = false; throw new Error("Retry me") }; return generate(...args) }
  const batch = new SummaryBatch(controller)
  await batch.start("compact", [loaded.blocks[1].sourceIDs], undefined, "total")
  await batch.generate()
  assert.equal(batch.ready, false)
  await batch.generate()
  assert.equal(batch.ready, true)
  assert.equal(batch.entries[0].draft?.attempts, 2)
  for (const call of data.calls) assert.doesNotMatch(call.text, /Question 0|Question 2|PRIVATE_RUNTIME/)
  assert.match(data.calls[0].text, /Question 1/)
  await batch.dispose()
  await controller.dispose()
})

for (const isolation of ["head", "total"] as const) test(`parallel ${isolation} summaries use each range's frozen boundary without sibling results`, async () => {
  const { host, data } = fixtureHost()
  data.responses = ["SIBLING_RESULT_ONE", "SIBLING_RESULT_TWO"]
  const controller = new Controller(host, data.session.id, settings(), { capture: async () => undefined, write: async () => "unused" })
  const loaded = await controller.load()
  const batch = new SummaryBatch(controller)
  await batch.start("brief", [loaded.blocks[0].sourceIDs, loaded.blocks[2].sourceIDs], undefined, isolation)
  await batch.generate()
  assert.equal(batch.ready, true)
  assert.equal(data.calls.length, 2)
  for (const call of data.calls) {
    const selected = /<selected_range_[^>]+>([\s\S]*?)<\/selected_range_/.exec(call.text)![1]
    assert.ok(!call.text.includes("SIBLING_RESULT_"))
    if (selected.includes("Question 0")) assert.ok(!call.text.includes("Question 1") && !call.text.includes("Question 2"))
    else {
      assert.ok(selected.includes("Question 2"))
      assert.equal(call.text.includes("Question 0"), isolation === "head")
      assert.equal(call.text.includes("Question 1"), isolation === "head")
    }
  }
  await batch.dispose()
  await controller.dispose()
})

test("isolation toggles are summary-only, exclusive, default-off and survive detailed/brief switches", () => {
  const initial = { kind: "summary" as const, mode: "compact" as const }
  assert.deepEqual(selectedModes(initial), [4])
  const head = toggleMode(initial, 7)
  assert.deepEqual(selectedModes(head), [4, 7])
  assert.deepEqual(selectedModes(toggleMode(head, 5)), [5, 7])
  const total = toggleMode(head, 8)
  assert.deepEqual(selectedModes(total), [4, 8])
  assert.deepEqual(selectedModes(toggleMode(total, 8)), [4])
  const prune = toggleMode(total, 0)
  assert.deepEqual(toggleMode(prune, 7), prune)
  const deletion = toggleMode(total, 6)
  assert.deepEqual(toggleMode(deletion, 8), deletion)
})
