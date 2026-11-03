import { test } from "node:test"
import assert from "node:assert/strict"
import { COMPACTION_MODES, selectedModes, toggleMode } from "../src/compaction.ts"

test("split and merge append standalone choices without shifting existing modes", () => {
  assert.deepEqual(COMPACTION_MODES.slice(4).map(mode => mode.name), [
    "Summarize (detailed)", "Summarize (brief)", "Delete",
    "Isolated summarization (head included)", "Isolated summarization (total)",
    "Split into subturns", "Merge subturns",
  ])
  const summary = { kind: "summary", mode: "brief", isolation: "head" } as const
  const split = toggleMode(summary, 9)
  assert.deepEqual(split, { kind: "split" })
  assert.deepEqual(selectedModes(split), [9])
  assert.deepEqual(toggleMode(split, 7), split)
  const merge = toggleMode(split, 10)
  assert.deepEqual(merge, { kind: "merge" })
  assert.deepEqual(selectedModes(merge), [10])
  assert.deepEqual(toggleMode(merge, 8), merge)
  assert.deepEqual(toggleMode(merge, 0), { kind: "prune", reasoning: true })
  assert.deepEqual(toggleMode(merge, 4), { kind: "summary", mode: "compact" })
})
