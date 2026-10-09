import { test } from "node:test"
import assert from "node:assert/strict"
import { turns } from "../src/context.ts"
import { turnView } from "../src/turn-view.ts"
import { messages } from "./fixtures.ts"

test("turn reading shows user text and only the last final response, without reasoning or tool activity", () => {
  const [user, final] = messages("ses_test", 1)
  const step = structuredClone(final)
  assert.ok(step.info.role === "assistant")
  step.info.id = "msg_step"
  step.info.finish = "tool-calls"
  step.parts.push({ type: "text", id: "step_text", sessionID: "ses_test", messageID: "msg_step", text: "INTERMEDIATE_COMMENTARY" })
  const original = structuredClone([user, step, final])
  assert.deepEqual(turnView(turns([user, step, final])[0]), { user: "Question 0", assistant: "Answer 0" })
  assert.deepEqual([user, step, final], original)
})

test("turn reading retains full Unicode text and all text parts without the debug display cap", () => {
  const [user, final] = messages("ses_test", 1)
  const text = "🌍α\n".repeat(40000) + "END_OF_FULL_MESSAGE"
  user.parts = [{ type: "text", id: "u", sessionID: "ses_test", messageID: user.info.id, text }]
  final.parts = [
    { type: "text", id: "a1", sessionID: "ses_test", messageID: final.info.id, text: "First paragraph" },
    { type: "text", id: "a2", sessionID: "ses_test", messageID: final.info.id, text },
  ]
  assert.deepEqual(turnView(turns([user, final])[0]), { user: text, assistant: `First paragraph\n\n${text}` })
})

test("unfinished turns never substitute earlier commentary for a final response", () => {
  const [user, earlier] = messages("ses_test", 1)
  for (const finish of [undefined, "tool-calls", "unknown"]) {
    const pending = structuredClone(earlier)
    assert.ok(pending.info.role === "assistant")
    pending.info.id = "msg_pending"
    pending.info.finish = finish
    if (!finish) pending.info.time.completed = undefined
    const view = turnView(turns([user, earlier, pending])[0])
    assert.equal(view.user, "Question 0")
    assert.match(view.assistant, /No completed final assistant response yet/)
    assert.doesNotMatch(view.assistant, /Answer 0|Visible reasoning|HEAD_0/)
  }
  assert.match(turnView(turns([user])[0]).assistant, /No completed final assistant response yet/)
})

test("attachment descriptors exclude URLs, tool attachments and binary payloads", () => {
  const [user, final] = messages("ses_test", 1)
  user.parts.push({ type: "file", id: "image", sessionID: "ses_test", messageID: user.info.id, mime: "image/png", filename: "example.png", url: "data:image/png;base64,PRIVATE_PAYLOAD" })
  const view = turnView(turns([user, final])[0])
  assert.match(view.user, /Attachment: example.png \(image\/png\)/)
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_PAYLOAD|HEAD_0|call_0/)
})

test("missing, failed and truncated final responses have honest labels", () => {
  const raw = messages("ses_test", 1)
  const final = raw[1]
  assert.ok(final.info.role === "assistant")
  final.info.finish = "length"
  assert.match(turnView(turns(raw)[0]).assistant, /output limit[\s\S]*Answer 0/)
  final.info.finish = "stop"
  final.parts = final.parts.filter((part) => part.type !== "text")
  assert.equal(turnView(turns(raw)[0]).assistant, "[No final response text recorded.]")
  final.info.error = { name: "UnknownError", data: { message: "RAW_ERROR_DETAILS" } }
  const view = turnView(turns(raw)[0])
  assert.match(view.assistant, /ended with an error/)
  assert.doesNotMatch(view.assistant, /RAW_ERROR_DETAILS/)
})

test("compacted blocks cannot be passed off as ordinary turns", () => {
  assert.throws(() => turnView({ ...turns(messages())[0], kind: "brief" }), /summary reader/)
})
