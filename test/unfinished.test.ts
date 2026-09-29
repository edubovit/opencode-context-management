import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Controller } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { readPolicy, turns } from "../src/context.ts"
import { Storage } from "../src/storage.ts"
import { fixtureHost } from "./fixtures.ts"

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-unfinished-"))
  const fixture = fixtureHost()
  const controller = new Controller(fixture.host, fixture.data.session.id, settings(), new Storage(dir, dir))
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { ...fixture, controller }
}

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
  await controller.apply(draft, "Partial work; final outcome was not recorded.")
  const block = (await controller.load()).blocks[0]
  assert.equal(block.kind, "brief")
  assert.equal(block.messages[1].info.role, "assistant")
  assert.deepEqual(data.messages, original)
  const expansion = await controller.prepareRestore("expand", ids)
  await controller.applyRestore(expansion)
  assert.equal((await controller.load()).blocks[0].closed, false)
})

test("user-only turns get a distinct synthetic summary response and restore exactly", async (t) => {
  const { data, controller } = await setup(t)
  data.messages = data.messages.slice(0, 1)
  const original = structuredClone(data.messages)
  const ids = [data.messages[0].info.id]
  const draft = await controller.summarize("brief", ids)
  await controller.apply(draft, "The user asked a question; no response was recorded.")
  const block = (await controller.load()).blocks[0]
  assert.deepEqual(block.sourceIDs, ids)
  assert.deepEqual(block.messages.map((message) => message.info.role), ["user", "assistant"])
  assert.notEqual(block.messages[0].info.id, block.messages[1].info.id)
  assert.equal(readPolicy(data.session).version, 5)
  assert.deepEqual(data.messages, original)
  const expansion = await controller.prepareRestore("expand", ids)
  await controller.applyRestore(expansion)
  assert.deepEqual((await controller.load()).blocks[0].messages, original)
  await controller.undo(-1)
  assert.equal((await controller.load()).blocks[0].kind, "brief")
  await controller.undo(-1)
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
  await assert.rejects(controller.apply(draft, "Stale summary"), /changed/)
  assert.equal(readPolicy(data.session).cursor, 0)
})
