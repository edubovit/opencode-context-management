import { test } from "node:test"
import assert from "node:assert/strict"
import { SummaryBatch } from "../src/batch.ts"
import { readPolicy, turns } from "../src/context.ts"
import { messages } from "./fixtures.ts"
import { setupController } from "./controller-fixture.ts"
import { deferred } from "./async.ts"
import { tokenCount } from "../src/tokens.ts"

async function setup(t: { after(fn: () => Promise<void>): void }, count = 5) {
  const { host, data, storage, controller } = await setupController(t, count)
  const batch = new SummaryBatch(controller)
  t.after(() => batch.dispose())
  return { host, data, storage, controller, batch, ranges: turns(data.messages).filter((_block, index) => index % 2 === 0).map((block) => block.sourceIDs) }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("Timed out waiting for concurrent jobs")
}

for (const action of ["start", "generate", "apply"] as const) test(`batch ${action} owns its lock before asynchronous preflight`, async (t) => {
  const { host, data, batch, ranges } = await setup(t, 1)
  if (action !== "start") await batch.start("brief", ranges)
  if (action === "apply") await batch.generate()
  const gate = deferred()
  const entered = deferred()
  const idle = host.idle
  host.idle = async (...args) => { entered.resolve(); await gate.promise; return idle(...args) }
  let writes = 0
  const update = host.update
  host.update = async (...args) => { writes++; return update(...args) }
  const run = () => action === "start" ? batch.start("brief", ranges) : action === "generate" ? batch.generate() : batch.apply()
  const first = run()
  await entered.promise
  const second = run().then(() => undefined, error => error)
  gate.resolve()
  await first
  assert.match(String(await second), /Wait for/)
  assert.equal(writes, action === "apply" ? 1 : 0)
  assert.equal(data.jobs, action === "start" ? 0 : 1)
})

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
  const generated = batch.entries.map(entry => entry.draft!.operation.summary)
  await batch.apply()
  assert.equal(writes, 1)
  assert.equal(readPolicy(data.session).operations.length, 5)
  assert.deepEqual(readPolicy(data.session).operations.map(op => op.summary), generated)
  assert.deepEqual(data.messages, original)
  const loaded = await controller.load()
  assert.deepEqual(loaded.blocks.map((block) => block.kind), ["brief", "turn", "brief", "turn", "brief", "turn", "brief", "turn", "brief"])
  assert.equal(data.removed.length, 5)
})

test("live batch progress counts helper output only and cannot settle or fail generation", async (t) => {
  const { host, data, controller, batch, ranges } = await setup(t, 1)
  const helper = { ...data.model, id: "helper" }
  host.models = async () => [data.model, helper]
  controller.config.tokenizer.overrides["test/helper"] = "cl100k_base"
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const generate = host.generate
  host.generate = async (...args) => { await gate; return generate(...args) }
  await batch.start("brief", ranges, { providerID: "test", modelID: "helper" })
  assert.equal(batch.snapshot!.tokenizer.encoding, "o200k_base")
  const pending = batch.generate()
  await until(() => data.jobs === 1)
  try {
    const history = messages("job_1", 1)
    history[0].parts = [{ ...history[0].parts[0], type: "text", text: "DO NOT COUNT INPUT" }]
    history[1].parts = [
      { ...history[0].parts[0], type: "text", text: "a😀" },
      { ...history[0].parts[0], type: "reasoning", text: "think" },
    ]
    data.conversations.set("job_1", history)
    await batch.pollProgress()
    assert.deepEqual(batch.entries[0].progress, { output: tokenCount("a😀", "cl100k_base"), reasoning: tokenCount("think", "cl100k_base"), requests: 1 })
    assert.equal(batch.entries[0].status, "running")
    assert.equal(batch.ready, false)
    const read = host.messages
    host.messages = async () => { throw new Error("Progress read failed") }
    await batch.pollProgress()
    assert.equal(batch.entries[0].progressUnavailable, true)
    assert.equal(batch.entries[0].status, "running")
    host.messages = read
    await batch.pollProgress()
    assert.equal(batch.entries[0].progressUnavailable, false)
    assert.equal(readPolicy(data.session).revision, 0)
  } finally { release(); await pending }
  assert.equal(batch.ready, true)
  assert.ok(batch.entries[0].finished! >= batch.entries[0].started!)
})

for (const [first, reason] of [["Short.", "too small"], ["detail ".repeat(20000), "too large"]] as const) test(`batch exposes ${reason} only for the current size review and resets on retry`, async t => {
  const { host, data, batch, ranges } = await setup(t, 1)
  const revision = deferred(), retry = deferred()
  let calls = 0, notified = false
  host.generate = async () => {
    if (++calls === 1) return first
    if (calls === 2) { await revision.promise; throw new Error("Review failed") }
    await retry.promise
    return "Complete replacement."
  }
  await batch.start("compact", ranges)
  const pending = batch.generate(() => { if (batch.entries[0]?.review === reason) notified = true })
  await until(() => calls === 2)
  assert.equal(batch.entries[0].review, reason)
  assert.equal(batch.entries[0].status, "running")
  assert.equal(notified, true)
  assert.equal(readPolicy(data.session).revision, 0)
  revision.resolve()
  await pending
  assert.equal(batch.entries[0].status, "error")
  const next = batch.generate()
  await until(() => calls === 3)
  assert.equal(batch.entries[0].review, undefined)
  await batch.cancel()
  retry.resolve()
  await next
  assert.equal(batch.entries[0].review, undefined)
  assert.equal(batch.ready, false)
  assert.equal(readPolicy(data.session).revision, 0)
})

test("progress polling coalesces reads and ignores results after cancellation", async (t) => {
  const { host, data, batch, ranges } = await setup(t, 1)
  let release!: () => void, readRelease!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const readGate = new Promise<void>((resolve) => { readRelease = resolve })
  const generate = host.generate
  host.generate = async (...args) => { await gate; return generate(...args) }
  let reads = 0
  host.progress = async () => { reads++; await readGate; return { output: 40, reasoning: 10, requests: 1 } }
  await batch.start("brief", ranges)
  const pending = batch.generate()
  await until(() => data.jobs === 1)
  const polling = batch.pollProgress()
  await until(() => reads === 1)
  await batch.pollProgress()
  assert.equal(reads, 1)
  await batch.cancel()
  readRelease()
  await polling
  assert.equal(batch.entries[0].progress, undefined)
  release()
  await pending
  assert.equal(readPolicy(data.session).revision, 0)
})

test("a late progress failure cannot attach to a retry with the same clock timestamp", async t => {
  const { host, data, batch, ranges } = await setup(t, 1)
  t.mock.method(Date, "now", () => 1000)
  const first = deferred(), second = deferred(), progress = deferred(), reading = deferred()
  const generate = host.generate
  let attempts = 0
  host.generate = async (...args) => {
    if (++attempts === 1) { await first.promise; throw new Error("First attempt failed") }
    await second.promise
    return generate(...args)
  }
  host.progress = async () => { reading.resolve(); await progress.promise; throw new Error("Old progress read failed") }
  await batch.start("brief", ranges)
  const initial = batch.generate()
  await until(() => data.jobs === 1)
  const polling = batch.pollProgress()
  await reading.promise
  first.resolve()
  await initial
  const retry = batch.generate()
  try {
    await until(() => data.jobs === 2)
    progress.resolve()
    await polling
    assert.equal(batch.entries[0].progressUnavailable, false)
    assert.equal(batch.entries[0].started, 1000)
    assert.equal(batch.entries[0].status, "running")
  } finally { second.resolve(); await retry }
  assert.equal(batch.ready, true)
  assert.equal(readPolicy(data.session).revision, 0)
})

test("partial failures keep successful drafts and retry only failed ranges against the original snapshot", async (t) => {
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
  const ready = structuredClone(batch.entries[0].draft)
  await assert.rejects(batch.apply(), /Every range/)
  assert.equal(readPolicy(data.session).operations.length, 0)
  await storage.saveCapture({ sessionID: data.session.id, time: 2, system: ["LATER_RUNTIME"], warnings: [] })
  fail = false
  await batch.generate()
  assert.equal(prompts.length, 3)
  assert.match(prompts[2], /FROZEN_RUNTIME/)
  assert.doesNotMatch(prompts[2], /LATER_RUNTIME/)
  assert.equal(batch.entries[0].draft!.jobID, firstJob)
  assert.deepEqual(batch.entries[0].draft, ready)
  await batch.apply()
  assert.equal(readPolicy(data.session).operations.length, 2)
})

test("stale or busy state blocks whole-batch application", async (t) => {
  const { data, batch, ranges } = await setup(t, 3)
  await batch.start("brief", ranges)
  await batch.generate()
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
  const restore = await controller.prepareRestore(ranges)
  assert.equal(restore.operations.length, 3)
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
  await batch.generate()
  assert.ok(batch.entries.every(entry => entry.status === "ready"))
  assert.equal(data.calls.length, 2)
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
