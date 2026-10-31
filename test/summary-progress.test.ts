import { test } from "node:test"
import assert from "node:assert/strict"
import { summaryProgress, updateProgress, type ProgressParts } from "../src/summary-progress.ts"
import { FALLBACK_BASIS, tokenCount } from "../src/tokens.ts"
import { messages } from "./fixtures.ts"

test("summary progress tokenizes generated parts, not input, with the selected encoding", () => {
  const history = messages("ses_progress", 1)
  history[0].parts = [{ ...history[0].parts[0], type: "text", text: "DO NOT COUNT INPUT" }]
  history[1].parts = [
    { ...history[1].parts[0], type: "text", text: "Hello 世界😀" },
    { ...history[1].parts[0], type: "reasoning", text: "Review this carefully." },
  ]
  for (const encoding of ["cl100k_base", "o200k_base"] as const) {
    const basis = { ...FALLBACK_BASIS, encoding }
    assert.deepEqual(summaryProgress(history, basis), { output: tokenCount("Hello 世界😀", encoding), reasoning: tokenCount("Review this carefully.", encoding), requests: 1 })
  }
})

test("stream tokens join deltas per message, type and ordinal and may decrease", () => {
  const live: ProgressParts = new Map()
  const add = (id: string, type: "text" | "reasoning", ordinal: number, text: string, complete = false) => updateProgress(live, id, type, ordinal, text, FALLBACK_BASIS, complete)
  add("msg_a", "text", 0, "hel")
  add("msg_a", "text", 0, "lo")
  add("msg_a", "reasoning", 0, " reaso")
  assert.deepEqual(summaryProgress([], FALLBACK_BASIS, live), { output: 1, reasoning: 2, requests: 0 })
  add("msg_a", "reasoning", 0, "n")
  assert.equal(summaryProgress([], FALLBACK_BASIS, live).reasoning, 1)
  add("msg_a", "text", 1, "\ud83d")
  add("msg_a", "text", 1, "\ude00")
  add("msg_b", "text", 0, "hello")
  assert.equal(summaryProgress([], FALLBACK_BASIS, live).output, 3)
  add("msg_a", "text", 0, "", true)
  add("msg_a", "text", 0, "late delta")
  assert.equal(summaryProgress([], FALLBACK_BASIS, live).output, 2)
  add("msg_b", "reasoning", 0, "<|endoftext|>", true)
  assert.equal(summaryProgress([], FALLBACK_BASIS, live).reasoning, 1 + tokenCount("<|endoftext|>"))
})

test("stream and persisted parts overlap once across reviews and interleaved kinds", () => {
  const live: ProgressParts = new Map()
  updateProgress(live, "msg_saved", "text", 0, "hello", FALLBACK_BASIS)
  updateProgress(live, "msg_saved", "reasoning", 0, "consider", FALLBACK_BASIS)
  updateProgress(live, "msg_saved", "text", 1, " world", FALLBACK_BASIS)
  updateProgress(live, "msg_review", "text", 0, "fresh", FALLBACK_BASIS)
  const history = messages("ses_progress", 1)
  const assistant = history[1]
  assistant.info.id = "msg_saved"
  delete assistant.info.time.completed
  assistant.parts = [
    { ...assistant.parts[0], type: "reasoning", text: "" },
    { ...assistant.parts[0], type: "text", text: "" },
    { ...assistant.parts[0], type: "text", text: " world" },
  ]
  const reading = () => summaryProgress(history, FALLBACK_BASIS, live)
  assert.deepEqual(reading(), { output: 3, reasoning: 1, requests: 1 })
  assistant.parts[1] = { ...assistant.parts[1], type: "text", text: "hello" }
  assert.equal(reading().output, 3)
  assistant.info.time.completed = 10
  assistant.parts[1] = { ...assistant.parts[1], type: "text", text: "" }
  assert.deepEqual(reading(), { output: 2, reasoning: 0, requests: 1 })
})

test("stream parts retain their helper tokenizer across later model changes", () => {
  const live: ProgressParts = new Map()
  const text = "世界😀"
  updateProgress(live, "msg_old", "text", 0, text, { ...FALLBACK_BASIS, encoding: "cl100k_base" })
  updateProgress(live, "msg_new", "text", 0, text, FALLBACK_BASIS)
  assert.equal(summaryProgress([], FALLBACK_BASIS, live).output, tokenCount(text, "cl100k_base") + tokenCount(text, "o200k_base"))
})
