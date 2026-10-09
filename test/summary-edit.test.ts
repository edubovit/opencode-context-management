import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Controller } from "../src/controller.ts"
import { SummaryEditor } from "../src/summary-editor.ts"
import { Storage } from "../src/storage.ts"
import { settings } from "../src/config.ts"
import { project, readPolicy } from "../src/context.ts"
import { fixtureHost, messages } from "./fixtures.ts"

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-summary-edit-"))
  const { data, host } = fixtureHost()
  const controller = new Controller(host, data.session.id, settings(), new Storage(dir, dir))
  const ids = data.messages.slice(0, 2).map((message) => message.info.id)
  const draft = await controller.summarize("brief", ids)
  await controller.apply(draft, "APPLIED_SUMMARY_ONLY")
  const editor = new SummaryEditor(controller, await controller.summary(draft.operation.id))
  t.after(async () => { await editor.dispose(); await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { data, host, controller, editor, id: draft.operation.id, ids, choice: { providerID: "test", modelID: "model", variant: "high" } }
}

test("summary edits start fresh with only applied summary, continue for review, then dispose and restart fresh after apply", async (t) => {
  const { data, controller, editor, id, choice } = await setup(t)
  const compactionJob = data.removed[0]
  data.responses = ["FIRST_EDIT", "SECOND_EDIT", "THIRD_EDIT"]
  await editor.request("Add clarity", choice)
  const first = data.calls.at(-1)!
  assert.notEqual(first.sessionID, compactionJob)
  assert.match(first.text, /APPLIED_SUMMARY_ONLY/)
  assert.doesNotMatch(first.text, /Question 0|Question 2|selected_range|HEAD_0/)
  assert.equal((await controller.summary(id)).text, "APPLIED_SUMMARY_ONLY")
  await editor.request("Keep more detail", choice)
  assert.equal(data.calls.at(-1)!.sessionID, first.sessionID)
  assert.match(data.calls.at(-1)!.text, /FIRST_EDIT/)
  assert.equal(editor.draft, "SECOND_EDIT")
  await editor.apply()
  assert.equal((await controller.summary(id)).text, "SECOND_EDIT")
  assert.ok(data.removed.includes(first.sessionID))
  await editor.request("One more change", choice)
  assert.notEqual(data.calls.at(-1)!.sessionID, first.sessionID)
  assert.match(data.calls.at(-1)!.text, /SECOND_EDIT/)
  assert.equal(readPolicy(data.session).operations.length, 2)
})

test("summary revision operations survive dependent compaction and expansion without rewriting originals", async (t) => {
  const { data, controller, editor, id, ids } = await setup(t)
  const original = structuredClone(data.messages)
  const originalOp = structuredClone(readPolicy(data.session).operations[0])
  await editor.apply("MANUAL_EDIT")
  assert.deepEqual(readPolicy(data.session).operations[0], originalOp)
  assert.equal(readPolicy(data.session).version, 10)
  assert.equal((await controller.load()).blocks[0].summaryID, id)
  assert.equal((await controller.summary(id)).text, "MANUAL_EDIT")
  const all = (await controller.load()).blocks.slice(0, 2).flatMap((block) => block.sourceIDs)
  const outer = await controller.summarize("brief", all)
  await controller.apply(outer, "OUTER_SUMMARY")
  const expand = await controller.prepareRestore("expand", all)
  await controller.applyRestore(expand)
  assert.equal((await controller.summary(id)).text, "MANUAL_EDIT")
  const inner = await controller.prepareRestore("expand", ids)
  await controller.applyRestore(inner)
  assert.deepEqual((await controller.load()).blocks[0].messages, original.slice(0, 2))
  assert.deepEqual(data.messages, original)
})

test("saved summaries can be read and edited after new main messages, while stale/busy edits fail", async (t) => {
  const { data, controller, id, choice } = await setup(t)
  data.messages.push(...messages(data.session.id, 4).slice(6))
  const editor = new SummaryEditor(controller, await controller.summary(id))
  t.after(() => editor.dispose())
  await editor.request("Rewrite", choice)
  data.idle = false
  await assert.rejects(editor.apply(), /idle/)
  data.idle = true
  data.messages[0].parts = []
  await assert.rejects(editor.apply(), /changed/)
  assert.equal(readPolicy(data.session).operations.length, 1)
})

test("failed edits keep the last proposed result; closing discards it without changing context", async (t) => {
  const { data, host, controller, editor, id, choice } = await setup(t)
  data.responses = ["GOOD_DRAFT"]
  await editor.request("First edit", choice)
  host.generate = async () => { throw new Error("Fixture model unavailable") }
  await assert.rejects(editor.request("Second edit", choice), /unavailable/)
  assert.equal(editor.draft, "GOOD_DRAFT")
  await editor.dispose()
  assert.equal((await controller.summary(id)).text, "APPLIED_SUMMARY_ONLY")
  assert.equal(data.removed.length, 2)
})

test("closing a pending summary edit discards late output and deletes only its helper", async (t) => {
  const { data, host, controller, editor, id, choice } = await setup(t)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { started = resolve })
  const generate = host.generate
  host.generate = async (...args) => { started(); await gate; return generate(...args) }
  const pending = editor.request("Pending change", choice)
  const rejected = assert.rejects(pending, /cancelled/)
  await ready
  const closing = editor.dispose()
  release()
  await rejected
  await closing
  assert.equal((await controller.summary(id)).text, "APPLIED_SUMMARY_ONLY")
  assert.equal(data.removed.length, 2)
  assert.equal(data.aborted.length, 1)
})

test("summary revisions require an exact visible summary target", async (t) => {
  const { data, editor } = await setup(t)
  await editor.apply("Updated text")
  const policy = structuredClone(readPolicy(data.session))
  policy.operations.at(-1)!.targetID = "wrong-summary"
  assert.throws(() => project(data.messages, policy), /revision target/)
})
