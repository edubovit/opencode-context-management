import { test } from "node:test"
import assert from "node:assert/strict"
import { turns } from "../src/context.ts"
import { anchorRanges, pressSpace, rangeIDs, rangeTag, resolveRanges, selectedBlocks, visibleRanges, type Selection } from "../src/ranges.ts"
import { messages } from "./fixtures.ts"

test("Space opens/closes in either direction, keeps adjacent ranges separate, and removes only the containing range", () => {
  const blocks = turns(messages("ses_test", 6))
  let state: Selection = { ranges: [] }
  state = pressSpace(state, 3, blocks)
  assert.equal(selectedBlocks(blocks, visibleRanges(state, 1)).length, 3)
  assert.throws(() => rangeIDs(blocks, state), /close/)
  state = pressSpace(state, 1, blocks)
  state = pressSpace(state, 4, blocks)
  state = pressSpace(state, 5, blocks)
  assert.deepEqual(state.ranges, [{ start: 1, end: 3 }, { start: 4, end: 5 }])
  state = pressSpace(state, 2, blocks)
  assert.deepEqual(state.ranges, [{ start: 4, end: 5 }])
  state = pressSpace(state, 0, blocks)
  state = pressSpace(state, 0, blocks)
  assert.deepEqual(state.ranges, [{ start: 0, end: 0 }, { start: 4, end: 5 }])
  const ids = rangeIDs(blocks, state)
  assert.deepEqual(anchorRanges(blocks, ids), state)
  assert.deepEqual(resolveRanges(blocks, ids.reverse()).map((group) => group.length), [1, 2])
})

test("overlaps are rejected and unfinished turns may start or end ranges", () => {
  const blocks = turns(messages("ses_test", 5))
  const state: Selection = { ranges: [{ start: 1, end: 2 }], anchor: 0 }
  assert.throws(() => pressSpace(state, 3, blocks), /overlap/)
  assert.equal(selectedBlocks(blocks, visibleRanges(state, 3)).length, 4)
  const ids = blocks[1].sourceIDs
  assert.throws(() => resolveRanges(blocks, [ids, ids]), /overlap/)
  assert.throws(() => resolveRanges(blocks, [[...blocks[0].sourceIDs, ...blocks[2].sourceIDs]]), /changed/)
  blocks[4].closed = false
  const open = pressSpace({ ranges: [] }, 4, blocks)
  const closed = pressSpace(open, 3, blocks)
  assert.deepEqual(closed.ranges, [{ start: 3, end: 4 }])
  assert.deepEqual(pressSpace({ ranges: [], anchor: 3 }, 4, blocks), closed)
  assert.equal(resolveRanges(blocks, rangeIDs(blocks, closed))[0][1].closed, false)
})

test("range labels distinguish every closed range and the open range", () => {
  const state: Selection = { ranges: [{ start: 0, end: 1 }, { start: 3, end: 4 }], anchor: 6 }
  assert.equal(rangeTag(state, 7, 0), "R1")
  assert.equal(rangeTag(state, 7, 4), "R2")
  assert.equal(rangeTag(state, 7, 7), "R3*")
  assert.equal(rangeTag(state, 7, 2), undefined)
})
