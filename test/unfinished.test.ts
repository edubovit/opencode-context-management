import { applySummary } from "./fixtures.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import { readPolicy, turns } from "../src/context.ts"
import { setupController as setup } from "./controller-fixture.ts"

test("idle unfinished historical turns can be pruned and compacted without changing raw history", async (t) => {
  const { data, controller } = await setup(t)
  const assistant = data.messages[1].info
  assert.ok(assistant.role === "assistant")
  assistant.finish = "tool-calls"
  assistant.time.completed = undefined
  const original = structuredClone(data.messages)
  const ids = turns(data.messages)[0].sourceIDs
  assert.equal((await controller.load()).blocks[0].closed, false)
  await controller.prune(ids)
  const draft = await controller.summarize("brief", ids)
  assert.match(data.calls[0].text, /unfinished snapshot/)
  assert.match(data.calls[0].text, /do not invent missing responses, tool results/)
  await applySummary(controller, draft, "Partial work; final outcome was not recorded.")
  const block = (await controller.load()).blocks[0]
  assert.equal(block.kind, "brief")
  assert.equal(block.messages[1].info.role, "assistant")
  assert.deepEqual(data.messages, original)
  await controller.restoreRanges([ids])
  assert.equal((await controller.load()).blocks[0].closed, false)
})

test("user-only turns get a distinct synthetic summary response and restore exactly", async (t) => {
  const { data, controller } = await setup(t)
  data.messages = data.messages.slice(0, 1)
  const original = structuredClone(data.messages)
  const ids = [data.messages[0].info.id]
  const draft = await controller.summarize("brief", ids)
  await applySummary(controller, draft, "The user asked a question; no response was recorded.")
  const block = (await controller.load()).blocks[0]
  assert.deepEqual(block.sourceIDs, ids)
  assert.deepEqual(block.messages.map((message) => message.info.role), ["user", "assistant"])
  assert.notEqual(block.messages[0].info.id, block.messages[1].info.id)
  assert.equal(readPolicy(data.session).version, 13)
  assert.deepEqual(data.messages, original)
  await controller.restoreRanges([ids])
  assert.deepEqual((await controller.load()).blocks[0].messages, original)
})

test("unfinished selection does not bypass busy or stale-source checks", async (t) => {
  const { data, controller } = await setup(t)
  data.messages = data.messages.slice(0, 1)
  const ids = [data.messages[0].info.id]
  data.idle = false
  await assert.rejects(controller.summarize("brief", ids), /idle/)
  assert.equal(data.calls.length, 0)
  data.idle = true
  const draft = await controller.summarize("brief", ids)
  data.messages[0].parts = []
  await assert.rejects(applySummary(controller, draft, "Stale summary"), /changed/)
  assert.equal(readPolicy(data.session).operations.length, 0)
})
