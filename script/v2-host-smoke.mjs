import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const executable = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? "opencode"
const checkTui = process.argv.includes("--tui")
const version = spawnSync(executable, ["--version"], { encoding: "utf8" })
assert.equal(version.status, 0, version.error?.message ?? version.stderr)
assert.match(version.stdout.trim(), /^opencode v2\.\S+$/, "This fixture requires OpenCode V2")
await access(path.join(repo, "test/v2-host/node_modules/@opencode/plugin/package.json")).catch(() => {
  throw new Error("Install fixture dependencies first: npm ci --prefix test/v2-host --ignore-scripts")
})
const temporary = path.join(tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await mkdtemp(path.join(temporary, "context-manager-v2-"))
const requests = []
const sessions = []
const checks = []
const providerErrors = []
let releaseProvider
const provider = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const lastUser = body.messages.findLast((message) => message.role === "user")
    if (JSON.stringify(lastUser).includes("HOLD_PROVIDER")) await new Promise((resolve) => { releaseProvider = resolve })
    if (res.destroyed) return
    const tool = JSON.stringify(lastUser).includes("USE_TOOL") && !body.messages.some((message) => message.role === "tool")
    const delta = tool
      ? { reasoning_content: "REASONING_FIXTURE", tool_calls: [{ index: 0, id: `call_fixture_${requests.length}`, type: "function", function: { name: "fixture_tool", arguments: "{}" } }] }
      : { content: "Fixture final response." }
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }])
      res.write(`data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [choice] })}\n\n`)
    res.end("data: [DONE]\n\n")
  } catch (error) {
    providerErrors.push(String(error))
    res.writeHead(500).end("Synthetic provider failed")
  }
})
provider.listen(0, "127.0.0.1")
await once(provider, "listening")
const project = path.join(root, "project")
const plugin = path.join(root, "plugin")
const env = { PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "xterm-256color", HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home") }
for (const [name, directory] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", TMPDIR: "tmp" })) env[name] = path.join(root, directory)
env.OPENCODE_CONFIG_DIR = path.join(env.XDG_CONFIG_HOME, "opencode")
for (const directory of [project, plugin, env.HOME, env.OPENCODE_CONFIG_DIR, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR]) await mkdir(directory, { recursive: true })
const wrapper = (name, generation = 0) => `export { default } from ${JSON.stringify(pathToFileURL(path.join(repo, "test/v2-host", `${name}.ts`)).href)}\nexport const fixtureGeneration = ${generation}\n`
await writeFile(path.join(plugin, "server.ts"), wrapper("server"))
await writeFile(path.join(plugin, "tui.ts"), wrapper("tui"))
const model = { limit: { context: 200000, input: 168000, output: 32000 }, capabilities: { tools: true, input: ["text"], output: ["text"] }, compatibility: { reasoningField: "reasoning_content" } }
const config = {
  update: "disable", snapshots: false, share: "disabled", compaction: { auto: false }, plugins: ["-opencode.provider.*", plugin],
  model: "fixture/fixture", permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "fixture_tool", resource: "*", effect: "allow" }],
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: "synthetic-not-a-secret", baseURL: `http://127.0.0.1:${provider.address().port}/v1` }, models: { fixture: model, native: { ...model, settings: { compaction: { type: "native" } } } } } },
}
const configPath = path.join(env.OPENCODE_CONFIG_DIR, "opencode.json")
await writeFile(configPath, JSON.stringify(config, null, 2))
const password = randomUUID()
Object.assign(env, { OPENCODE_PASSWORD: password, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_LOG_LEVEL: "DEBUG" })
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
const exit = once(child, "exit")
let log = ""
let url
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { log += chunk; url ??= log.match(/server listening on (http:\/\/[^\s]+)/)?.[1] })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned host exited while waiting for ${label}`)
    await sleep(30)
  }
  throw new Error(`Timeout: ${label}; inspect ${root}`)
}
const api = async (method, endpoint, data) => {
  const response = await fetch(url + endpoint, { method, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(45000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${endpoint} ${response.status}: ${text}`)
  return text ? JSON.parse(text) : undefined
}
const rpc = async (method, input) => (await api("POST", `/api/rpc/context-manager-v2-fixture/${method}`, { input }))?.output
const create = async (modelID = "fixture", metadata) => {
  const session = (await api("POST", "/api/session", { title: "Context manager synthetic V2 fixture", model: { providerID: "fixture", id: modelID }, metadata })).data
  sessions.push(session.id)
  return session.id
}
const wait = (sessionID) => api("POST", `/api/experimental/session/${sessionID}/wait`)
const send = async (sessionID, text) => { await api("POST", `/api/session/${sessionID}/prompt`, { text }); await wait(sessionID) }
const context = async (sessionID) => (await api("GET", `/api/session/${sessionID}/context`)).data
const arm = (sessionID, modes, pause = false) => rpc("arm", { sessionID, plan: { pause, ...(modes ? { modes } : {}) } })
const paused = (sessionID) => until(async () => { const state = await rpc("status", { sessionID }); return state.pauseID && state }, "live context gate")
let passed = false
let cleaned = false
try {
  await until(() => url, "host startup")
  await until(async () => {
    const inventory = await api("GET", "/api/plugin")
    await writeFile(path.join(root, "plugins.json"), JSON.stringify(inventory, null, 2))
    const item = inventory.data.find((item) => item.id === "context-manager-v2-fixture")
    if (item?.state.status === "failed") throw new Error(item.state.error)
    return item?.state.status === "active" && item.features.tui
  }, "plugin activation")
  checks.push("directory loading, active server and discovered TUI entrypoint")
  if (checkTui) {
    assert.equal(process.platform, "linux", "The optional PTY driver currently requires Linux and Python 3")
    const sessionID = await create()
    const terminal = spawn("python3", [path.join(repo, "script/v2-tui-driver.py"), executable, url, project, path.join(root, "tui-output.log")], { env, stdio: ["pipe", "inherit", "inherit"] })
    const terminalExit = once(terminal, "exit")
    const before = requests.length
    try {
      await until(async () => (await rpc("status", { sessionID })).tui.includes("ready"), "real TUI plugin setup and RPC")
      terminal.stdin.write(JSON.stringify({ keys: "/context-manager-v2-fixture" }) + "\n")
      await sleep(300)
      terminal.stdin.write(JSON.stringify({ keys: "\r" }) + "\n")
      await until(async () => (await rpc("status", { sessionID })).tui.includes("command"), "real TUI slash command")
      terminal.stdin.write(JSON.stringify({ exit: true }) + "\n")
      const [code] = await terminalExit
      assert.equal(code, 0, "TUI driver did not stop its owned client cleanly")
      assert.equal(requests.length, before, "TUI command must not submit a model prompt")
      checks.push("real 80x24 TUI setup, slash/keymap command and RPC; no model call")
    } finally {
      terminal.stdin.end()
      if (terminal.exitCode === null && terminal.signalCode === null) {
        await terminalExit
      }
    }
  }
  for (const modes of [{ reasoning: true }, { reasoning: false, tools: "large" }, { reasoning: true, tools: "large" }, { reasoning: false, tools: "all" }, { reasoning: true, tools: "all" }, { reasoning: true, tools: "delete" }]) {
    const sessionID = await create()
    assert.equal((await rpc("status", { sessionID })).idle, true)
    await send(sessionID, "USE_TOOL")
    const original = await context(sessionID)
    assert.ok(JSON.stringify(original).includes("REASONING_FIXTURE"))
    assert.ok(JSON.stringify(original).includes("HEAD_FIXTURE"))
    const count = requests.length
    await arm(sessionID, modes)
    await send(sessionID, "Immediate same-model request after pruning")
    assert.equal(requests.length, count + 1)
    const wire = JSON.stringify(requests.at(-1))
    assert.equal(wire.includes("REASONING_FIXTURE"), !modes.reasoning)
    if (modes.tools === "large") assert.match(wire, /HEAD_FIXTURE[\s\S]*middle omitted[\s\S]*TAIL_FIXTURE/)
    if (modes.tools === "all") { assert.match(wire, /Tool output pruned/); assert.ok(!wire.includes("HEAD_FIXTURE")) }
    if (modes.tools === "delete") { assert.ok(!wire.includes("HEAD_FIXTURE")); assert.ok(!wire.includes("call_fixture_")) }
    const after = await context(sessionID)
    assert.deepEqual(after.filter((message) => original.some((before) => before.id === message.id)), original)
    const inspection = await rpc("inspect", { sessionID })
    assert.equal(inspection.capture.options.maxTokens, 32000)
    checks.push(`same-model ${JSON.stringify(modes)}; persisted history and host output cap unchanged`)
  }

  const sessionID = await create()
  await send(sessionID, "USE_TOOL")
  await arm(sessionID, { reasoning: true, tools: "all" }, true)
  let count = requests.length
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "Pause and resume without extra input" })
  const pause = await paused(sessionID)
  assert.equal(pause.idle, false)
  assert.equal(requests.length, count)
  const before = await context(sessionID)
  await assert.rejects(rpc("resume", { sessionID, pauseID: "stale" }), /no longer active/)
  await rpc("resume", { sessionID, pauseID: pause.pauseID })
  await wait(sessionID)
  assert.equal(requests.length, count + 1)
  assert.equal((await context(sessionID)).filter((message) => message.type === "user").length, before.filter((message) => message.type === "user").length)
  assert.equal((await rpc("status", { sessionID })).idle, true)
  checks.push("same-loop resume without added user message; stale owner rejected")

  count = requests.length
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "Native stop of a suspended request" })
  await paused(sessionID)
  await api("POST", `/api/session/${sessionID}/interrupt`, { resume: false })
  await wait(sessionID)
  await until(async () => !(await rpc("status", { sessionID })).pauseID, "native stop revokes gate")
  assert.equal(requests.length, count)
  checks.push("native stop revokes gate; no provider call")

  await arm(sessionID)
  const initialGeneration = (await rpc("status", { sessionID })).generation
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "HOLD_PROVIDER" })
  await until(() => releaseProvider, "blocked provider")
  await writeFile(path.join(plugin, "server.ts"), wrapper("server", 1))
  const reloaded = await until(async () => { const value = await rpc("status", { sessionID }); return value.generation !== initialGeneration && value }, "plugin hot reload")
  assert.equal(reloaded.idle, false, "A new plugin generation must not infer idle from stale persisted outcome")
  assert.ok(reloaded.cleanupCount >= 1)
  releaseProvider()
  releaseProvider = undefined
  await wait(sessionID)
  assert.equal((await rpc("status", { sessionID })).idle, true)
  checks.push("hot reload cleanup; positive idle check during pre-existing execution")

  for (const modelID of ["fixture", "native"]) {
    const id = await create(modelID)
    await send(id, "First synthetic exchange")
    await send(id, "Second synthetic exchange")
    count = requests.length
    await api("POST", `/api/session/${id}/compact`, {})
    await wait(id)
    assert.equal(requests.length, count)
    const transcript = await context(id)
    assert.ok(!transcript.some((message) => message.type === "compaction" && message.status === "completed"))
    checks.push(`${modelID} native-compaction guard blocks dispatch and successful checkpoint`)
  }

  const legacy = { version: 6, sessionID: "retained-original", operations: [{ summary: "must survive" }] }
  const legacyID = await create("fixture", { opencode_context_manager: legacy })
  count = requests.length
  await send(legacyID, "Legacy policy must fail closed")
  assert.equal(requests.length, count)
  assert.deepEqual((await api("GET", `/api/session/${legacyID}`)).data.metadata.opencode_context_manager, legacy)
  await assert.rejects(rpc("status", { sessionID: "invalid" }), /400/)
  await assert.rejects(rpc("status", { sessionID, unexpected: true }), /400/)
  checks.push("legacy ledger preserved and dispatch blocked; RPC input validation")

  const stopID = await create()
  await arm(stopID, undefined, true)
  count = requests.length
  await api("POST", `/api/session/${stopID}/prompt`, { text: "Disable the plugin while paused" })
  await paused(stopID)
  await writeFile(configPath, JSON.stringify({ ...config, plugins: ["-opencode.provider.*", "-context-manager-v2-fixture"] }))
  await until(async () => !(await api("GET", "/api/plugin")).data.some((item) => item.id === "context-manager-v2-fixture" && item.state.status === "active"), "plugin disable")
  await wait(stopID)
  assert.equal(requests.length, count)
  checks.push("disable during suspension revokes owned gate without raw-context dispatch")
  assert.deepEqual(providerErrors, [])
  passed = true
} finally {
  releaseProvider?.()
  for (const sessionID of sessions) {
    if (url && child.exitCode === null && child.signalCode === null) await api("DELETE", `/api/session/${sessionID}`).catch(() => {})
  }
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
  const [code, signal] = await exit
  clearTimeout(timer)
  cleaned = (code !== null || signal !== null) && signal !== "SIGKILL"
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  await writeFile(path.join(root, "host-stdout.log"), log)
  await writeFile(path.join(root, "requests.json"), JSON.stringify(requests, null, 2))
  const hostLog = await readFile(path.join(env.XDG_DATA_HOME, "opencode/log/opencode.log"), "utf8").catch(() => "")
  await writeFile(path.join(root, "host.log"), hostLog)
  await writeFile(path.join(root, "result.json"), JSON.stringify({ version: version.stdout.trim(), passed, cleaned, checks, providerErrors, requests: requests.length }, null, 2))
  console.log(JSON.stringify({ root, passed, cleaned, checks: checks.length }))
  if (!cleaned) throw new Error("Owned V2 host required forced termination")
}
