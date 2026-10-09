import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setupServer } from "../src/server.ts"
import { Storage } from "../src/storage.ts"
import { AGENT, EDIT_AGENT } from "../src/config.ts"
import { SUMMARY_EDIT_SYSTEM, SUMMARIZER_SYSTEM } from "../src/summarize.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { mockContext } from "./host-mock.ts"
import { Message } from "@opencode/ai"
import { AUTO_KEY } from "../src/auto-state.ts"

const call = { signal: new AbortController().signal, error: (...args: unknown[]) => { throw new Error(String(args[1])) } }

async function setup(t: { after(run: () => Promise<void>): void }, version = "2.0.24") {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-native-server-"))
  const mock = mockContext()
  mock.state.version = version
  const store = new Storage("/fixture", dir)
  const close = await setupServer(mock.context, store)
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }) })
  return { ...mock, store, close }
}

test("V2 setup registers tool-denied hidden helpers and separate model request hooks", async (t) => {
  const mock = await setup(t)
  assert.equal(mock.agents.get(AGENT)?.system, SUMMARIZER_SYSTEM)
  assert.equal(mock.agents.get(EDIT_AGENT)?.system, SUMMARY_EDIT_SYSTEM)
  for (const id of [AGENT, EDIT_AGENT]) {
    assert.equal(mock.agents.get(id)?.hidden, true)
    assert.deepEqual(mock.agents.get(id)?.permissions, [{ action: "*", resource: "*", effect: "deny" }])
    assert.equal(mock.agents.get(id)?.steps, undefined)
  }
  for (const name of ["context", "generate", "compaction", "execute.after"]) assert.ok(mock.hooks.has(name))
  await assert.rejects(async () => mock.hooks.get("compaction")!({}), /compaction.auto/)
})

test("V2 context capture preserves both omitted and numeric provider output caps", async (t) => {
  const mock = await setup(t)
  const data = nativeFixture()
  mock.messages.set("ses_native", data.native)
  for (const options of [{}, { maxTokens: 32000 }, { maxTokens: 1024, reasoningEffort: "high" }]) {
    const event = { sessionID: "ses_native", agent: "build", model: { providerID: "fixture", id: "model" }, system: [{ type: "text", text: "Actual system" }], messages: data.canonical, tools: { fixture: { description: "Fixture tool", input: { type: "object" } } }, options }
    const before = JSON.stringify(options)
    await mock.hooks.get("context")!(event)
    assert.equal(JSON.stringify(options), before)
    assert.deepEqual(event.messages, data.canonical)
  }
  const captured = await mock.store.capture("ses_native")
  assert.ok(captured?.system?.includes("Actual system"))
  assert.equal(captured?.tools?.[0].id, "fixture")
})

test("V2 summary helpers receive isolated system context and no advertised tools", async (t) => {
  const mock = await setup(t)
  mock.sessions.get("ses_native")!.metadata = { context_manager_job: true }
  const options = { maxTokens: 4096 }
  const event = { sessionID: "ses_native", agent: EDIT_AGENT, model: { providerID: "fixture", id: "model" }, messages: [], system: [{ type: "text", text: "Must not leak global instructions" }], tools: { shell: {} }, options }
  await mock.hooks.get("context")!(event)
  assert.deepEqual(event.system, [{ type: "text", text: SUMMARY_EDIT_SYSTEM }])
  assert.deepEqual(event.tools, {})
  assert.deepEqual(event.options, { maxTokens: 4096 })
})

test("manual RPC generation leaves oversized input to the provider for summaries and edits", async (t) => {
  const mock = await setup(t)
  const list = mock.context.model.list
  mock.context.model.list = async () => {
    const result = await list()
    return { ...result, data: result.data.map((model) => ({ ...model, limit: { context: 100, input: 50, output: 50 } })) }
  }
  for (const strategy of ["MANUAL", "AUTO_PER_TURN", "AUTO_SESSION"]) for (const purpose of ["summary", "edit"] as const) {
    mock.sessions.get("ses_native")!.metadata![AUTO_KEY] = { strategy }
    const id = await mock.rpc.createJob({ sessionID: "ses_native", purpose }, call)
    assert.equal(typeof id, "string")
    if (typeof id !== "string") throw new Error("Missing job")
    const text = "Full manual request must reach the provider. ".repeat(1000)
    assert.equal(await mock.rpc.generate({ sessionID: "ses_native", jobID: id, model: { providerID: "fixture", modelID: "model" }, text, purpose }, call), "Answer only")
    assert.equal(mock.state.prompts.at(-1), text)
  }
})

test("only live owned manual helpers bypass the hook budget, regardless of parent strategy", async (t) => {
  const mock = await setup(t)
  const text = "Full manual request. ".repeat(400)
  const list = mock.context.model.list
  mock.context.model.list = async () => {
    const result = await list()
    return { ...result, data: result.data.map((model) => ({ ...model, limit: { context: 100, input: 50, output: 50 } })) }
  }
  for (const purpose of ["summary", "edit"] as const) {
    const id = await mock.rpc.createJob({ sessionID: "ses_native", purpose }, call)
    if (typeof id !== "string") throw new Error("Missing job")
    mock.messages.set(id, [{ id: "msg_input", type: "user", text, time: { created: 1 } }])
    const event = { sessionID: id, agent: purpose === "edit" ? EDIT_AGENT : AGENT, model: { providerID: "fixture", id: "model" }, messages: [Message.make({ id: "msg_input", role: "user", content: text })], system: [{ type: "text", text: "Unrelated system" }], tools: { shell: {} }, options: { maxTokens: 32 } }
    const before = JSON.stringify(event.messages)
    await mock.hooks.get("context")!(event)
    assert.equal(JSON.stringify(event.messages), before)
    assert.deepEqual(event.tools, {})
    assert.deepEqual(event.options, { maxTokens: 32 })
    assert.equal(await mock.store.budget(id), undefined)
    assert.equal(await mock.store.capture("ses_native"), undefined)
    await mock.rpc.removeJob({ sessionID: "ses_native", jobID: id }, call)
    mock.sessions.set(id, { ...mock.sessions.get("ses_native")!, id, metadata: { context_manager_job: true, context_manager_manual: true } })
    mock.messages.set(id, [{ id: "msg_input", type: "user", text, time: { created: 1 } }])
    await assert.rejects(mock.hooks.get("context")!(event), /exceeds helper input capacity/)
  }
})

test("V2 fresh spilling preserves structured output and attachments and owns the truncation marker", async (t) => {
  const mock = await setup(t)
  const output = { keep: "structured" }
  const file = { type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" }
  const event = { status: "completed", result: { output, content: [{ type: "text", text: "HEAD\n" + "large line\n".repeat(4000) + "TAIL" }, file], metadata: { keep: true } as Record<string, unknown> } }
  await mock.hooks.get("execute.after")!(event)
  assert.equal(event.result.output, output)
  assert.deepEqual(event.result.content[1], file)
  assert.ok("text" in event.result.content[0])
  assert.match(event.result.content[0].text, /HEAD[\s\S]*middle omitted[\s\S]*TAIL/)
  assert.equal(event.result.metadata.truncated, true)
  assert.equal(event.result.metadata.keep, true)
  const short = { status: "completed", result: { content: "small", metadata: {} as Record<string, unknown> } }
  await mock.hooks.get("execute.after")!(short)
  assert.equal(short.result.metadata.truncated, false)
})

for (const version of ["2.0.24", "2.0.25", "2.0.26", "2.0.27", "2.1.0", "2.0.26-dev", "custom-build"]) {
  test(`V2 setup accepts compatible APIs with host version ${version}`, async (t) => {
    const mock = await setup(t, version)
    assert.ok(mock.agents.has(AGENT))
    assert.ok(mock.agents.has(EDIT_AGENT))
    for (const name of ["context", "generate", "compaction", "execute.after"]) assert.ok(mock.hooks.has(name))
  })
}
