import { test } from "node:test"
import assert from "node:assert/strict"
import { Message, ToolCallPart, ToolResultPart } from "@opencode/ai"
import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client"
import { Activity } from "../src/v2/activity.ts"
import { Gates } from "../src/v2/gates.ts"
import { fingerprint, history, protectedMessages } from "../src/v2/history.ts"
import { readPolicy } from "../src/context.ts"
import { KEY } from "../src/config.ts"
import { pruneRequest, type RequestPruning } from "../src/v2/request.ts"
import { TOKENIZER_ID } from "../src/tokens.ts"

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
    Message.tool(ToolResultPart.make({ id: tool.id, name: tool.name, result: { type: "content", value: tool.state.content }, providerMetadata: { fixture: { resultProof: "result-proof" } } })),
    Message.make({ id: "msg_next", role: "user", content: "Next" }),
  ]
  const input: RequestPruning = { sourceIDs: ["msg_user", "msg_assistant"], fingerprint: fingerprint(native), modes: { reasoning: true, tools: "all" } }
  return { native, request, input }
}

test("V2 all-output projection pairs ID-less results, preserves calls and never mutates source", () => {
  const { native, request, input } = fixture()
  const before = JSON.stringify({ native, request })
  const output = pruneRequest(native, request, input)
  assert.equal(JSON.stringify({ native, request }), before)
  assert.equal(output[0], request[0])
  assert.equal(output[1], request[1])
  assert.equal(output.at(-1), request.at(-1))
  assert.deepEqual(output[2].content[0], request[2].content[1])
  assert.deepEqual(output[2].content[1], request[2].content[2])
  const result = output[3].content[0]
  assert.equal(result.type, "tool-result")
  assert.deepEqual(result.result, { type: "text", value: "[Tool output pruned]" })
  assert.equal(result.providerMetadata, undefined)
  assert.ok(!JSON.stringify(output).includes("opaque"))
  assert.ok(!JSON.stringify(output).includes("long output"))
  assert.ok(!JSON.stringify(output).includes("image/png"))
})

test("V2 reasoning-only leaves outputs, attachments, calls and text metadata intact", () => {
  const { native, request, input } = fixture()
  input.modes = { reasoning: true }
  const output = pruneRequest(native, request, input)
  assert.equal(output[3], request[3])
  assert.deepEqual(output[2].content[0], request[2].content[1])
  assert.deepEqual(output[2].content[1], request[2].content[2])
})

test("V2 large pruning preserves result files and metadata and is idempotent below threshold", () => {
  const { native, request, input } = fixture()
  input.modes = { reasoning: false, tools: "large" }
  input.rule = { unit: "tokens", threshold: 200, head: 15, tail: 15, encoding: "o200k_base", library: TOKENIZER_ID }
  const output = pruneRequest(native, request, input)
  assert.equal(output[2], request[2])
  const result = output[3].content[0]
  assert.equal(result.type, "tool-result")
  assert.equal(result.result.type, "content")
  assert.deepEqual(result.providerMetadata, { fixture: { resultProof: "result-proof" } })
  assert.equal(result.result.value[0].type, "text")
  assert.match(result.result.value[0].text, /HEAD[\s\S]*middle omitted[\s\S]*TAIL/)
  assert.deepEqual(result.result.value[1], { type: "file", mime: "image/png", uri: "data:image/png;base64,AA==", name: "image.png" })
  assert.deepEqual(pruneRequest(native, output, input), output)
})

test("V2 deletion removes both halves and empty wrappers but preserves visible text", () => {
  const { native, request, input } = fixture()
  input.modes = { reasoning: true, tools: "delete" }
  const output = pruneRequest(native, request, input)
  assert.equal(output.length, 4)
  assert.deepEqual(output[2].content, [request[2].content[2]])
  assert.ok(!JSON.stringify(output).includes("call_fixture"))
  request[2] = Message.make({ ...request[2], content: request[2].content.slice(0, 2) })
  assert.equal(pruneRequest(native, request, input).length, 3)
})

test("V2 no-op pruning preserves request objects and requires complete source identity", () => {
  const { native, request, input } = fixture()
  input.modes = { reasoning: true }
  input.sourceIDs = ["msg_next"]
  const output = pruneRequest(native, request, input)
  assert.ok(output.every((message, index) => message === request[index]))
  input.sourceIDs = ["msg_missing"]
  assert.throws(() => pruneRequest(native, request, input), /no longer exists/)
})

test("V2 error pruning removes interruption text and preserves error result kind", () => {
  const { native, request, input } = fixture()
  const assistant = native[1]
  assert.equal(assistant.type, "assistant")
  const tool = assistant.content[1]
  assert.equal(tool.type, "tool")
  tool.state = { status: "error", input: { keep: "input" }, error: { type: "tool.execution", message: "ERROR_SECRET" }, content: [{ type: "text", text: "INTERRUPTED_SECRET" }, { type: "file", mime: "image/png", uri: "FILE_SECRET" }] }
  input.fingerprint = fingerprint(native)
  request[3] = Message.tool({ id: tool.id, name: tool.name, result: { type: "error", value: { error: tool.state.error, content: tool.state.content } } })
  const output = pruneRequest(native, request, input)
  const result = output[3].content[0]
  assert.equal(result.type, "tool-result")
  assert.equal(result.result.type, "error")
  assert.ok(!JSON.stringify(output).includes("SECRET"))
  assert.match(JSON.stringify(result.result), /Tool output pruned/)
})

test("V2 pending calls survive result pruning and disappear only in delete mode", () => {
  const { native, request, input } = fixture()
  const assistant = native[1]
  assert.equal(assistant.type, "assistant")
  const tool = assistant.content[1]
  assert.equal(tool.type, "tool")
  tool.state = { status: "streaming", input: "{" }
  input.fingerprint = fingerprint(native)
  request.splice(3, 1)
  assert.ok(JSON.stringify(pruneRequest(native, request, input)).includes("call_fixture"))
  input.modes = { reasoning: true, tools: "delete" }
  assert.ok(!JSON.stringify(pruneRequest(native, request, input)).includes("call_fixture"))
})

test("V2 large error pruning uses current hook content, never resurrects native unredacted text", () => {
  const { native, request, input } = fixture()
  input.modes = { reasoning: false, tools: "large" }
  input.rule = { unit: "tokens", threshold: 200, head: 15, tail: 15, encoding: "o200k_base", library: TOKENIZER_ID }
  const assistant = native[1]
  assert.equal(assistant.type, "assistant")
  const tool = assistant.content[1]
  assert.equal(tool.type, "tool")
  tool.state = { status: "error", input: {}, error: { type: "tool.execution", message: "RAW_SECRET" }, content: [{ type: "text", text: "RAW_INTERRUPTED_SECRET" }] }
  input.fingerprint = fingerprint(native)
  request[3] = Message.tool({ id: tool.id, name: tool.name, result: { type: "error", value: { error: { type: "tool.execution", message: "HEAD " + "already redacted text ".repeat(500) }, content: [{ type: "text", text: "TAIL" }] } } })
  const output = pruneRequest(native, request, input)
  assert.ok(!JSON.stringify(output).includes("SECRET"))
  assert.match(JSON.stringify(output), /HEAD[\s\S]*middle omitted[\s\S]*TAIL/)
  request[3] = Message.tool({ id: tool.id, name: tool.name, result: { type: "error", value: "unexpected" } })
  assert.throws(() => pruneRequest(native, request, input), /Unsupported error-result/)
})

test("V2 rejects role drift, extra selected calls, and opaque ID-less result wrappers", () => {
  const { native, request, input } = fixture()
  const role = request.map((message) => message.id === "msg_assistant" ? Message.make({ ...message, role: "user" }) : message)
  assert.throws(() => pruneRequest(native, role, input), /Request role/)
  const extra = request.map((message) => message.id === "msg_assistant" ? Message.make({ ...message, content: [...message.content, ToolCallPart.make({ id: "unknown", name: "unknown", input: {} })] }) : message)
  assert.throws(() => pruneRequest(native, extra, input), /Unexpected tool/)
  const opaque = request.map((message) => message.role === "tool" ? Message.make({ ...message, native: { fixture: "opaque" } }) : message)
  assert.throws(() => pruneRequest(native, opaque, input), /opaque/)
})

test("V2 rejects unsafe modes, stale/protected selection, and missing call/result pairs", () => {
  const { native, request, input } = fixture()
  for (const modes of [{ reasoning: false }, { reasoning: false, tools: "delete" as const }, { reasoning: false, tools: "large" as const }])
    assert.throws(() => pruneRequest(native, request, { ...input, modes }))
  assert.throws(() => pruneRequest(native, request, { ...input, fingerprint: "stale" }), /source changed/)
  assert.throws(() => pruneRequest(native, request, { ...input, protectedIDs: new Set(["msg_user"]) }), /protected/)
  assert.throws(() => pruneRequest(native, request, { ...input, sourceIDs: [] }), /selection/)
  assert.throws(() => pruneRequest(native, request, { ...input, sourceIDs: ["msg_user", "msg_user"] }), /selection/)
  assert.throws(() => pruneRequest(native, request.filter((message) => message.role !== "tool"), input), /result is absent/)
  assert.throws(() => pruneRequest(native, request.filter((message) => message.role !== "assistant"), input), /message is absent/)
  assert.throws(() => pruneRequest(native, [...request, request[3]], input), /Duplicate selected/)
  const wrong = Message.tool({ id: "call_fixture", name: "wrong", result: "output" })
  assert.throws(() => pruneRequest(native, [...request.slice(0, 3), wrong], input), /identity/)
})

test("V2 refuses checkpoints, ambiguous identities and opaque or failed reasoning", () => {
  const { native, request, input } = fixture()
  const checkpoint: SessionMessageInfo = { id: "msg_checkpoint", type: "compaction", status: "completed", reason: "manual", summary: "summary", recent: "", time: { created: 0 } }
  assert.throws(() => pruneRequest([checkpoint, ...native], request, { ...input, fingerprint: fingerprint([checkpoint, ...native]) }), /checkpoints/)
  assert.throws(() => pruneRequest(native, request.map((message) => message.id === "msg_assistant" ? Message.make({ ...message, native: { fixture: "opaque" } }) : message), input), /opaque/)
  const assistant = native[1]
  assert.equal(assistant.type, "assistant")
  assistant.error = { type: "aborted", message: "interrupted" }
  assert.throws(() => pruneRequest(native, request, { ...input, fingerprint: fingerprint(native) }), /Failed-assistant reasoning/)
  delete assistant.error
  native.push({ ...assistant, id: "msg_duplicate_call" })
  assert.throws(() => pruneRequest(native, request, { ...input, fingerprint: fingerprint(native) }), /Ambiguous tool/)
})

test("V2 leaves unselected hosted tools untouched and rejects unverified hosted-output pruning", () => {
  const { native, request, input } = fixture()
  const result = request[3].content[0]
  assert.equal(result.type, "tool-result")
  request[3] = Message.tool({ ...result, providerExecuted: true })
  assert.throws(() => pruneRequest(native, request, input), /Provider-executed/)
  assert.deepEqual(pruneRequest(native, request, { ...input, sourceIDs: ["msg_next"] }), request)
})

test("V2 fingerprints canonicalize object keys and protect all steered inputs since idle", () => {
  const { native } = fixture()
  assert.equal(fingerprint(native), fingerprint(JSON.parse(JSON.stringify(native, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value))))
  assert.deepEqual([...protectedMessages(native)], ["msg_next"])
  const next: SessionMessageInfo = { id: "msg_steered", type: "user", text: "Steered", time: { created: 7 } }
  assert.deepEqual([...protectedMessages([...native, next])], ["msg_next", "msg_steered"])
  assert.deepEqual([...protectedMessages(native.slice(0, 2))], ["msg_user", "msg_assistant"])
  assert.deepEqual([...protectedMessages(native.slice(0, 3))], [])
})

test("V2 refuses legacy policies without modifying or silently resetting them", () => {
  assert.equal(readPolicy({ id: "ses_test", nativeVersion: 2 }).version, 7)
  for (const value of [null, {}, { version: 6, operations: [] }, { version: 99 }]) {
    const before = structuredClone(value)
    assert.throws(() => readPolicy({ id: "ses_test", nativeVersion: 2, metadata: { [KEY]: value } }))
    assert.deepEqual(value, before)
  }
})

test("V2 history drains every cursor in order and forwards cancellation", async () => {
  const { native } = fixture()
  const signal = new AbortController().signal
  const calls: unknown[] = []
  const client: Pick<OpenCodeClient, "message"> = { message: { list: async (input, options) => {
    calls.push(input)
    assert.equal(options?.signal, signal)
    return input.cursor ? { data: native.slice(2), cursor: { next: null } } : { data: native.slice(0, 2), cursor: { next: "page2" } }
  } } }
  assert.deepEqual(await history(client, "ses_test", signal), native)
  assert.deepEqual(calls, [{ sessionID: "ses_test", limit: 200, order: "asc" }, { sessionID: "ses_test", limit: 200, cursor: "page2" }])
})

test("V2 pagination rejects duplicates, cursor loops, failures and cancellation", async () => {
  const { native } = fixture()
  const repeated: Pick<OpenCodeClient, "message"> = { message: { list: async () => ({ data: [native[0]], cursor: { next: "same" } }) } }
  await assert.rejects(history(repeated, "ses_test"), /changed during pagination/)
  const loop: Pick<OpenCodeClient, "message"> = { message: { list: async () => ({ data: [], cursor: { next: "same" } }) } }
  await assert.rejects(history(loop, "ses_test"), /cursor repeated/)
  const failed: Pick<OpenCodeClient, "message"> = { message: { list: async () => { throw new Error("offline") } } }
  await assert.rejects(history(failed, "ses_test"), /offline/)
  const abort = new AbortController()
  abort.abort(new Error("cancelled"))
  await assert.rejects(history(failed, "ses_test", abort.signal), /cancelled/)
})

test("V2 idle observation is fresh, coalesces busy waits, and never turns a timeout into idle", async () => {
  let waiting = Promise.resolve()
  let calls = 0
  const activity = new Activity(async () => { calls++; await waiting })
  assert.equal(await activity.idle("ses_test"), true)
  let release!: () => void
  waiting = new Promise<void>((resolve) => { release = resolve })
  assert.deepEqual(await Promise.all([activity.idle("ses_test", 1), activity.idle("ses_test", 1)]), [false, false])
  assert.equal(calls, 2)
  assert.equal(await activity.idle("ses_test", 1), false)
  assert.equal(calls, 2)
  const final = activity.idle("ses_test")
  release()
  assert.equal(await final, true)
  assert.equal(await activity.idle("ses_test"), true)
  assert.equal(calls, 3)
  activity.close()
  await assert.rejects(activity.idle("ses_test"), /closed/)
})

test("V2 idle failures and cleanup fail closed and do not leave pending local observers", async () => {
  const failure = new Activity(async () => { throw new Error("missing session") })
  await assert.rejects(failure.idle("ses_missing"), /missing session/)
  await assert.rejects(failure.idle("ses_missing", -1), /Invalid/)
  failure.close()
  let release!: () => void
  const activity = new Activity(() => new Promise((resolve) => { release = resolve }))
  const result = activity.idle("ses_test", 5000)
  await Promise.resolve()
  activity.close()
  await assert.rejects(result, /closed/)
  release()
})

test("V2 gates release only the current owner and reject duplicate or stale releases", async () => {
  const gates = new Gates()
  let id = ""
  const paused = gates.pause("ses_test", (value) => { id = value })
  assert.equal(gates.current("ses_test"), id)
  await assert.rejects(gates.pause("ses_test", () => {}), /already owns/)
  assert.throws(() => gates.release("ses_test", "stale"), /no longer active/)
  gates.release("ses_test", id)
  assert.equal(gates.current("ses_test"), undefined)
  await paused
  assert.throws(() => gates.release("ses_test", id), /no longer active/)
  gates.close()
})

test("V2 old gate cleanup cannot delete a replacement; failure, native stop and unload revoke ownership", async () => {
  const gates = new Gates()
  const first = gates.pause("ses_test", () => {})
  gates.cancel("ses_test")
  const second = gates.pause("ses_test", () => {})
  const replacement = gates.current("ses_test")!
  await assert.rejects(first, /stopped/)
  assert.equal(gates.current("ses_test"), replacement)
  gates.release("ses_test", replacement)
  await second
  await assert.rejects(gates.pause("ses_test", () => { throw new Error("publish failed") }), /publish failed/)
  assert.equal(gates.current("ses_test"), undefined)
  const third = gates.pause("ses_test", () => {})
  gates.close()
  await assert.rejects(third, /unloaded/)
  await assert.rejects(gates.pause("ses_test", () => {}), /closed/)
})
