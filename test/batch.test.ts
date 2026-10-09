import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SummaryBatch } from "../src/batch.ts"
import { Controller } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { readPolicy, turns } from "../src/context.ts"
import { Storage } from "../src/storage.ts"
import { fixtureHost, messages } from "./fixtures.ts"

async function setup(t: { after(fn: () => Promise<void>): void }, count = 5) {
  const directory = await mkdtemp(path.join(tmpdir(), "cm-batch-"))
  const { host, data } = fixtureHost()
  data.messages = messages(data.session.id, count)
  const storage = new Storage(directory, directory)
  const controller = new Controller(host, data.session.id, settings(), storage)
  const batch = new SummaryBatch(controller)
  t.after(async () => { await batch.dispose(); await controller.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { host, data, storage, controller, batch, ranges: turns(data.messages).filter((_block, index) => index % 2 === 0).map((block) => block.sourceIDs) }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("Timed out waiting for concurrent jobs")
}

test("five disjoint ranges generate concurrently from the same full frozen context and apply in one metadata write", async (t) => {
  const { host, data, batch, controller, ranges } = await setup(t, 9)
  data.model.limit = { context: 100, input: 50, output: 50 }
  const original = structuredClone(data.messages)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started: string[] = []
  const generate = host.generate
  host.generate = async (...args) => { started.push(args[2]); await gate; return generate(...args) }
  let writes = 0
  const update = host.update
  host.update = async (...args) => { writes++; await update(...args) }
  await batch.start("brief", ranges)
  const pending = batch.generate()
  await until(() => started.length === 5)
  assert.equal(writes, 0)
  for (const prompt of started) for (let i = 0; i < 9; i++) assert.equal(prompt.split(`Question ${i}`).length, 2)
  assert.equal(new Set(data.conversations.keys()).size, 5)
  await assert.rejects(batch.apply(), /Wait/)
  release()
  await pending
  batch.entries[0].text += " MANUAL_KEEP"
  await batch.apply()
  assert.equal(writes, 1)
  assert.equal(readPolicy(data.session).operations.length, 5)
  assert.ok(readPolicy(data.session).operations[0].summary?.includes("MANUAL_KEEP"))
  assert.deepEqual(data.messages, original)
  const loaded = await controller.load()
  assert.deepEqual(loaded.blocks.map((block) => block.kind), ["brief", "turn", "brief", "turn", "brief", "turn", "brief", "turn", "brief"])
  assert.equal(data.removed.length, 5)
})

test("partial failures keep successful edits and retry only the failed range against the original snapshot", async (t) => {
  const { host, data, storage, batch, ranges } = await setup(t, 3)
  await storage.saveCapture({ sessionID: data.session.id, time: 1, system: ["FROZEN_RUNTIME"], warnings: [] })
  const generate = host.generate
  const prompts: string[] = []
  let fail = true
  host.generate = async (...args) => {
    prompts.push(args[2])
    const target = args[2].split(/<selected_range_[^>]+>/)[1]?.split("</selected_range_")[0]
    if (fail && target?.includes("Question 2")) throw new Error("Fixture failure")
    return generate(...args)
  }
  await batch.start("brief", ranges)
  await batch.generate()
  assert.deepEqual(batch.entries.map((entry) => entry.status), ["ready", "error"])
  const firstJob = batch.entries[0].draft!.jobID
  batch.entries[0].text = "USER_REVIEW_EDIT_ONLY"
  await assert.rejects(batch.apply(), /Every range/)
  assert.equal(readPolicy(data.session).operations.length, 0)
  await storage.saveCapture({ sessionID: data.session.id, time: 2, system: ["LATER_RUNTIME"], warnings: [] })
  fail = false
  await batch.retry(1)
  assert.equal(prompts.length, 3)
  assert.match(prompts[2], /FROZEN_RUNTIME/)
  assert.doesNotMatch(prompts[2], /LATER_RUNTIME|USER_REVIEW_EDIT_ONLY/)
  assert.equal(batch.entries[0].draft!.jobID, firstJob)
  assert.equal(batch.entries[0].text, "USER_REVIEW_EDIT_ONLY")
  await batch.apply()
  assert.equal(readPolicy(data.session).operations.length, 2)
})

test("batch revisions stay range-local and stale/busy state blocks whole-batch application", async (t) => {
  const { data, batch, ranges } = await setup(t, 3)
  await batch.start("brief", ranges)
  await batch.generate()
  const other = batch.entries[1].text
  const firstJob = batch.entries[0].draft!.jobID
  batch.entries[0].text = "Edited first range"
  batch.entries[0].request = "Keep the manual edit"
  await batch.refine(0)
  assert.equal(data.calls.at(-1)!.sessionID, firstJob)
  assert.match(data.calls.at(-1)!.text, /Edited first range/)
  assert.equal(batch.entries[1].text, other)
  data.idle = false
  await assert.rejects(batch.apply(), /idle/)
  data.idle = true
  data.messages[0].parts = []
  await assert.rejects(batch.apply(), /changed/)
  assert.equal(readPolicy(data.session).operations.length, 0)
})

test("cancel while helper creation is pending prevents every model call and cleans owned sessions", async (t) => {
  const { host, data, batch, ranges } = await setup(t, 3)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const create = host.createJob
  host.createJob = async () => { const id = await create(); await gate; return id }
  await batch.start("brief", ranges)
  const pending = batch.generate()
  await until(() => data.jobs === 2)
  await batch.cancel()
  release()
  await pending
  assert.equal(data.calls.length, 0)
  assert.equal(data.removed.length, 2)
  assert.ok(batch.entries.every((entry) => entry.status === "error"))
})

test("disjoint pruning and summary expansion leave gaps untouched and commit each action with one write", async (t) => {
  const { host, data, controller, batch, ranges } = await setup(t, 5)
  let writes = 0
  const update = host.update
  host.update = async (...args) => { writes++; await update(...args) }
  await controller.pruneRanges(ranges)
  assert.equal(writes, 1)
  const pruned = await controller.load()
  assert.deepEqual(pruned.blocks[1].messages, data.messages.slice(2, 4))
  assert.deepEqual(pruned.blocks[3].messages, data.messages.slice(6, 8))
  await batch.start("brief", ranges)
  await batch.generate()
  await batch.apply()
  const restore = await controller.prepareRestoreRanges("expand", ranges)
  assert.equal(restore.summaries, 3)
  assert.equal(writes, 2)
  await controller.applyOperations(restore.operations, restore)
  assert.equal(writes, 3)
  assert.deepEqual((await controller.load()).blocks, pruned.blocks)
})

test("closing a running batch ignores late replies, waits for cleanup, and never writes main context", async (t) => {
  const { host, data, batch, ranges } = await setup(t, 3)
  const generate = host.generate
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started = 0
  host.generate = async (...args) => { started++; await gate; return generate(...args) }
  await batch.start("brief", ranges)
  const pending = batch.generate()
  await until(() => started === 2)
  const closing = batch.dispose()
  await until(() => data.aborted.length === 2)
  release()
  await pending
  await closing
  assert.equal(data.removed.length, 2)
  assert.equal(readPolicy(data.session).operations.length, 0)
  await assert.rejects(batch.start("brief", ranges), /closed/)
})

test("cleanup failure after applying a batch warns without duplicating application", async (t) => {
  const { host, data, batch, ranges } = await setup(t, 3)
  await batch.start("brief", ranges)
  await batch.generate()
  const remove = host.remove
  host.remove = async () => { throw new Error("Fixture cleanup failure") }
  assert.match((await batch.apply())!, /Batch applied/)
  assert.equal(readPolicy(data.session).operations.length, 2)
  await assert.rejects(batch.apply(), /already been applied/)
  host.remove = remove
  await batch.discard()
  assert.equal(data.removed.length, 2)
})

test("each parallel compact range gets its own one-retry review conversation", async (t) => {
  const { data, batch, ranges } = await setup(t, 3)
  await batch.start("compact", ranges)
  await batch.generate()
  assert.equal(data.jobs, 2)
  assert.equal(data.calls.length, 4)
  for (const entry of batch.entries) {
    assert.equal(entry.draft?.attempts, 2)
    const calls = data.calls.filter((call) => call.sessionID === entry.draft!.jobID)
    assert.equal(calls.length, 2)
    assert.match(calls[0].text, /Question 0/)
    assert.match(calls[0].text, /Question 2/)
    assert.match(calls[1].text, /too short/)
    assert.doesNotMatch(calls[1].text, /<selected_range_/)
  }
  assert.equal(readPolicy(data.session).operations.length, 0)
})

test("cancelling during batch preflight marks ranges retryable without creating helpers", async (t) => {
  const { host, data, batch, ranges } = await setup(t, 3)
  await batch.start("brief", ranges)
  const idle = host.idle
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let checking = false
  host.idle = async () => { checking = true; await gate; return true }
  const pending = batch.generate()
  const rejected = assert.rejects(pending, /cancelled/)
  await until(() => checking)
  await batch.cancel()
  release()
  await rejected
  assert.equal(data.jobs, 0)
  assert.ok(batch.entries.every((entry) => entry.status === "error"))
  host.idle = idle
  await batch.retry(0)
  assert.equal(batch.entries[0].status, "ready")
  assert.equal(data.calls.length, 1)
})

test("cancelling after generation but before metadata commit blocks automatic acceptance", async (t) => {
  const { host, data, batch, ranges } = await setup(t, 3)
  await batch.start("brief", ranges)
  await batch.generate()
  assert.equal(batch.ready, true)
  const get = host.session
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let checked = false
  host.session = async (...args) => { checked = true; await gate; return get(...args) }
  const pending = batch.apply()
  const rejected = assert.rejects(pending, /cancelled/)
  await until(() => checked)
  await batch.cancel()
  release()
  await rejected
  host.session = get
  assert.equal(readPolicy(data.session).operations.length, 0)
})
