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
    assert.deepEqual(settings(input).prune, { threshold: 3000, head: 1000, tail: 500 })
  }
  assert.deepEqual(settings({ prune: { threshold: 8000 } }).prune, { threshold: 8000, head: 1000, tail: 500 })
  assert.deepEqual(settings({ prune: { head: 0 } }).prune, { threshold: 3000, head: 0, tail: 500 })
  assert.deepEqual(settings({ prune: { tail: 1000 } }).prune, { threshold: 3000, head: 1000, tail: 1000 })
  assert.deepEqual(settings({ prune: { threshold: 5000 } }).prune, { threshold: 5000, head: 1000, tail: 500 })
  assert.deepEqual(settings({ prune: { threshold: 2000 } }).prune, { threshold: 2000, head: 1000, tail: 500 })
  assert.deepEqual(settings({ prune: { threshold: 2000, head: 500, tail: 500 } }).prune, { threshold: 2000, head: 500, tail: 500 })
  assert.throws(() => settings({ prune: { threshold: 1500 } }), /below/)
  assert.throws(() => settings({ prune: { head: -1 } }), /prune.head/)
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

test("numeric settings reject coercion and explicit null instead of silently using defaults", () => {
  for (const [group, key] of [
    ["spill", "headShare"], ["spill", "maxLines"], ["spill", "maxBytes"],
    ["prune", "threshold"], ["prune", "head"], ["prune", "tail"],
    ["autocompaction", "estimateMultiplier"], ["autocompaction", "headroom"],
    ["autocompaction", "lastResortKeepTokens"], ["autocompaction", "minRangeTokens"], ["ui", "maxLinesPerTurn"],
    ["autocompaction", "splitThresholdTokens"], ["autocompaction", "maxSubturnTokens"],
    ["subturns", "minTokens"], ["subturns", "minSplitTokens"],
  ]) for (const value of ["1", true, null, [], NaN, Infinity])
    assert.throws(() => settings({ [group]: { [key]: value } }), new RegExp(`${group}.*${key}`))
  for (const group of ["spill", "prune", "autocompaction", "subturns", "ui", "tokenizer", "summarizer"])
    assert.throws(() => settings({ [group]: null }), new RegExp(group))
})

test("automatic defaults, numeric bounds and paired model settings are validated in one place", () => {
  for (const input of [undefined, {}, { autocompaction: {} }])
    assert.deepEqual(settings(input).autocompaction, {
      headroom: 30000, estimateMultiplier: 1.3, lastResortKeepTokens: 20000, minRangeTokens: 10000,
      splitThresholdTokens: 100000, maxSubturnTokens: 50000,
    })
  assert.equal(settings({ autocompaction: { minRangeTokens: 5000 } }).autocompaction.headroom, 30000)
  for (const headroom of [0, 20000, 40000]) assert.equal(settings({ autocompaction: { headroom } }).autocompaction.headroom, headroom)
  for (const minRangeTokens of [0, 5000, 20000]) assert.equal(settings({ autocompaction: { minRangeTokens } }).autocompaction.minRangeTokens, minRangeTokens)
  assert.equal(settings({ autocompaction: { lastResortKeepTokens: 0, estimateMultiplier: 1.6 } }).autocompaction.estimateMultiplier, 1.6)
  assert.equal(settings({ autocompaction: { lastResortKeepTokens: 0 } }).autocompaction.lastResortKeepTokens, 0)
  for (const key of ["headroom", "lastResortKeepTokens", "minRangeTokens"]) for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => settings({ autocompaction: { [key]: value } }), new RegExp(key))
  for (const estimateMultiplier of [0, -1]) assert.throws(() => settings({ autocompaction: { estimateMultiplier } }), /estimateMultiplier/)
  for (const headShare of [-1, 2]) assert.throws(() => settings({ spill: { headShare } }), /headShare/)
  for (const summarizer of [{ providerID: "alone" }, { modelID: "alone" }]) assert.throws(() => settings({ summarizer }), /both/)
  assert.throws(() => settings({ summarizer: { variant: " " } }), /variant/)
  assert.throws(() => settings({ madeUp: 1 }), /Unknown/)
  const first = settings()
  first.tokenizer.overrides["test/model"] = "cl100k_base"
  assert.deepEqual(settings().tokenizer.overrides, {})
})

test("subturn defaults and partial overrides preserve independent settings", () => {
  for (const input of [undefined, {}, { subturns: {} }])
    assert.deepEqual(settings(input).subturns, { minTokens: 10000, minSplitTokens: 50000 })
  assert.deepEqual(settings({ subturns: { minTokens: 12000 } }).subturns, { minTokens: 12000, minSplitTokens: 50000 })
  assert.deepEqual(settings({ subturns: { minSplitTokens: 60000 } }).subturns, { minTokens: 10000, minSplitTokens: 60000 })
  for (const [key, value] of [["splitThresholdTokens", 80000], ["maxSubturnTokens", 30000]] as const)
    assert.deepEqual(settings({ autocompaction: { [key]: value } }).autocompaction, { ...settings().autocompaction, [key]: value })
  for (const minRangeTokens of [0, 1, 9999, 10000, 50001, Number.MAX_SAFE_INTEGER]) {
    const config = settings({ autocompaction: { minRangeTokens } })
    assert.equal(config.autocompaction.minRangeTokens, minRangeTokens)
    assert.deepEqual(config.subturns, settings().subturns)
    assert.deepEqual(settings(config), config)
  }
  assert.throws(() => settings({ subturns: { unknown: 1 } }), /Unknown setting: unknown/)
})

test("subturn token budgets accept only positive safe integers", () => {
  for (const [group, key] of [
    ["subturns", "minTokens"], ["subturns", "minSplitTokens"],
    ["autocompaction", "splitThresholdTokens"], ["autocompaction", "maxSubturnTokens"],
  ]) for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, -Infinity])
    assert.throws(() => settings({ [group]: { [key]: value } }), new RegExp(`${group}\\.${key}`))
  const config = settings({
    subturns: { minTokens: 1, minSplitTokens: 2 },
    autocompaction: { splitThresholdTokens: 2, maxSubturnTokens: 1 },
  })
  assert.deepEqual(config.subturns, { minTokens: 1, minSplitTokens: 2 })
  assert.equal(config.autocompaction.splitThresholdTokens, 2)
  assert.equal(config.autocompaction.maxSubturnTokens, 1)
})

test("subturn split limits enforce inclusive cross-field constraints", () => {
  assert.throws(() => settings({ subturns: { minSplitTokens: 19999 } }), /subturns\.minSplitTokens:.*twice subturns\.minTokens/)
  assert.throws(() => settings({ subturns: { minTokens: 25001 } }), /subturns\.minSplitTokens/)
  assert.throws(() => settings({ autocompaction: { splitThresholdTokens: 49999 } }), /autocompaction\.splitThresholdTokens:.*subturns\.minSplitTokens/)
  assert.throws(() => settings({ subturns: { minSplitTokens: 100001 } }), /autocompaction\.splitThresholdTokens/)
  assert.throws(() => settings({ autocompaction: { maxSubturnTokens: 9999 } }), /autocompaction\.maxSubturnTokens:.*subturns\.minTokens/)
  assert.throws(() => settings({
    subturns: { minTokens: 50001, minSplitTokens: 100002 },
    autocompaction: { splitThresholdTokens: 100002 },
  }), /autocompaction\.maxSubturnTokens/)
  const config = settings({
    subturns: { minTokens: 30000, minSplitTokens: 60000 },
    autocompaction: { splitThresholdTokens: 60000, maxSubturnTokens: 30000 },
  })
  assert.deepEqual(config.subturns, { minTokens: 30000, minSplitTokens: 60000 })
  assert.equal(config.autocompaction.splitThresholdTokens, 60000)
  assert.equal(config.autocompaction.maxSubturnTokens, 30000)
  assert.deepEqual(settings(config), config)
})

test("subturn constraints remain exact at the safe integer boundary", () => {
  const minTokens = Math.floor(Number.MAX_SAFE_INTEGER / 2)
  const config = settings({
    subturns: { minTokens, minSplitTokens: Number.MAX_SAFE_INTEGER },
    autocompaction: { splitThresholdTokens: Number.MAX_SAFE_INTEGER, maxSubturnTokens: Number.MAX_SAFE_INTEGER },
  })
  assert.equal(config.subturns.minTokens, minTokens)
  assert.equal(config.subturns.minSplitTokens, Number.MAX_SAFE_INTEGER)
  assert.equal(config.autocompaction.splitThresholdTokens, Number.MAX_SAFE_INTEGER)
  assert.equal(config.autocompaction.maxSubturnTokens, Number.MAX_SAFE_INTEGER)
  assert.throws(() => settings({ ...config, subturns: { ...config.subturns, minTokens: minTokens + 1 } }), /subturns\.minSplitTokens/)
  assert.throws(() => settings({ ...config, autocompaction: { ...config.autocompaction, splitThresholdTokens: Number.MAX_SAFE_INTEGER - 1 } }), /autocompaction\.splitThresholdTokens/)
  assert.throws(() => settings({ ...config, autocompaction: { ...config.autocompaction, maxSubturnTokens: minTokens - 1 } }), /autocompaction\.maxSubturnTokens/)
})
