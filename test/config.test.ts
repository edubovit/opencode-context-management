import { test } from "node:test"
import assert from "node:assert/strict"
import { settings } from "../src/config.ts"
import { suppliedOptions } from "./fixtures.ts"

test("supplied plugin options preserve all numeric token budgets without conversion", () => {
  const config = settings(suppliedOptions)
  assert.equal(config.prune.threshold, 5000)
  assert.deepEqual(config.prune, suppliedOptions.prune)
  assert.deepEqual(config.spill, suppliedOptions.spill)
  assert.deepEqual(config.summarizer, suppliedOptions.summarizer)
  assert.deepEqual(settings(config), config)
  assert.equal(config.tokenizer.fallbackEncoding, "o200k_base")
})

test("pruning configuration rejects the obsolete unit field instead of supporting old formats", () => {
  for (const unit of ["tokens", "characters", "bytes", null])
    assert.throws(() => settings({ prune: { ...suppliedOptions.prune, unit } }), /Unknown setting: unit/)
})

test("summarizer configuration has no output reserve or replacement output limit", () => {
  assert.equal(Object.hasOwn(settings().summarizer, "outputReserve"), false)
  assert.throws(() => settings({ summarizer: { outputReserve: 20000 } }), /Unknown setting: outputReserve/)
})

test("pruning defaults and partial settings always use token units", () => {
  for (const input of [undefined, {}, { spill: {}, prune: {} }]) {
    assert.deepEqual(settings(input).spill, suppliedOptions.spill)
    assert.deepEqual(settings(input).prune, suppliedOptions.prune)
  }
  assert.deepEqual(settings({ prune: { threshold: 8000 } }).prune, { threshold: 8000, head: 1000, tail: 1000 })
  assert.deepEqual(settings({ prune: { head: 0 } }).prune, { threshold: 5000, head: 0, tail: 1000 })
  assert.deepEqual(settings({ prune: { threshold: 2000, head: 500, tail: 500 } }).prune, { threshold: 2000, head: 500, tail: 500 })
  assert.throws(() => settings({ prune: { threshold: 2000 } }), /below/)
  assert.throws(() => settings({ prune: { head: -1 } }), /integer/)
  assert.throws(() => settings({ prune: { threshold: 5000.5 } }), /integer/)
})

test("turn row limit defaults to four and accepts only safe integers of at least three", () => {
  assert.deepEqual(settings().ui, { maxLinesPerTurn: 4 })
  for (const maxLinesPerTurn of [3, 4, 8, 100]) {
    const config = settings({ ui: { maxLinesPerTurn } })
    assert.equal(config.ui.maxLinesPerTurn, maxLinesPerTurn)
    assert.deepEqual(settings(config), config)
  }
  for (const maxLinesPerTurn of [0, 1, 2, -1, 3.5, "4", null, Infinity, NaN])
    assert.throws(() => settings({ ui: { maxLinesPerTurn } }), /ui.maxLinesPerTurn/)
  assert.throws(() => settings({ ui: { unknown: 4 } }), /Unknown setting/)
})
