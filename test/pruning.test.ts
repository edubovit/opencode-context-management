import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { append, blockMessages, emptyPolicy, operation, project, readPolicy, TOOL_OUTPUT_PRUNED, turns } from "../src/context.ts"
import { selectedModes, toggleMode } from "../src/compaction.ts"
import { Controller } from "../src/controller.ts"
import { KEY, settings } from "../src/config.ts"
import { Storage } from "../src/storage.ts"
import { snapshot } from "../src/snapshot.ts"
import { toolStatus } from "../src/status.ts"
import { rangeToolStats } from "../src/range-rows.ts"
import { fixtureHost, messages, pruneRule } from "./fixtures.ts"

test("prune-reason removes entire reasoning parts only and leaves source history intact", () => {
  const raw = messages()
  const reasoning = raw[1].parts.find((part) => part.type === "reasoning")!
  if (reasoning.type === "reasoning") reasoning.metadata = { anthropic: { signature: "opaque-fixture" } }
  const original = structuredClone(raw)
  const policy = append(emptyPolicy("ses_test"), operation("prune-reason", [turns(raw)[0]]))
  const blocks = project(raw, policy)
  assert.deepEqual(raw, original)
  assert.deepEqual(blockMessages(blocks), raw.map((message, index) => index === 1 ? { ...message, parts: message.parts.filter((p) => p.type !== "reasoning") } : message))
  assert.equal(blocks[0].kind, "turn")
  assert.equal(rangeToolStats(toolStatus([blocks[0]], pruneRule())), "1 tool · 1 large · reasoning removed")
  assert.doesNotMatch(JSON.stringify(snapshot("ses_test", "fixture", blocks, policy)), /opaque-fixture/)
})

test("all-output pruning replaces small, empty, errored and interrupted results and attachments, but not inputs", () => {
  for (const status of ["completed", "error", "interrupted"] as const) {
    const raw = messages()
    const tool = raw[1].parts[0]
    assert.ok(tool.type === "tool")
    tool.metadata = { openai: { itemId: "keep-call-metadata" } }
    if (status === "completed" && tool.state.status === "completed") {
      tool.state.output = ""
      tool.state.attachments = [{ type: "file", id: "attachment", sessionID: "ses_test", messageID: raw[1].info.id, mime: "image/png", url: "data:image/png;base64,REMOVED" }]
    } else tool.state = { status: "error", input: { keep: true }, error: "REMOVED_ERROR", metadata: status === "interrupted" ? { interrupted: true, output: "REMOVED_OUTPUT" } : {} }
    const policy = append(emptyPolicy("ses_test"), operation("tool-prune-all", [turns(raw)[0]]))
    const blocks = project(raw, policy)
    const after = blocks[0].messages[1].parts[0]
    assert.ok(after.type === "tool")
    assert.deepEqual(after.state.input, tool.state.input)
    assert.deepEqual(after.metadata, tool.metadata)
    assert.equal(after.state.status, tool.state.status)
    assert.equal(rangeToolStats(toolStatus([blocks[0]], pruneRule())), "1 pruned")
    assert.doesNotMatch(JSON.stringify(blocks[0]), /REMOVED/)
    assert.match(JSON.stringify(blocks[0]), /Tool output pruned/)
    assert.deepEqual(blocks[1].messages, raw.slice(2, 4))
    const repeated = project(raw, append(policy, operation("tool-prune-all", [blocks[0]])))
    assert.deepEqual(repeated, blocks)
    assert.deepEqual(project(raw, append(policy, operation("tool-prune", [blocks[0]], pruneRule()))), blocks)
  }
})

test("tool deletion removes complete calls, including pending calls, and reasoning without changing visible text", () => {
  const raw = messages()
  const pending = raw[1].parts[0]
  assert.ok(pending.type === "tool")
  pending.state = { status: "running", input: { original: "kept in storage" } }
  const policy = append(emptyPolicy("ses_test"), { ...operation("tool-delete", [turns(raw)[0]]), pruneReason: true })
  assert.equal(readPolicy({ id: "ses_test", metadata: { [KEY]: policy } }).version, 9)
  const blocks = project(raw, policy)
  assert.deepEqual(blocks[0].messages, raw.slice(0, 2).map((message) => ({ ...message, parts: message.parts.filter((p) => p.type !== "tool" && p.type !== "reasoning") })))
  assert.equal(rangeToolStats(toolStatus([blocks[0]], pruneRule())), "Tools removed · reasoning removed")
  assert.deepEqual(raw[1].parts[0], pending)
  assert.throws(() => readPolicy({ id: "ses_test", metadata: { [KEY]: { ...policy, operations: [{ ...policy.operations[0], pruneReason: undefined }] } } }), /requires pruning reasoning/)
  assert.throws(() => readPolicy({ id: "ses_test", metadata: { [KEY]: { ...policy, version: 5 } } }), /Unsupported/)
})

test("nested summary expansion retains final pruning, flags and untouched gaps", () => {
  const raw = messages()
  let policy = append(emptyPolicy("ses_test"), { ...operation("tool-prune-all", [turns(raw)[0]]), pruneReason: true })
  const pruned = project(raw, policy)
  policy = append(policy, { ...operation("compact", [pruned[0]]), summary: "Inner" })
  const inner = project(raw, policy)
  policy = append(policy, { ...operation("brief", inner.slice(0, 2)), summary: "Outer" })
  policy = append(policy, operation("expand", [project(raw, policy)[0]]))
  assert.deepEqual(project(raw, policy), inner)
  policy = append(policy, operation("expand", [project(raw, policy)[0]]))
  assert.deepEqual(project(raw, policy), pruned)
  assert.equal(rangeToolStats(toolStatus([project(raw, policy)[0]], pruneRule())), "1 pruned · reasoning removed")
})

test("configuration permits reasoning plus one tool mode, clears conflicts, and locks reasoning for deletion", () => {
  let value = toggleMode({ kind: "summary", mode: "compact" }, 0)
  assert.deepEqual(selectedModes(value), [0])
  value = toggleMode(value, 1)
  assert.deepEqual(selectedModes(value), [0, 1])
  value = toggleMode(value, 2)
  assert.deepEqual(selectedModes(value), [0, 2])
  value = toggleMode(value, 3)
  assert.deepEqual(selectedModes(value), [0, 3])
  value = toggleMode(value, 0)
  assert.deepEqual(selectedModes(value), [0, 3])
  value = toggleMode(value, 5)
  assert.deepEqual(selectedModes(value), [5])
  value = toggleMode(value, 1)
  assert.deepEqual(selectedModes(value), [1])
  value = toggleMode(value, 1)
  assert.deepEqual(selectedModes(value), [])
})

test("combined disjoint pruning uses one checked write, no model; no-op/busy/invalid requests fail", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-pruning-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { host, data } = fixtureHost()
  const controller = new Controller(host, data.session.id, settings(), new Storage(dir, dir))
  const blocks = turns(data.messages)
  const ranges = [blocks[0].sourceIDs, blocks[2].sourceIDs]
  const update = host.update
  let writes = 0
  host.update = async (...args) => { writes++; await update(...args) }
  await controller.pruneRanges(ranges, { reasoning: true, tools: "all" })
  assert.equal(writes, 1)
  assert.equal(data.calls.length, 0)
  assert.equal(readPolicy(data.session).operations.length, 2)
  const after = (await controller.load()).blocks
  assert.deepEqual(after[1].messages, blocks[1].messages)
  assert.equal(after[0].reasonPruned, true)
  assert.equal(after[2].allToolsPruned, true)
  assert.equal((after[0].messages[1].parts[0] as { state: { output: string } }).state.output, TOOL_OUTPUT_PRUNED)
  await assert.rejects(controller.pruneRanges(ranges, { reasoning: true, tools: "all" }), /No eligible/)
  await assert.rejects(controller.pruneRanges(ranges, { reasoning: false, tools: "delete" }), /requires/)
  await assert.rejects(controller.pruneRanges(ranges, { reasoning: false }), /Select at least/)
  assert.equal("undo" in controller, false)
  data.idle = false
  await assert.rejects(controller.pruneRanges(ranges, { reasoning: true, tools: "delete" }), /idle/)
  assert.equal(writes, 1)
})

test("reasoning plus large pruning preserves calls/attachments and survives expansion", () => {
  const raw = messages()
  const tool = raw[1].parts[0]
  assert.ok(tool.type === "tool" && tool.state.status === "completed")
  tool.state.attachments = [{ type: "file", id: "keep", sessionID: "ses_test", messageID: raw[1].info.id, mime: "image/png", url: "data:image/png;base64,KEEP" }]
  let policy = append(emptyPolicy("ses_test"), { ...operation("tool-prune", [turns(raw)[0]], pruneRule()), pruneReason: true })
  const pruned = project(raw, policy)
  const result = pruned[0].messages[1].parts[0]
  assert.ok(result.type === "tool" && result.state.status === "completed")
  assert.deepEqual(result.state.input, tool.state.input)
  assert.deepEqual(result.state.attachments, tool.state.attachments)
  assert.match(result.state.output, /middle omitted/)
  assert.equal(rangeToolStats(toolStatus([pruned[0]], pruneRule())), "1 tool · 1 pruned · reasoning removed")
  policy = append(policy, { ...operation("brief", [pruned[0]]), summary: "Summary" })
  policy = append(policy, operation("expand", [project(raw, policy)[0]]))
  assert.deepEqual(project(raw, policy), pruned)
})

test("whole-call deletion survives summary expansion and cannot expose hidden reasoning or tools", () => {
  const raw = messages()
  let policy = append(emptyPolicy("ses_test"), { ...operation("tool-delete", [turns(raw)[0]]), pruneReason: true })
  const removed = project(raw, policy)
  policy = append(policy, { ...operation("compact", removed.slice(0, 2)), summary: "Combined" })
  policy = append(policy, operation("expand", [project(raw, policy)[0]]))
  assert.deepEqual(project(raw, policy), removed)
  assert.equal(rangeToolStats(toolStatus([removed[0]], pruneRule())), "Tools removed · reasoning removed")
  const mixed = toolStatus(removed, pruneRule())
  assert.equal(mixed.noTools, false)
  assert.equal(mixed.noReason, false)
})

test("new pruning rejects source changes between preparation and persistence", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-pruning-stale-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { host, data } = fixtureHost()
  const controller = new Controller(host, data.session.id, settings(), new Storage(dir, dir))
  const originalMessages = host.messages
  let reads = 0
  host.messages = async (id) => {
    if (++reads === 2) data.messages[0].parts = []
    return originalMessages(id)
  }
  await assert.rejects(controller.prune(turns(data.messages)[0].sourceIDs, { reasoning: true, tools: "delete" }), /changed/)
  assert.equal(readPolicy(data.session).operations.length, 0)
  assert.equal(data.jobs, 0)
})
