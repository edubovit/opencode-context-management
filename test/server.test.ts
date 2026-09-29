import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Hooks } from "@opencode-ai/plugin"
import type { Config, Model as LegacyModel, UserMessage, Part, Message } from "@opencode-ai/sdk"
import type { Config as ConfigV2 } from "@opencode-ai/sdk/v2"
import { createHooks } from "../src/server.ts"
import { Storage } from "../src/storage.ts"
import { AGENT, EDIT_AGENT, KEY, VERSION, settings } from "../src/config.ts"
import { SUMMARY_EDIT_SYSTEM } from "../src/summarize.ts"
import { append, emptyPolicy, operation, select, turns } from "../src/context.ts"
import { messages, model, pruneRule, session, suppliedOptions } from "./fixtures.ts"

test("server publishes token-only options that the TUI can revalidate unchanged", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-settings-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storage = new Storage(dir, dir)
  const options = { ...suppliedOptions, ui: { maxLinesPerTurn: 7 } }
  const hooks = await createHooks({ client: createOpencodeClient({ baseUrl: "http://fixture" }), directory: dir }, options, storage)
  const published = await storage.config()
  assert.equal(published?.version, VERSION)
  assert.deepEqual(published?.settings.prune, suppliedOptions.prune)
  const tuiSettings = settings(published!.settings)
  assert.deepEqual(tuiSettings, settings(options))
  assert.equal(tuiSettings.ui.maxLinesPerTurn, 7)
  assert.equal(Object.hasOwn(tuiSettings.prune, "unit"), false)
  const output = { temperature: 0, topP: 1, topK: 1, maxOutputTokens: 32000, options: {} }
  await hooks["chat.params"]!(paramsInput("openai"), output)
  assert.equal(output.maxOutputTokens, 32000)
})

test("summarizer preserves provider-omitted output limits", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-provider-params-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const hooks = await createHooks({ client: createOpencodeClient({ baseUrl: "http://fixture" }), directory: dir }, {}, new Storage(dir, dir))
  for (const providerID of ["openai", "github-copilot", "cerebras", "custom"]) {
    const input = paramsInput(providerID)
    const output: Parameters<NonNullable<Hooks["chat.params"]>>[1] = {
      temperature: 0, topP: 1, topK: 1, maxOutputTokens: undefined, options: { existing: true },
    }
    const before = structuredClone(output)
    await hooks["chat.params"]!(input, output)
    assert.deepEqual(output, before, `${providerID}: do not restore a parameter disabled upstream`)
    assert.equal(JSON.stringify({ max_output_tokens: output.maxOutputTokens }), "{}")
  }
})

test("summarizer leaves numeric host output limits unchanged", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-provider-cap-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const hooks = await createHooks({ client: createOpencodeClient({ baseUrl: "http://fixture" }), directory: dir }, {}, new Storage(dir, dir))
  for (const [incoming, modelMaximum] of [[32000, 32000], [1024, 32000], [32000, 4096], [32000, 0], [128000, 128000]]) {
    const input = paramsInput("test")
    input.model.limit.output = modelMaximum
    const output = { temperature: 0, topP: 1, topK: 1, maxOutputTokens: incoming, options: { existing: true } }
    await hooks["chat.params"]!(input, output)
    assert.equal(output.maxOutputTokens, incoming)
    assert.deepEqual(output.options, { existing: true })
  }
})

function paramsInput(providerID: string): Parameters<NonNullable<Hooks["chat.params"]>>[0] {
  return {
    sessionID: "ses_test", agent: AGENT,
    model: { ...model(), providerID } as unknown as LegacyModel,
    message: messages()[0].info as UserMessage,
    provider: { source: "config", info: { id: providerID, name: providerID, env: [], models: {}, source: "config", options: {} }, options: {} },
  }
}

test("real server hook contract disables defaults and transforms copies using persisted metadata", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-hooks-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = messages()
  const original = structuredClone(source)
  const data = session()
  data.metadata![KEY] = append(emptyPolicy(data.id), operation("tool-prune", select(turns(source), 0, 0), pruneRule()))
  const client = createOpencodeClient({ baseUrl: "http://fixture", fetch: async (input) => new Response(JSON.stringify(String(input instanceof Request ? input.url : input).includes("/provider") ? { all: [{ id: "test", models: { model: model() } }], connected: ["test"] } : data), { headers: { "content-type": "application/json" } }) })
  const storage = new Storage(dir, dir)
  const hooks = await createHooks({ client, directory: dir }, {}, storage)
  const published = await storage.config()
  assert.deepEqual(published?.settings.spill, suppliedOptions.spill)
  assert.deepEqual(published?.settings.prune, suppliedOptions.prune)
  const config = { compaction: { auto: true, prune: true } } as unknown as Config
  await hooks.config!(config)
  const actual = config as unknown as ConfigV2
  assert.deepEqual(actual.compaction, { auto: false, prune: false })
  assert.equal(actual.agent?.[AGENT]?.permission && typeof actual.agent[AGENT].permission, "object")
  assert.equal(actual.agent?.[AGENT]?.steps, undefined, "steps:1 injects OpenCode's whole-task recap instruction into the first response")
  assert.equal(actual.agent?.[EDIT_AGENT]?.prompt, SUMMARY_EDIT_SYSTEM)
  assert.equal(actual.agent?.[EDIT_AGENT]?.steps, undefined)
  assert.deepEqual(actual.agent?.[EDIT_AGENT]?.permission, { "*": "deny" })
  const output = { messages: structuredClone(source) as unknown as { info: Message; parts: Part[] }[] }
  const reference = output.messages
  await hooks["experimental.chat.messages.transform"]!({}, output)
  assert.equal(output.messages, reference)
  assert.deepEqual(source, original)
  assert.ok(JSON.stringify(output.messages).includes("middle omitted"))
  for (const message of output.messages) for (const part of message.parts) {
    if (part.type !== "tool") continue
    const storedPart = source.flatMap((m) => m.parts).find((p) => p.id === part.id)
    assert.ok(storedPart?.type === "tool")
    assert.deepEqual(part.metadata, storedPart.metadata, "Do not send pruning markers as provider options")
  }
  await assert.rejects(hooks["experimental.session.compacting"]!({ sessionID: data.id }, { context: [] }), /cannot be mixed/)

  await hooks["tool.definition"]!({ toolID: "read" }, { description: "Read a file", parameters: { type: "object" } })
  await hooks["experimental.chat.system.transform"]!({ sessionID: data.id, model: model() as unknown as LegacyModel }, { system: ["System prompt"] })
  await hooks["chat.params"]!({ sessionID: data.id, agent: "build", model: model() as unknown as LegacyModel, message: source[0].info as UserMessage, provider: { source: "config", info: { id: "test", name: "test", env: [], models: {}, source: "config", options: {} }, options: {} } }, { temperature: 0, topP: 1, topK: 1, maxOutputTokens: 2000, options: {} })
  const capture = await storage.capture(data.id)
  assert.deepEqual(capture?.system, ["System prompt"])
  assert.equal(capture?.tools?.[0].id, "read")
  assert.equal(capture?.agent, "build")
})

test("after-hook spills native and MCP outputs without changing arguments or attachments", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-output-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storage = new Storage(dir, dir)
  const client = createOpencodeClient({ baseUrl: "http://fixture" })
  const hooks = await createHooks({ client, directory: dir }, {}, storage)
  const input = { tool: "bash", sessionID: "ses_test", callID: "call", args: { command: "untouched" } }
  const full = "HEAD" + "x".repeat(60000) + "TAIL"
  const native = { title: "test", output: full, metadata: { custom: 42 } }
  await hooks["tool.execute.after"]!(input, native)
  assert.ok(native.output.startsWith("HEAD"))
  assert.ok(native.output.includes("TAIL"))
  const metadata = native.metadata as unknown as { outputPath: string; custom: number }
  assert.equal(await readFile(metadata.outputPath, "utf8"), full)
  assert.equal(metadata.custom, 42)
  assert.equal(input.args.command, "untouched")
  const image = { type: "image", data: "original", mimeType: "image/png" }
  const mcp = { content: [{ type: "text", text: full }, image] }
  await hooks["tool.execute.after"]!({ ...input, tool: "mcp_test" }, mcp as unknown as typeof native)
  assert.deepEqual(mcp.content[1], image)
  assert.ok("text" in mcp.content[0] && mcp.content[0].text.includes("TAIL"))
})

test("missing or outside spill files preserve available output with an explicit warning", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-output-missing-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const hooks = await createHooks({ client: createOpencodeClient({ baseUrl: "http://fixture" }), directory: dir }, {}, new Storage(dir, dir))
  const output = { title: "test", output: "Available preview", metadata: { truncated: true, outputPath: path.join(dir, "missing.txt") } }
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_test", callID: "call", args: {} }, output)
  assert.ok(output.output.startsWith("Available preview"))
  assert.ok(output.output.includes("unable to rebuild"))
})

test("edit helper system is summary-only and output limits remain unchanged", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-edit-hook-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = { ...session(), metadata: { context_manager_job: true, context_manager_edit: true } }
  const client = createOpencodeClient({ baseUrl: "http://fixture", fetch: async () => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }) })
  const hooks = await createHooks({ client, directory: dir }, {}, new Storage(dir, dir))
  const output = { system: ["Original unrelated system context"] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: data.id, model: model() as unknown as LegacyModel }, output)
  assert.deepEqual(output.system, [SUMMARY_EDIT_SYSTEM])
  for (const maxOutputTokens of [undefined, 32000]) {
    const params = { temperature: 0, topP: 1, topK: 1, maxOutputTokens, options: {} }
    await hooks["chat.params"]!({ ...paramsInput("openai"), agent: EDIT_AGENT }, params)
    assert.equal(params.maxOutputTokens, maxOutputTokens)
  }
})
