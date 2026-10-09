import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Controller } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { readPolicy } from "../src/context.ts"
import { Storage } from "../src/storage.ts"
import { fixtureHost } from "./fixtures.ts"

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "context-manager-test-"))
  const { data, host } = fixtureHost()
  const storage = new Storage(dir, dir)
  const controller = new Controller(host, data.session.id, settings(), storage)
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { data, host, storage, controller, ids: data.messages.slice(0, 2).map((m) => m.info.id) }
}

test("controller pruning preserves unrelated metadata and original transcript without exposing undo", async (t) => {
  const { data, controller, ids } = await setup(t)
  const original = structuredClone(data.messages)
  await controller.prune(ids)
  assert.equal(readPolicy(data.session).operations.length, 1)
  assert.equal(data.session.metadata?.unrelated, "keep")
  assert.deepEqual(data.messages, original)
  assert.equal("undo" in controller, false)
})

test("summary is inactive until applied; editing works; default model variant carried", async (t) => {
  const { data, host, controller, ids } = await setup(t)
  host.generate = async (_id, choice, text) => {
    assert.equal(choice.variant, "high")
    assert.ok(text.includes("Question 2"))
    return "Useful summary with selected facts. ".repeat(50)
  }
  const draft = await controller.summarize("compact", ids)
  assert.equal(draft.selected.length, 1)
  assert.equal(draft.totalBlocks, 3)
  assert.equal(readPolicy(data.session).operations.length, 0)
  assert.equal(data.removed.length, 0)
  await controller.apply(draft, "Edited summary")
  assert.equal(readPolicy(data.session).operations[0].summary, "Edited summary")
  assert.deepEqual(data.removed, [draft.jobID])
})

test("idle and stale draft guards reject unsafe updates", async (t) => {
  const { data, controller, ids } = await setup(t)
  data.idle = false
  await assert.rejects(controller.prune(ids), /idle/)
  await assert.rejects(controller.summarize("brief", ids), /idle/)
  data.idle = true
  const draft = await controller.summarize("brief", ids)
  data.messages[0].parts = []
  await assert.rejects(controller.apply(draft, "approved"), /changed/)
  assert.equal(readPolicy(data.session).operations.length, 0)
})

test("overflow and model failure never alter main context; helper cleaned", async (t) => {
  const { data, host, controller, ids } = await setup(t)
  data.model.limit.context = 100
  await assert.rejects(controller.summarize("compact", ids), /may not fit/)
  assert.equal(data.jobs, 0)
  data.model.limit.context = 200000
  host.generate = async () => { throw new Error("provider overflow") }
  await assert.rejects(controller.summarize("compact", ids), /provider overflow/)
  assert.equal(data.removed.length, 1)
  assert.equal(readPolicy(data.session).operations.length, 0)
})

test("input fit does not subtract a configured or model-derived output reserve", async (t) => {
  const { data, controller, ids } = await setup(t)
  data.model.limit.context = 30000
  data.model.limit.input = 25000
  data.model.limit.output = 100000
  const draft = await controller.summarize("brief", ids)
  assert.equal(data.calls.length, 1)
  assert.equal(draft.attempts, 1)
  assert.equal(readPolicy(data.session).operations.length, 0)
})

test("compact requests one expansion on the same helper and accepts an overshort second result", async (t) => {
  const { data, controller, ids } = await setup(t)
  data.responses = ["Very short.", "No further useful facts."]
  const draft = await controller.summarize("compact", ids)
  assert.equal(data.calls.length, 2)
  assert.equal(data.jobs, 1)
  assert.equal(data.calls[0].sessionID, data.calls[1].sessionID)
  assert.match(data.calls[1].text, /too short/i)
  assert.match(data.calls[1].text, /Initial selected range size:/)
  assert.equal(draft.operation.summary, "No further useful facts.")
  assert.equal(readPolicy(data.session).operations.length, 0)
})

test("controller performs one shortening revision and accepts oversized second draft", async (t) => {
  const { data, controller, ids } = await setup(t)
  data.responses = ["z".repeat(20000), "y".repeat(12000)]
  const draft = await controller.summarize("compact", ids)
  assert.equal(data.prompts.length, 2)
  assert.equal(draft.attempts, 2)
  assert.equal(data.jobs, 1)
  assert.equal(data.calls[0].sessionID, data.calls[1].sessionID)
  assert.ok(!data.prompts[1].includes("<selected_range_"))
  await controller.apply(draft, draft.operation.summary!)
  assert.equal(readPolicy(data.session).operations.length, 1)
})

test("snapshot contains latest approved projection and explicit missing runtime data", async (t) => {
  const { controller, ids } = await setup(t)
  await controller.prune(ids)
  const file = await controller.dump("2.0.26")
  const dump = JSON.parse(await readFile(file, "utf8"))
  assert.equal(dump.kind, "current-effective-context")
  assert.ok(dump.text.includes("middle omitted"))
  assert.equal(dump.runtime, null)
})

test("OpenCode's default variant sentinel is valid without a variants entry", async (t) => {
  const { data, controller, ids } = await setup(t)
  data.session.model = { id: "model", providerID: "test", variant: "default" }
  const draft = await controller.summarize("brief", ids)
  assert.equal(draft.model.variant, "default")
})

test("cancellation during helper creation prevents model call and deletes helper", async (t) => {
  const { host, data, controller, ids } = await setup(t)
  host.createJob = async () => { await controller.cancel(); return "cancelled_job" }
  await assert.rejects(controller.summarize("compact", ids), /cancelled/)
  assert.equal(data.prompts.length, 0)
  assert.deepEqual(data.removed, ["cancelled_job"])
  assert.equal(readPolicy(data.session).operations.length, 0)
})

test("approval rechecks idle status; a rejected draft remains inactive", async (t) => {
  const { data, controller, ids } = await setup(t)
  const draft = await controller.summarize("compact", ids)
  data.idle = false
  await assert.rejects(controller.apply(draft, "approved"), /idle/)
  assert.equal(readPolicy(data.session).operations.length, 0)
})

test("explicit compaction model and effort override defaults without changing the main session", async (t) => {
  const { data, host, controller, ids } = await setup(t)
  const alternate = { ...data.model, id: "other", providerID: "alternate", variants: [{ id: "low", settings: { reasoningEffort: "low" } }] }
  host.models = async () => [data.model, alternate]
  const before = structuredClone(data.session)
  const choice = { providerID: "alternate", modelID: "other", variant: "low" }
  const draft = await controller.summarize("brief", ids, choice)
  assert.deepEqual(data.calls[0].choice, choice)
  assert.deepEqual(draft.model, choice)
  assert.deepEqual(data.session, before)
})

test("unsupported model or effort fails before creating a helper or making a request", async (t) => {
  const { data, controller, ids } = await setup(t)
  await assert.rejects(controller.summarize("compact", ids, { providerID: "missing", modelID: "missing" }), /unavailable/)
  await assert.rejects(controller.summarize("compact", ids, { providerID: "test", modelID: "model", variant: "unknown" }), /Unsupported/)
  data.model.variants = []
  await assert.rejects(controller.summarize("compact", ids, { providerID: "test", modelID: "model", variant: "disabled" }), /Unsupported/)
  assert.equal(data.jobs, 0)
  assert.equal(data.calls.length, 0)
})

test("manual revisions retain the first full context, edited draft and conversation across model switches", async (t) => {
  const { data, host, controller, ids } = await setup(t)
  const alternate = { ...data.model, id: "other", providerID: "alternate", variants: [{ id: "low", settings: { reasoningEffort: "low" } }] }
  host.models = async () => [data.model, alternate]
  data.responses = ["Initial summary. ".repeat(150), "Revised summary", "Third summary".repeat(1500)]
  const draft = await controller.summarize("compact", ids)
  const edited = draft.operation.summary + "\nManual fact: preserve 😀 and /src/important.ts"
  const revised = await controller.refine(draft, edited, "Add a checklist.", { providerID: "alternate", modelID: "other", variant: "low" })
  assert.equal(revised.refinements, 1)
  assert.equal(revised.jobID, draft.jobID)
  assert.ok(data.calls[0].text.includes("Question 2"))
  assert.ok(data.calls[0].text.includes("<selected_range_"))
  assert.ok(data.calls[1].text.includes(edited))
  assert.ok(data.calls[1].text.includes("Add a checklist."))
  assert.ok(!data.calls[1].text.includes("<selected_range_"))
  assert.equal(data.calls[1].choice.variant, "low")
  const third = await controller.refine(revised, revised.operation.summary!, "Expand this substantially.", { ...revised.model, variant: "default" })
  assert.equal(third.refinements, 2)
  assert.equal(data.calls.length, 3, "manual revisions must not trigger automatic shortening passes")
  assert.equal(data.jobs, 1)
  assert.deepEqual(data.calls.map((call) => call.sessionID), [draft.jobID, draft.jobID, draft.jobID])
  assert.ok(data.conversations.get(draft.jobID)?.[0].parts.some((p) => p.type === "text" && p.text.includes("Question 2")))
  assert.equal(readPolicy(data.session).operations.length, 0)
  assert.equal(data.removed.length, 0)
  await assert.rejects(controller.apply(draft, "Old draft"), /no longer active/)
  await controller.discard()
  assert.deepEqual(data.removed, [draft.jobID])
})

test("a smaller revision model must fit accumulated history, not just the change request", async (t) => {
  const { data, host, controller, ids } = await setup(t)
  const small = { ...data.model, id: "small", limit: { context: 6000, output: 1000 } }
  host.models = async () => [data.model, small]
  const draft = await controller.summarize("brief", ids)
  await assert.rejects(controller.refine(draft, "Short draft", "Tidy wording", { providerID: "test", modelID: "small" }), /conversation may not fit/)
  assert.equal(data.calls.length, 1)
  assert.equal(data.jobs, 1)
  assert.equal(data.removed.length, 0)
  const revised = await controller.refine(draft, "Short draft", "Tidy wording")
  assert.equal(revised.jobID, draft.jobID)
})

test("failed or empty revisions preserve the draft and helper for retry", async (t) => {
  const { data, host, controller, ids } = await setup(t)
  const draft = await controller.summarize("brief", ids)
  const generate = host.generate
  host.generate = async () => { throw new Error("provider unavailable") }
  await assert.rejects(controller.refine(draft, "Manually edited", "Change wording"), /provider unavailable/)
  assert.equal(draft.operation.summary, "A useful detailed summary.")
  assert.equal(data.removed.length, 0)
  host.generate = generate
  data.responses = [" ", "Recovered"]
  await assert.rejects(controller.refine(draft, "Manually edited", "Change wording"), /empty/)
  const revised = await controller.refine(draft, "Manually edited", "Try again")
  assert.equal(revised.operation.summary, "Recovered")
  assert.equal(revised.jobID, draft.jobID)
  assert.equal(data.jobs, 1)
})

test("cancelled revision keeps the editor's draft conversation until explicitly discarded", async (t) => {
  const { data, host, controller, ids } = await setup(t)
  const draft = await controller.summarize("brief", ids)
  const generate = host.generate
  let started!: () => void
  let finish!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { finish = resolve })
  host.generate = async (...args) => { started(); await gate; return generate(...args) }
  const pending = controller.refine(draft, "Manual draft", "Revise")
  const rejected = assert.rejects(pending, /cancelled/)
  await ready
  await controller.cancel()
  finish()
  await rejected
  assert.deepEqual(data.aborted, [draft.jobID])
  assert.equal(data.removed.length, 0)
  assert.equal(draft.refinements, 0)
  host.generate = generate
  const revised = await controller.refine(draft, "Manual draft", "Try again")
  assert.equal(revised.jobID, draft.jobID)
  await controller.discard()
  assert.deepEqual(data.removed, [draft.jobID])
})

test("busy or changed main session prevents a revision request", async (t) => {
  const { data, controller, ids } = await setup(t)
  const draft = await controller.summarize("brief", ids)
  data.idle = false
  await assert.rejects(controller.refine(draft, "Edited", "Revise"), /idle/)
  data.idle = true
  data.messages[0].parts = []
  await assert.rejects(controller.refine(draft, "Edited", "Revise"), /Session changed/)
  assert.equal(data.calls.length, 1)
  assert.equal(data.removed.length, 0)
})

test("closing a preview deletes its helper exactly once and rejects further requests", async (t) => {
  const { data, controller, ids } = await setup(t)
  const draft = await controller.summarize("brief", ids)
  await Promise.all([controller.dispose(), controller.dispose()])
  assert.deepEqual(data.removed, [draft.jobID])
  await assert.rejects(controller.refine(draft, "Edited", "Revise"), /closed/)
})

test("closing during helper creation prevents generation and cleans up after creation settles", async (t) => {
  const { data, host, controller, ids } = await setup(t)
  host.createJob = async () => { await controller.dispose(); return "closing_job" }
  await assert.rejects(controller.summarize("brief", ids), /cancelled/)
  assert.equal(data.calls.length, 0)
  assert.deepEqual(data.removed, ["closing_job"])
})

test("cleanup failure after approval warns without reporting that the applied operation failed", async (t) => {
  const { data, host, controller, ids } = await setup(t)
  const draft = await controller.summarize("brief", ids)
  const remove = host.remove
  host.remove = async () => { throw new Error("delete unavailable") }
  const warning = await controller.apply(draft, "Approved")
  assert.match(warning!, /Summary applied/)
  assert.equal(readPolicy(data.session).operations.length, 1)
  host.remove = remove
  await controller.dispose()
  assert.deepEqual(data.removed, [draft.jobID])
})

test("range restore previews are read-only until confirmed and use no model", async (t) => {
  const { data, controller } = await setup(t)
  const middle = data.messages.slice(2, 4).map((message) => message.info.id)
  const draft = await controller.summarize("brief", middle)
  await controller.apply(draft, "Middle summary")
  const calls = data.calls.length
  const preview = await controller.prepareRestore("expand", middle)
  assert.equal(preview.summaries, 1)
  assert.ok(preview.afterChars > preview.operation.beforeChars)
  assert.equal(readPolicy(data.session).operations.length, 1)
  await controller.applyRestore(preview)
  const loaded = await controller.load()
  assert.deepEqual(loaded.blocks[1].messages, data.messages.slice(2, 4))
  assert.equal(readPolicy(data.session).operations.length, 2)
  assert.equal(readPolicy(data.session).version, 10)
  assert.equal(data.calls.length, calls)
})

test("restore confirmation rejects a busy session or changed source/revision", async (t) => {
  const { data, controller, ids } = await setup(t)
  const draft = await controller.summarize("brief", ids)
  await controller.apply(draft, "First summary")
  const preview = await controller.prepareRestore("expand", ids)
  data.idle = false
  await assert.rejects(controller.applyRestore(preview), /idle/)
  data.idle = true
  await controller.editSummary(await controller.summary(draft.operation.id), "Changed summary")
  await assert.rejects(controller.applyRestore(preview), /changed/)
  const fresh = await controller.prepareRestore("expand", ids)
  data.messages[0].parts = []
  await assert.rejects(controller.applyRestore(fresh))
  assert.equal(readPolicy(data.session).operations.length, 2)
})

test("restore and prune no-ops do not add misleading history entries", async (t) => {
  const { data, controller, ids } = await setup(t)
  await assert.rejects(controller.prepareRestore("expand", ids), /No restorable/)
  await controller.prune(ids)
  await assert.rejects(controller.prune(ids), /No eligible/)
  assert.equal(readPolicy(data.session).operations.length, 1)
  assert.equal(data.calls.length, 0)
})

test("summary expansion through the controller restores pre-summary pruning without another model call", async (t) => {
  const { data, controller, ids } = await setup(t)
  await controller.prune(ids)
  const before = (await controller.load()).blocks[0].messages
  const draft = await controller.summarize("compact", ids)
  await controller.apply(draft, draft.operation.summary!)
  const count = data.calls.length
  const preview = await controller.prepareRestore("expand", ids)
  assert.equal(preview.summaries, 1)
  await controller.applyRestore(preview)
  assert.deepEqual((await controller.load()).blocks[0].messages, before)
  assert.equal(data.calls.length, count)
})

test("pruning restoration previews token growth, rejects busy/stale confirmation, and makes no model calls", async (t) => {
  const { data, controller, ids } = await setup(t)
  const original = structuredClone(data.messages)
  await controller.prune(ids, { reasoning: true, tools: "delete" })
  const preview = await controller.prepareRestoreRanges("expand", [ids])
  assert.equal(preview.summaries, 0)
  assert.equal(preview.prunings, 1)
  assert.ok(preview.afterTokens > preview.beforeTokens)
  assert.equal(readPolicy(data.session).revision, 1)
  data.idle = false
  await assert.rejects(controller.applyOperations(preview.operations, preview), /idle/)
  data.idle = true
  await controller.prune(data.messages.slice(2, 4).map((message) => message.info.id))
  await assert.rejects(controller.applyOperations(preview.operations, preview), /changed/)
  const fresh = await controller.prepareRestore("expand", ids)
  assert.equal(fresh.prunings, 1)
  await controller.applyRestore(fresh)
  const after = await controller.load()
  assert.deepEqual(after.blocks[0].messages, original.slice(0, 2))
  assert.ok(after.blocks[1].pruning?.length)
  await assert.rejects(controller.prepareRestore("expand", ids), /No restorable/)
  assert.equal(data.calls.length, 0)
  assert.deepEqual(data.messages, original)
})
