import { test } from "node:test"
import assert from "node:assert/strict"
import { breakdown, budgetView, compactCount, meter } from "../src/inspector-view.ts"
import { distribution } from "../src/metrics.ts"
import { turns } from "../src/context.ts"
import type { RuntimeCapture } from "../src/storage.ts"
import { messages, model, session } from "./fixtures.ts"

test("compact display counts preserve scale and the meter clamps without changing its input", () => {
  assert.deepEqual([0, 999, 1000, 15300, 206808, 1050000].map(compactCount), ["0", "999", "1k", "15.3k", "206.8k", "1.1M"])
  assert.equal(meter(25, 100, 8), "━━──────")
  assert.equal(meter(112, 100, 8), "━━━━━━━━")
  assert.equal(meter(0, 100, 8), "────────")
})

test("breakdown groups only measured text and retains the exact total", () => {
  const data = distribution(turns(messages()))
  const rows = breakdown(data)
  assert.ok(rows.length <= 4)
  assert.equal(rows.reduce((sum, row) => sum + row.value, 0), data.total)
  assert.equal(rows[0].label, "Tool results")
  assert.equal(rows.at(-1)?.label, "Other")
  assert.deepEqual(breakdown(distribution([])), [])
})

function loaded() {
  const runtime: RuntimeCapture = {
    sessionID: "ses_test", time: 1, warnings: [], model: { providerID: "test", modelID: "model" }, variant: "high",
    budget: { tokens: 100000, local: 80000, source: "provider-matched", multiplier: 1.3, added: 0, removed: 0 },
  }
  return { session: session(), models: [model()], runtime }
}

test("last-request forecast is separate from local counts and uses the input budget minus headroom", () => {
  const data = loaded()
  const display = budgetView(data, { strategy: "AUTO_PER_TURN" }, 20000)
  assert.equal(display.label, "Last request guard")
  assert.equal(display.tokens, 100000)
  assert.equal(display.threshold, 148000)
  assert.equal(display.source, "Provider-based estimate")
  data.models[0].limit.input = 180000
  assert.equal(budgetView(data, { strategy: "AUTO_PER_TURN" }, 20000).threshold, 160000)
})

test("live pauses use their frozen threshold and reading, not the last capture or current model limits", () => {
  const display = budgetView(loaded(), { strategy: "MANUAL", pause: {
    id: "pause", userID: "msg_user", phase: "manual", tokens: 670000, threshold: 600000, inputLimit: 620000, derived: false, message: "Reduce context",
    accounting: { tokens: 670000, local: 530000, source: "local-fallback", multiplier: 1.3, added: 530000, removed: 0 },
  } }, 20000)
  assert.equal(display.label, "Live guard")
  assert.equal(display.tokens, 670000)
  assert.equal(display.threshold, 600000)
  assert.equal(display.source, "Local estimate ×1.3")
})

test("missing usage, changed models, and invalid limits never get a misleading percentage", () => {
  assert.equal(budgetView(undefined, { strategy: "MANUAL" }, 20000).tokens, undefined)
  for (const change of ["model", "variant", "provider", "limits"] as const) {
    const data = loaded()
    if (change === "model") data.session.model!.id = "changed"
    if (change === "provider") data.session.model!.providerID = "changed"
    if (change === "variant") data.session.model!.variant = "low"
    if (change === "limits") data.models[0].limit.context = 0
    const display = budgetView(data, { strategy: "AUTO_PER_TURN" }, 20000)
    assert.equal(display.threshold, undefined)
    assert.equal(display.tokens, 100000)
    assert.ok(display.note)
  }
})

test("a live pause without accounting never borrows an older provider calibration", () => {
  const display = budgetView(loaded(), { strategy: "MANUAL", pause: {
    id: "pause", userID: "msg_user", phase: "manual", tokens: 123, threshold: 100, inputLimit: 200, derived: false, message: "Reduce context",
  } }, 20)
  assert.equal(display.tokens, 123)
  assert.equal(display.source, "Local estimate")
})
