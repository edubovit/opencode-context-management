import { test } from "node:test"
import assert from "node:assert/strict"
import { Media, Message, type ToolResultPart } from "@opencode/ai"
import { budgetUnits, estimateBudget, type BudgetState } from "../src/budget.ts"
import { FALLBACK_BASIS, tokenCount } from "../src/tokens.ts"
import { syntheticImage } from "./media-fixture.ts"

const result = (value: ToolResultPart["result"]) => Message.tool({ id: "call_media", name: "screenshot", result: value })
const measure = (message: Message) => budgetUnits([message], [], {}, FALLBACK_BASIS).at(-1)!

test("typed tool-result images use the same allowance as direct media, never encoded-byte text counts", () => {
  const image = result({ type: "content", value: [syntheticImage] })
  const before = JSON.stringify(image)
  const direct = Message.user([Message.media(Media.base64(syntheticImage.uri.split(",")[1], syntheticImage.mime))])
  assert.equal(measure(image).tokens, measure(direct).tokens)
  assert.equal(measure(image).tokens, 1500)
  assert.equal(JSON.stringify(image), before)
  const short = result({ type: "content", value: [{ ...syntheticImage, uri: "data:image/png;base64,AA==" }] })
  assert.equal(measure(short).tokens, measure(image).tokens)
  assert.notEqual(measure(short).key, measure(image).key, "Media identity must survive count normalization")
})

test("mixed tool content counts every text part and image/PDF without tokenizing file locations", () => {
  const first = { type: "text" as const, text: "Screenshot captured. 漢字 😀" }
  const last = { type: "text" as const, text: "Read the document next." }
  const pdf = { type: "file" as const, mime: "application/pdf", uri: syntheticImage.uri.replace("image/png", "application/pdf") }
  const message = result({ type: "content", value: [first, syntheticImage, pdf, syntheticImage, last] })
  assert.equal(measure(message).tokens, tokenCount(first.text) + tokenCount(last.text) + 5000)
  const remote = result({ type: "content", value: [{ ...syntheticImage, uri: "https://fixture.invalid/image.png?" + "long-query".repeat(10000) }] })
  assert.equal(measure(remote).tokens, 1500)
  assert.equal(measure(result({ type: "content", value: [] })).tokens, 0)
})

test("text, JSON, errors and tool inputs still count base64 that is actually serialized as text", () => {
  for (const value of [
    { type: "text" as const, value: syntheticImage.uri },
    { type: "json" as const, value: { content: [syntheticImage] } },
    { type: "error" as const, value: { error: { message: "Failed" }, content: [syntheticImage] } },
  ]) {
    assert.equal(measure(result(value)).tokens, tokenCount(JSON.stringify(value)))
    assert.ok(measure(result(value)).tokens > 1_000_000)
  }
  assert.equal(measure(result({ type: "content", value: [{ type: "text", text: syntheticImage.uri }] })).tokens, tokenCount(syntheticImage.uri))
  const input = { data: syntheticImage.uri }
  assert.equal(measure(Message.assistant([{ type: "tool-call", id: "call", name: "upload", input }])).tokens, tokenCount(JSON.stringify(input)))
})

test("a new screenshot after a 27k provider report does not manufacture a million-token overload", () => {
  const state: BudgetState = { version: 2, scope: "fixture", anchor: { reportID: "msg_report", prefix: { length: 0, hash: "" }, policy: "original", input: 26959, output: 53, inputLocal: 29799, matched: true, units: [{ key: "earlier", tokens: 29840 }] } }
  const image = measure(result({ type: "content", value: [{ type: "text", text: "Screenshot attached." }, syntheticImage] }))
  const reading = estimateBudget([...state.anchor!.units, image], state, 1.3)
  assert.ok(reading.tokens < 35000, JSON.stringify(reading))
  assert.ok(reading.tokens >= 27012)
  assert.equal(reading.added, image.tokens)
  const sampled: BudgetState = { ...state, anchor: { ...state.anchor!, input: 32000, output: 53, units: [...state.anchor!.units, image], inputLocal: 29840 + image.tokens } }
  const removed = estimateBudget(state.anchor!.units, sampled, 1.3)
  assert.equal(removed.removed, image.tokens)
  assert.ok(removed.tokens > 30000, "Removing an image cannot invent credit for its encoded bytes")
})
