import { test } from "node:test"
import assert from "node:assert/strict"
import { KEY } from "../src/config.ts"
import { append, blockMessages, emptyPolicy, operation, project, readPolicy, select, turns } from "../src/context.ts"
import { snapshot } from "../src/snapshot.ts"
import { operationLabel, rangeLabel, toolStatus, turnIndex } from "../src/status.ts"
import { summaryPrompt } from "../src/summarize.ts"
import { legacyCursor, messages, pruneRule, session } from "./fixtures.ts"

test("turn status distinguishes manual pruning, eligibility and file previews without inspecting marker text", () => {
  const raw = messages()
  const first = raw[1].parts[0]
  const second = raw[3].parts[0]
  assert.ok(first.type === "tool" && first.state.status === "completed")
  assert.ok(second.type === "tool" && second.state.status === "completed")
  first.state.metadata.outputPath = "/fixture/tool-output.txt"
  second.state.output += "\n[Context manager: looks like a pruning note, but is original text]"
  const rule = pruneRule()
  const initial = project(raw, emptyPolicy("ses_test"))
  assert.equal(toolStatus(initial, rule).pruned, 0)
  assert.equal(toolStatus(initial, rule).eligible, 3)
  assert.equal(toolStatus(initial, rule).fileBacked, 1)
  const policy = append(emptyPolicy("ses_test"), operation("tool-prune", select(initial, 0, 0), rule))
  const pruned = project(raw, policy)
  assert.equal(toolStatus(pruned, rule).pruned, 1)
  assert.equal(toolStatus(pruned, rule).eligible, 2)
  assert.equal(toolStatus([pruned[0]], rule).eligible, 0)
  assert.equal(toolStatus([pruned[1]], rule).pruned, 0)
  assert.ok(toolStatus(initial, rule).pruneDelta < 0)
  const smaller = { threshold: 2000, head: 500, tail: 500 }
  assert.equal(toolStatus([pruned[0]], smaller).pruned, 1)
  assert.equal(toolStatus([pruned[0]], smaller).eligible, 1)
})

test("pending and native-cleared results are identifiable separately", () => {
  const raw = messages()
  const pending = raw[1].parts[0]
  const cleared = raw[3].parts[0]
  assert.ok(pending.type === "tool" && cleared.type === "tool" && cleared.state.status === "completed")
  pending.state = { status: "running", input: {}, time: { start: 1 } }
  cleared.state.time.compacted = 2
  cleared.state.output = "[Old tool result content cleared]"
  const status = toolStatus(turns(raw), pruneRule())
  assert.equal(status.pending, 1)
  assert.equal(status.nativeCleared, 1)
  assert.equal(status.pruned, 0)
  assert.equal(status.eligible, 1)
})

test("legacy unprune replays a subset of a wider operation without reverting unrelated summaries", () => {
  const raw = messages()
  const original = structuredClone(raw)
  const rule = pruneRule()
  let policy = append(emptyPolicy("ses_test"), operation("tool-prune", turns(raw), rule))
  const summary = { ...operation("compact", select(project(raw, policy), 2, 2)), summary: "Unrelated later summary" }
  policy = append(policy, summary)
  const before = project(raw, policy)
  const restore = operation("unprune", select(before, 1, 1))
  const after = project(raw, append(policy, restore))
  assert.deepEqual(after[0], before[0])
  assert.deepEqual(after[2], before[2])
  assert.deepEqual(after[1].messages, raw.slice(2, 4))
  assert.equal(toolStatus([after[1]], rule).pruned, 0)
  assert.equal(toolStatus([after[1]], rule).eligible, 1)
  assert.deepEqual(raw, original)
})

test("legacy unprune replays all manual layers and subsequent saved pruning", () => {
  const raw = messages()
  const rule = pruneRule()
  let policy = append(emptyPolicy("ses_test"), operation("tool-prune", turns(raw), rule))
  const once = project(raw, policy)
  policy = append(policy, operation("tool-prune", select(once, 1, 1), { threshold: 2000, head: 500, tail: 500 }))
  policy = append(policy, operation("unprune", select(project(raw, policy), 1, 1)))
  assert.deepEqual(project(raw, policy)[1].messages, raw.slice(2, 4))
  policy = append(policy, operation("tool-prune", select(project(raw, policy), 1, 1), rule))
  assert.deepEqual(project(raw, policy), once)
})

test("legacy unprune replays errors and interrupted text while preserving inputs, metadata and file references", () => {
  for (const interrupted of [false, true]) {
    const raw = messages()
    const part = raw[1].parts[0]
    assert.ok(part.type === "tool")
    part.metadata = { openai: { itemId: "fixture-error" } }
    part.state = {
      status: "error", input: { keep: "original" }, error: interrupted ? "Interrupted" : "E42!".repeat(3000),
      metadata: { outputPath: "/missing/spill-file.txt", ...(interrupted ? { interrupted: true, output: "INT_23 ".repeat(2000) } : {}) },
      time: { start: 1, end: 2 },
    }
    let policy = append(emptyPolicy("ses_test"), operation("tool-prune", select(turns(raw), 0, 0), pruneRule()))
    policy = append(policy, operation("unprune", select(project(raw, policy), 0, 0)))
    assert.deepEqual(blockMessages(project(raw, policy)), raw)
  }
})

test("expansion restores one exact layer, preserving previous pruning, nested summaries and unrelated later changes", () => {
  const raw = messages("ses_test", 4)
  const rule = pruneRule()
  let policy = append(emptyPolicy("ses_test"), operation("tool-prune", select(turns(raw), 0, 0), rule))
  const originalFirstTwo = project(raw, policy).slice(0, 2)
  const inner = { ...operation("compact", select(project(raw, policy), 0, 1)), summary: "Inner summary" }
  policy = append(policy, inner)
  const innerView = project(raw, policy)[0]
  const outer = { ...operation("brief", select(project(raw, policy), 0, 1)), summary: "Outer summary" }
  policy = append(policy, outer)
  policy = append(policy, operation("tool-prune", select(project(raw, policy), 1, 1), rule))
  const unrelated = project(raw, policy)[1]
  policy = append(policy, operation("expand", select(project(raw, policy), 0, 0)))
  const expanded = project(raw, policy)
  assert.deepEqual(expanded[0], innerView)
  assert.equal(expanded[0].summaryID, inner.id)
  assert.deepEqual(expanded[2], unrelated)
  policy = append(policy, operation("expand", select(expanded, 0, 0)))
  const full = project(raw, policy)
  assert.deepEqual(full.slice(0, 2), originalFirstTwo)
  assert.equal(toolStatus([full[0]], rule).pruned, 1)
  assert.equal(toolStatus([full[0]], rule).eligible, 0)
  assert.deepEqual(full[3], unrelated)
})

test("mixed-range expansion expands every selected visible summary but leaves ordinary turns alone", () => {
  const raw = messages()
  let policy = append(emptyPolicy("ses_test"), { ...operation("compact", select(turns(raw), 0, 0)), summary: "First" })
  policy = append(policy, { ...operation("brief", select(project(raw, policy), 2, 2)), summary: "Last" })
  const selected = project(raw, policy)
  const expand = operation("expand", select(selected, 0, 2))
  assert.equal(expand.summaryIDs?.length, 2)
  const after = project(raw, append(policy, expand))
  assert.deepEqual(blockMessages(after), raw)
  assert.deepEqual(after[1], selected[1])
  assert.throws(() => project(raw, append(policy, { ...expand, summaryIDs: ["not-visible"] })), /no longer available/)
})

test("expansion restores pruning signatures even when omission notes exceed the pruning threshold", () => {
  const raw = messages()
  const rule = { threshold: 30, head: 5, tail: 5 }
  let policy = append(emptyPolicy("ses_test"), operation("tool-prune", select(turns(raw), 0, 0), rule))
  const before = project(raw, policy)[0]
  policy = append(policy, { ...operation("brief", [before]), summary: "Short" })
  policy = append(policy, operation("expand", select(project(raw, policy), 0, 0)))
  assert.deepEqual(project(raw, policy)[0], before)
  assert.equal(toolStatus([project(raw, policy)[0]], rule).eligible, 0)
})

test("legacy unprune on a mixed selection does not reach inside summaries", () => {
  const raw = messages()
  const rule = pruneRule()
  let policy = append(emptyPolicy("ses_test"), operation("tool-prune", turns(raw), rule))
  policy = append(policy, { ...operation("compact", select(project(raw, policy), 0, 0)), summary: "Keep this summary" })
  const before = project(raw, policy)
  policy = append(policy, operation("unprune", select(before, 0, 2)))
  const after = project(raw, policy)
  assert.deepEqual(after[0], before[0])
  assert.deepEqual(blockMessages(after.slice(1)), raw.slice(2))
  policy = append(policy, operation("expand", select(after, 0, 0)))
  assert.equal(toolStatus([project(raw, policy)[0]], rule).pruned, 1)
})

test("legacy saved cursors and unprune operations replay; new edits discard inactive legacy operations", () => {
  const raw = messages()
  const rule = pruneRule()
  let policy = append(emptyPolicy("ses_test"), operation("tool-prune", turns(raw), rule))
  const pruned = project(raw, policy)
  policy = append(policy, operation("unprune", select(pruned, 1, 1)))
  const restored = project(raw, policy)
  const undone = legacyCursor(policy, -1)
  assert.deepEqual(project(raw, undone), pruned)
  assert.deepEqual(project(raw, legacyCursor(undone, 1)), restored)
  const branch = append(undone, { ...operation("brief", select(pruned, 2, 2)), summary: "New branch" })
  assert.equal(branch.operations.length, 2)
  assert.equal(branch.operations[1].mode, "brief")
})

test("version-1 histories remain readable and new writes use version 6", () => {
  const raw = messages()
  const op = operation("tool-prune", select(turns(raw), 0, 0), { threshold: 8000, head: 2000, tail: 2000 })
  const legacy = { ...emptyPolicy("ses_test"), version: 1 as const, revision: 1, cursor: 1, operations: [op] }
  assert.equal(readPolicy({ ...session(), metadata: { [KEY]: legacy } }).version, 1)
  const restore = operation("unprune", select(project(raw, legacy), 0, 0))
  const next = append(legacy, restore)
  assert.equal(next.version, 6)
  assert.deepEqual(blockMessages(project(raw, next)), raw)
  assert.throws(() => readPolicy({ ...session(), metadata: { [KEY]: { ...next, version: 1 } } }), /version 2/)
})

test("hidden expansion provenance never enters effective dumps or summarizer input", () => {
  const raw = messages()
  const part = raw[1].parts[0]
  assert.ok(part.type === "tool" && part.state.status === "completed")
  part.state.output = "HIDDEN_ORIGINAL_PAYLOAD"
  const policy = append(emptyPolicy("ses_test"), { ...operation("compact", select(turns(raw), 0, 0)), summary: "Visible summary only" })
  const blocks = project(raw, policy)
  assert.ok(JSON.stringify(blocks[0].previous).includes("HIDDEN_ORIGINAL_PAYLOAD"))
  assert.ok(!JSON.stringify(snapshot("ses_test", "1.18.32", blocks, policy)).includes("HIDDEN_ORIGINAL_PAYLOAD"))
  assert.ok(!summaryPrompt(operation("brief", select(blocks, 0, 0)), blocks).includes("HIDDEN_ORIGINAL_PAYLOAD"))
})

test("source-turn spans keep action labels meaningful after summary collapse", () => {
  const raw = messages()
  const index = turnIndex(raw)
  const op = operation("tool-prune", select(turns(raw), 0, 1), pruneRule())
  assert.equal(rangeLabel(op.sourceIDs, index), "Turns 1–2")
  assert.equal(operationLabel(op, index), "tool-prune: Turns 1–2")
  assert.equal(operationLabel(undefined, index), "nothing")
  const collapsed = project(raw, append(emptyPolicy("ses_test"), { ...operation("brief", select(turns(raw), 0, 1)), summary: "First two" }))
  assert.equal(rangeLabel(collapsed[1].sourceIDs, index), "Turn 3")
})
