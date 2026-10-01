import { test } from "node:test"
import assert from "node:assert/strict"
import { append, emptyPolicy, operation, project, turns } from "../src/context.ts"
import { rangePreview, rangeToolStats } from "../src/range-rows.ts"
import { toolStatus } from "../src/status.ts"
import { legacyCursor, messages, pruneRule } from "./fixtures.ts"

test("ordinary row previews preserve the start of the user message without assistant/tool text", () => {
  const raw = messages("ses_test", 1)
  const text = raw[0].parts[0]
  assert.ok(text.type === "text")
  text.text = "First line\nSecond line\nThird line\nFourth line"
  raw[0].parts.unshift({ ...text, id: "ignored", ignored: true, text: "IGNORED" })
  const block = turns(raw)[0]
  assert.equal(rangePreview(block, emptyPolicy("ses_test")), text.text)
})

test("summary previews use applied revisions and legacy saved cursors, not the synthetic user introduction", () => {
  const raw = messages("ses_test", 2)
  const op = { ...operation("compact", turns(raw)), summary: "Original summary\nMore details" }
  let policy = append(emptyPolicy("ses_test"), op)
  let blocks = project(raw, policy)
  assert.equal(rangePreview(blocks[0], policy), op.summary)
  policy = append(policy, { ...operation("revise", blocks), targetID: op.id, summary: "Revised summary\nNew details" })
  blocks = project(raw, policy)
  assert.equal(rangePreview(blocks[0], policy), "Revised summary\nNew details")
  policy = legacyCursor(policy, -1)
  assert.equal(rangePreview(project(raw, policy)[0], policy), op.summary)
})

test("row tool stats hide zeros except total calls and preview text drops blank lines", () => {
  const status = toolStatus([], pruneRule())
  assert.equal(rangeToolStats(status), "tools:0")
  assert.equal(rangeToolStats({ ...status, total: 6, pruned: 2, eligible: 3, fileBacked: 1, pending: 1, nativeCleared: 2 }),
    "tools:6 · pruned:2 · large:3 · files:1 · pending:1 · native-cleared:2")
  const block = turns(messages())[0]
  const text = block.messages[0].parts[0]
  assert.ok(text.type === "text")
  text.text = "\nFirst\r\n\r\n  \nSecond\n"
  assert.equal(rangePreview(block, emptyPolicy("ses_test")), "First\nSecond")
})
