import { test } from "node:test"
import assert from "node:assert/strict"
import { Message, ToolCallPart } from "@opencode/ai"
import type { SessionMessageInfo } from "@opencode/client"
import { append, emptyPolicy, operation, project, activeMessages, type Mode } from "../src/context.ts"
import { projectRequest, validateNativePolicy } from "../src/projection.ts"
import { transcriptView } from "../src/normalize.ts"
import { nativeSession } from "./native-fixtures.ts"
import { pruneRule } from "./fixtures.ts"

function fixture() {
  const native: SessionMessageInfo[] = [
    { id: "msg_user", type: "user", text: "Question", time: { created: 1 } },
    { id: "msg_assistant", type: "assistant", agent: "build", model: { providerID: "fixture", id: "model" }, time: { created: 2, completed: 4 }, finish: "stop", content: [
      { type: "reasoning", text: "REASON", state: { encrypted: "opaque" } },
      { type: "tool", id: "call_fixture", name: "fixture", time: { created: 2, completed: 3 }, providerState: { signature: "call-proof" }, state: { status: "completed", input: { keep: "input" }, content: [{ type: "text", text: "HEAD " + "long output ".repeat(500) + " TAIL" }, { type: "file", mime: "image/png", uri: "data:image/png;base64,AA==", name: "image.png" }] } },
      { type: "text", text: "ANSWER" },
    ] },
    { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 5 } },
    { id: "msg_next", type: "user", text: "Next", time: { created: 6 } },
  ]
  const assistant = native[1]
  assert.equal(assistant.type, "assistant")
  const tool = assistant.content[1]
  assert.equal(tool.type, "tool")
  assert.equal(tool.state.status, "completed")
  const request = [
    Message.system("Chronological system context without ID"),
    Message.make({ id: "msg_user", role: "user", content: "Question" }),
    Message.make({ id: assistant.id, role: "assistant", content: [
      { type: "reasoning", text: "REASON", providerMetadata: { fixture: { encrypted: "opaque" } } },
      ToolCallPart.make({ id: tool.id, name: tool.name, input: tool.state.input, providerMetadata: { fixture: tool.providerState! } }),
      { type: "text", text: "ANSWER", providerMetadata: { fixture: { phase: "final" } } },
    ] }),
    Message.tool({ id: tool.id, name: tool.name, result: { type: "content", value: tool.state.content }, providerMetadata: { fixture: { resultProof: "result-proof" } } }),
    Message.make({ id: "msg_next", role: "user", content: "Next" }),
  ]
  const apply = (mode: Mode, incoming = request, index = 0) => {
    const raw = transcriptView(nativeSession(), native)
    const selected = project(activeMessages(raw), emptyPolicy("ses_native"))[index]
    const op = { ...operation(mode, [selected], mode === "tool-prune" ? pruneRule({ threshold: 200, head: 15, tail: 15 }) : undefined), ...(mode === "tool-delete" ? { pruneReason: true as const } : {}) }
    const policy = append(emptyPolicy("ses_native"), op)
    validateNativePolicy(native, raw, policy)
    return projectRequest(native, raw, incoming, policy)
  }
  return { native, request, tool, assistant, apply }
}

test("all-output projection pairs ID-less results and preserves calls, text metadata and source", () => {
  const { native, request, apply } = fixture()
  const before = JSON.stringify({ native, request })
  const output = apply("tool-prune-all")
  assert.equal(JSON.stringify({ native, request }), before)
  for (const index of [0, 1, 2, 4]) assert.equal(output[index], request[index])
  const result = output[3].content[0]
  assert.equal(result.type, "tool-result")
  assert.deepEqual(result.result, { type: "text", value: "[Tool output pruned]" })
  assert.equal(result.providerMetadata, undefined)
  assert.doesNotMatch(JSON.stringify(output), /long output|image\/png/)
})

test("reasoning removal drops whole signed parts and leaves results and visible text intact", () => {
  const { request, apply } = fixture()
  const output = apply("prune-reason")
  assert.equal(output[3], request[3])
  assert.deepEqual(output[2].content, request[2].content.slice(1))
  assert.doesNotMatch(JSON.stringify(output), /REASON|encrypted/)
})

test("large pruning preserves attachments and provider result metadata and respects earlier redactions", () => {
  const { request, apply } = fixture()
  const output = apply("tool-prune")
  assert.equal(output[2], request[2])
  const result = output[3].content[0]
  assert.equal(result.type, "tool-result")
  assert.equal(result.result.type, "content")
  assert.deepEqual(result.providerMetadata, { fixture: { resultProof: "result-proof" } })
  assert.match(JSON.stringify(result.result.value[0]), /HEAD[\s\S]*middle omitted[\s\S]*TAIL/)
  assert.deepEqual(result.result.value[1], { type: "file", mime: "image/png", uri: "data:image/png;base64,AA==", name: "image.png" })
  request[3] = Message.tool({ id: "call_fixture", name: "fixture", result: { type: "text", value: "already redacted" } })
  assert.equal(apply("tool-prune")[3], request[3])
})

test("whole-call deletion removes paired results, reasoning and empty wrappers", () => {
  const { request, apply } = fixture()
  const output = apply("tool-delete")
  assert.equal(output.length, 4)
  assert.deepEqual(output[2].content, [request[2].content[2]])
  assert.doesNotMatch(JSON.stringify(output), /call_fixture|REASON/)
  request[2] = Message.make({ ...request[2], content: request[2].content.slice(0, 2) })
  assert.equal(apply("tool-delete").length, 3)
})

test("error pruning removes interruption content and attachments without changing the result kind", () => {
  const { request, tool, apply } = fixture()
  tool.state = { status: "error", input: {}, error: { type: "tool.execution", message: "ERROR_SECRET" }, content: [{ type: "text", text: "INTERRUPTED_SECRET" }, { type: "file", mime: "image/png", uri: "FILE_SECRET" }] }
  request[3] = Message.tool({ id: tool.id, name: tool.name, result: { type: "error", value: { error: tool.state.error, content: tool.state.content } } })
  const output = apply("tool-prune-all")
  const result = output[3].content[0]
  assert.equal(result.type, "tool-result")
  assert.equal(result.result.type, "error")
  assert.doesNotMatch(JSON.stringify(output), /SECRET/)
})

test("large error pruning uses the current canonical result and rejects unknown shapes", () => {
  const { request, tool, apply } = fixture()
  tool.state = { status: "error", input: {}, error: { type: "tool.execution", message: "RAW_SECRET" } }
  request[3] = Message.tool({ id: tool.id, name: tool.name, result: { type: "error", value: { error: { type: "tool.execution", message: "HEAD " + "redacted text ".repeat(500) }, content: [{ type: "text", text: "TAIL" }] } } })
  const output = apply("tool-prune")
  assert.doesNotMatch(JSON.stringify(output), /SECRET/)
  assert.match(JSON.stringify(output), /HEAD[\s\S]*middle omitted[\s\S]*TAIL/)
  request[3] = Message.tool({ id: tool.id, name: tool.name, result: { type: "error", value: "unexpected" } })
  assert.throws(() => apply("tool-prune"), /Unsupported error-result/)
})

test("historical streaming and running calls must settle before any edit", () => {
  const { tool, apply } = fixture()
  for (const state of [{ status: "streaming" as const, input: "{" }, { status: "running" as const, input: {}, metadata: {} }]) {
    tool.state = state
    for (const mode of ["prune-reason", "tool-prune", "tool-prune-all", "tool-delete"] as const)
      assert.throws(() => apply(mode), /settle unfinished/)
  }
})

test("projection rejects role drift, unknown calls, duplicate results and missing pairs", () => {
  const { request, apply } = fixture()
  assert.throws(() => apply("prune-reason", request.map((message) => message.id === "msg_assistant" ? Message.make({ ...message, role: "user" }) : message)), /Request role/)
  assert.throws(() => apply("prune-reason", request.map((message) => message.id === "msg_assistant" ? Message.make({ ...message, content: [...message.content, ToolCallPart.make({ id: "unknown", name: "unknown", input: {} })] }) : message)), /unexpected tool call/)
  assert.throws(() => apply("tool-prune-all", [...request, request[3]]), /Duplicate selected/)
  for (const role of ["tool", "assistant"]) assert.throws(() => apply("tool-prune-all", request.filter((message) => message.role !== role)), /absent/)
  assert.throws(() => apply("tool-prune-all", [...request.slice(0, 3), Message.tool({ id: "call_fixture", name: "wrong", result: "output" }), request[4]]), /identity/)
})

test("opaque state and failed reasoning are refused while unselected hosted results remain unchanged", () => {
  const { request, assistant, apply } = fixture()
  for (const role of ["assistant", "tool"]) assert.throws(() => apply("tool-prune-all", request.map((message) => message.role === role ? Message.make({ ...message, native: { fixture: "opaque" } }) : message)), /Opaque/)
  assistant.error = { type: "aborted", message: "interrupted" }
  assert.throws(() => apply("prune-reason"), /Failed-assistant reasoning/)
  delete assistant.error
  const result = request[3].content[0]
  assert.equal(result.type, "tool-result")
  request[3] = Message.tool({ ...result, providerExecuted: true })
  assert.throws(() => apply("tool-prune-all"), /Opaque provider-executed/)
  assert.deepEqual(apply("tool-prune-all", request, 1), request)
})

test("interrupted reasoning without a message error is not mistaken for removable visible reasoning", () => {
  const { request, assistant, apply } = fixture()
  const reasoning = assistant.content[0]
  assert.equal(reasoning.type, "reasoning")
  reasoning.time = { created: 2 }
  request[2] = Message.make({ ...request[2], content: [{ type: "text", text: reasoning.text }, ...request[2].content.slice(1)] })
  for (const mode of ["prune-reason", "tool-delete"] as const) assert.throws(() => apply(mode), /interrupted reasoning/)
  assert.ok(JSON.stringify(apply("tool-prune-all")).includes("REASON"))
})
