import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { Controller } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { operation, readPolicy } from "../src/context.ts"
import { applySummary } from "./fixtures.ts"
import { setupController as setup } from "./controller-fixture.ts"
import { deferred } from "./async.ts"

test("checked pruning preserves metadata/transcript, rejects no-ops and exports effective context", async t => {
  const { data, controller, ids } = await setup(t)
  const original = structuredClone(data.messages)
  await assert.rejects(controller.restoreRanges([ids]), /No restorable/)
  await controller.prune(ids)
  await assert.rejects(controller.prune(ids), /No eligible/)
  assert.equal(readPolicy(data.session).revision, 1)
  assert.equal(data.session.metadata?.unrelated, "keep")
  assert.deepEqual(data.messages, original)
  assert.equal(data.calls.length, 0)
  const dump = JSON.parse(await readFile(await controller.dump("2.1.4"), "utf8"))
  assert.equal(dump.kind, "current-effective-context")
  assert.match(dump.text, /middle omitted/)
  assert.equal(dump.runtime, null)
})

test("generation stays inactive and carries the current model/effort and full background", async t => {
  const { data, host, controller, ids } = await setup(t)
  host.generate = async (_id, choice, text) => {
    assert.equal(choice.variant, "high")
    assert.match(text, /Question 2/)
    return "Selected facts"
  }
  const draft = await controller.summarize("brief", ids)
  assert.equal(readPolicy(data.session).revision, 0)
  assert.equal(data.removed.length, 0)
  await applySummary(controller, draft)
  assert.equal(readPolicy(data.session).operations[0].summary, "Selected facts")
  assert.deepEqual(data.removed, [draft.jobID])
})

test("checked writes send only the strict revision/fingerprint RPC precondition", async t => {
  const { host, controller, ids } = await setup(t)
  const update = host.update
  let writes = 0
  host.update = async (id, metadata, expected) => {
    assert.deepEqual(Object.keys(expected!).sort(), ["fingerprint", "revision"])
    writes++
    return update(id, metadata, expected)
  }
  await applySummary(controller, await controller.summarize("brief", ids))
  await controller.restoreRanges([ids])
  assert.equal(writes, 2)
})

for (const change of ["busy", "source", "revert"] as const) test(`summary commit rechecks ${change} state`, async t => {
  const { data, controller, ids } = await setup(t)
  const draft = await controller.summarize("brief", ids)
  if (change === "busy") data.idle = false
  if (change === "source") data.messages[0].parts = []
  if (change === "revert") data.session.revert = { messageID: ids[0] }
  await assert.rejects(applySummary(controller, draft), /idle|changed|undo\/unrevert/)
  assert.equal(readPolicy(data.session).revision, 0)
})

test("revert appearing at the final write check cannot slip through an earlier valid snapshot", async t => {
  const { host, data, controller, ids } = await setup(t)
  const loaded = await controller.load()
  const plan = { ...loaded, revision: loaded.policy.revision }
  const op = operation("prune-reason", loaded.blocks.slice(0, 1))
  let reads = 0
  const read = host.session
  host.session = async (...args) => {
    if (++reads === 2) data.session.revert = { messageID: ids[0] }
    return read(...args)
  }
  await assert.rejects(controller.applyOperations([op], plan), /undo\/unrevert/)
  assert.equal(readPolicy(data.session).revision, 0)
})

test("closing the controller during inspection revokes a pending maintenance write", async t => {
  const { host, data, controller } = await setup(t)
  const loaded = await controller.load()
  const op = operation("prune-reason", loaded.blocks.slice(0, 1))
  const gate = deferred(), entered = deferred()
  const read = host.session
  host.session = async (...args) => { entered.resolve(); await gate.promise; return read(...args) }
  const pending = controller.applyOperations([op], { revision: loaded.policy.revision, fingerprint: loaded.fingerprint })
  const result = pending.then(() => undefined, error => error)
  await entered.promise
  await controller.dispose()
  gate.resolve()
  assert.match(String(await result), /closed/)
  assert.equal(readPolicy(data.session).revision, 0)
})

test("manual input limits belong to the provider; automatic jobs retain their input preflight", async t => {
  const { data, host, storage, controller, ids } = await setup(t)
  data.model.limit = { context: 100, input: 50, output: 100000 }
  const draft = await controller.summarize("brief", ids)
  assert.equal(data.calls.length, 1)
  await controller.discard()
  const worker = new Controller(host, data.session.id, settings(), storage, "summary", "auto")
  t.after(() => worker.dispose())
  await assert.rejects(worker.summarize("brief", ids), /may not fit/)
  assert.equal(data.jobs, 1)
  data.model.limit = { context: 200000, input: 200000, output: 100000 }
  const create = host.createJob
  host.createJob = async (...args) => { assert.equal(args[2], "auto"); return create(...args) }
  await worker.summarize("brief", ids)
  assert.ok(data.removed.includes(draft.jobID))
})

for (const [responses, direction] of [
  [["Very short.", "No further useful facts."], /too short/],
  [["z".repeat(20000), "y".repeat(12000)], /too long/],
] as const) test(`detailed review runs once on the same helper (${direction.source})`, async t => {
  const { data, controller, ids } = await setup(t)
  data.responses = [...responses]
  const draft = await controller.summarize("compact", ids)
  assert.equal(draft.attempts, 2)
  assert.equal(data.jobs, 1)
  assert.equal(data.calls.length, 2)
  assert.equal(data.calls[0].sessionID, data.calls[1].sessionID)
  assert.match(data.calls[1].text, direction)
  assert.doesNotMatch(data.calls[1].text, /<selected_range_/)
  assert.equal(draft.operation.summary, responses[1])
  assert.equal(readPolicy(data.session).revision, 0)
})

test("model overrides and default effort preserve the main session; invalid choices create no helper", async t => {
  const { data, host, controller, ids } = await setup(t)
  const other = { ...data.model, id: "other", providerID: "alternate", variants: [{ id: "low", settings: {} }] }
  host.models = async () => [data.model, other]
  for (const choice of [{ providerID: "missing", modelID: "missing" }, { providerID: "test", modelID: "model", variant: "missing" }])
    await assert.rejects(controller.summarize("brief", ids, choice), /unavailable|Unsupported/)
  assert.equal(data.jobs, 0)
  const before = structuredClone(data.session)
  for (const variant of ["low", "default"]) {
    const choice = { providerID: "alternate", modelID: "other", variant }
    const draft = await controller.summarize("brief", ids, choice)
    assert.deepEqual(draft.model, choice)
    assert.deepEqual(data.calls.at(-1)!.choice, choice)
    assert.deepEqual(data.session, before)
    await controller.discard()
  }
})

for (const reason of ["cancel", "dispose"] as const) test(`${reason} during helper creation prevents generation and removes only the helper`, async t => {
  const { data, host, controller, ids } = await setup(t)
  host.createJob = async () => { await controller[reason](); return "pending_job" }
  await assert.rejects(controller.summarize("brief", ids), /cancelled/)
  assert.equal(data.calls.length, 0)
  assert.deepEqual(data.removed, ["pending_job"])
  assert.equal(readPolicy(data.session).revision, 0)
})

test("failed generation cleans its helper; concurrent disposal is idempotent and final", async t => {
  const { data, host, controller, ids } = await setup(t)
  const generate = host.generate
  host.generate = async () => { throw new Error("provider overflow") }
  await assert.rejects(controller.summarize("brief", ids), /provider overflow/)
  host.generate = generate
  const draft = await controller.summarize("brief", ids)
  await Promise.all([controller.dispose(), controller.dispose()])
  assert.deepEqual(data.removed, ["job_1", draft.jobID])
  await assert.rejects(controller.summarize("brief", ids), /closed|current draft/)
})

test("restoration uses the common checked commit, preserves inner pruning and makes no model call", async t => {
  const { data, controller, ids } = await setup(t)
  await controller.prune(ids)
  const before = (await controller.load()).blocks[0].messages
  const draft = await controller.summarize("brief", ids)
  await applySummary(controller, draft)
  const plan = await controller.prepareRestore([ids])
  assert.equal(plan.operations[0].summaryIDs?.length, 1)
  assert.equal(readPolicy(data.session).revision, 2)
  data.idle = false
  await assert.rejects(controller.applyOperations(plan.operations, plan), /idle/)
  data.idle = true
  await controller.editSummary(await controller.summary(draft.operation.id), "Changed")
  await assert.rejects(controller.applyOperations(plan.operations, plan), /changed/)
  const calls = data.calls.length
  await controller.restoreRanges([ids])
  assert.deepEqual((await controller.load()).blocks[0].messages, before)
  await controller.restoreRanges([ids])
  assert.deepEqual((await controller.load()).blocks[0].messages, data.messages.slice(0, 2))
  await assert.rejects(controller.restoreRanges([ids]), /No restorable/)
  assert.equal(data.calls.length, calls)
})
