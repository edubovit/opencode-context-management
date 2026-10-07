import { createServer } from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"

export type Wire = { model: string; messages: { role: string; content?: unknown; tool_calls?: unknown }[]; [key: string]: unknown }

export async function fixture(executable = "opencode", destination?: string) {
  const version = spawnSync(executable, ["--version"], { encoding: "utf8" })
  if (version.status !== 0 || version.stdout.trim() !== "opencode v2.0.24") throw new Error("This smoke test requires OpenCode 2.0.24")
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const root = destination ? path.resolve(destination) : await mkdtemp(path.join(tmpdir(), "opencode", "context-manager-full-"))
  if (destination) await mkdir(root)
  const requests: Wire[] = []
  let respond: (wire: Wire) => string | { text: string; finish: "stop" | "length" } | undefined = () => undefined
  let barrier: { arrivals: number; expected: number; promise: Promise<void>; release(): void } | undefined
  let hold: { promise: Promise<void>; release(): void } | undefined
  const provider = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const input = JSON.parse(raw) as Wire
    requests.push(input)
    const serialized = JSON.stringify(input.messages)
    const last = input.messages.findLast((message) => message.role === "user")
    const lastText = JSON.stringify(last)
    const summary = serialized.includes("<selected_range_")
    const editing = serialized.includes("Only the supplied summary and this editing dialogue are available")
    if (barrier && summary && lastText.includes("<selected_range_")) {
      const current = barrier
      current.arrivals++
      if (current.arrivals >= current.expected) current.release()
      await current.promise
    }
    if (hold && lastText.includes("HOLD_FIXTURE")) await hold.promise
    if (res.destroyed) return
    const custom = respond(input)
    const tool = !summary && !editing && lastText.includes("EXERCISE_TOOL") && !input.messages.some((message) => message.role === "tool")
    const text = (typeof custom === "object" ? custom.text : custom) ?? (editing ? (serialized.includes("EDIT_ONE") ? "EDIT_TWO: corrected saved summary" : "EDIT_ONE: clarified saved summary")
      : summary ? "Retained selected facts: ROOT_FACT; HEAD_FIXTURE and TAIL_FIXTURE were observed. Follow up with validation of the synthetic change."
      : "Fixture final response. ROOT_FACT retained.")
    const delta = tool ? { reasoning_content: "REASONING_FIXTURE", tool_calls: [{ index: 0, id: `call_fixture_${requests.length}`, type: "function", function: { name: "fixture_tool", arguments: "{}" } }] } : { content: text }
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : typeof custom === "object" ? custom.finish : lastText.includes("TRUNCATE_FIXTURE") ? "length" : "stop" }])
      res.write(`data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [choice] })}\n\n`)
    res.end("data: [DONE]\n\n")
  })
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  const address = provider.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture provider listener")
  const project = path.join(root, "project")
  const configDir = path.join(root, "config", "opencode")
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "xterm-256color", HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home") }
  for (const [key, name] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", TMPDIR: "tmp" })) env[key] = path.join(root, name)
  for (const directory of [project, configDir, env.HOME!, env.XDG_DATA_HOME!, env.XDG_CACHE_HOME!, env.XDG_STATE_HOME!, env.TMPDIR!]) await mkdir(directory, { recursive: true })
  const password = randomUUID()
  Object.assign(env, { OPENCODE_CONFIG_DIR: configDir, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_LOG_LEVEL: "DEBUG" })
  const config = {
    update: "disable", snapshots: false, compaction: { auto: false }, model: "fixture/fixture",
    plugins: ["-opencode.provider.*", { package: path.join(repo, "src"), options: { autocompaction: { headroom: 2000 }, prune: { threshold: 300, head: 40, tail: 160 }, summarizer: { providerID: "fixture", modelID: "fixture" } } }, path.join(repo, "test/host-fixture")],
    permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "fixture_tool", resource: "*", effect: "allow" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: "synthetic-not-a-secret", baseURL: `http://127.0.0.1:${address.port}/v1` }, models: {
      fixture: { limit: { context: 200000, input: 168000, output: 32000 }, capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "high", settings: { reasoningEffort: "high" } }] },
      small: { limit: { context: 24000, input: 12000, output: 12000 }, capabilities: { tools: true, input: ["text"], output: ["text"] } },
    } } },
  }
  const configPath = path.join(configDir, "opencode.json")
  await writeFile(configPath, JSON.stringify(config, null, 2))
  let log = ""
  let url = ""
  const start = () => {
    const process = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    for (const stream of [process.stdout, process.stderr]) stream.on("data", (chunk) => { output += chunk; log += chunk; url ||= output.match(/server listening on (http:\/\/\S+)/)?.[1] ?? "" })
    return { process, exited: once(process, "exit") }
  }
  let running = start()
  const until = async <T>(check: () => T | Promise<T>, label: string): Promise<NonNullable<T>> => {
    for (let i = 0; i < 1500; i++) {
      const value = await check()
      if (value) return value as NonNullable<T>
      if (running.process.exitCode !== null || running.process.signalCode !== null) throw new Error(`Owned host exited: ${log}`)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error(`Timeout: ${label}. Logs: ${root}`)
  }
  const stop = async () => {
    const current = running
    current.process.kill("SIGTERM")
    const timer = setTimeout(() => current.process.kill("SIGKILL"), 10000)
    const [code, signal] = await current.exited
    clearTimeout(timer)
    return { code, signal, cleaned: signal !== "SIGKILL" && ((typeof code === "number" && [0, 130].includes(code)) || signal === "SIGTERM") }
  }
  const close = async (result: unknown) => {
    barrier?.release(); hold?.release()
    const status = await stop()
    provider.closeAllConnections()
    await new Promise<void>((resolve) => provider.close(() => resolve()))
    await writeFile(path.join(root, "stdout.log"), log)
    await writeFile(path.join(root, "host.log"), await readFile(path.join(root, "data/opencode/log/opencode.log"), "utf8").catch(() => ""))
    await writeFile(path.join(root, "requests.json"), JSON.stringify(requests, null, 2))
    await writeFile(path.join(root, "result.json"), JSON.stringify({ result, ...status }, null, 2))
    if (!status.cleaned) throw new Error("Owned host did not stop cleanly")
  }
  try { await until(() => url, "server ready") }
  catch (error) { await close({ passed: false }); throw error }
  const connect = () => OpenCode.make({ baseUrl: url, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  let client = connect()
  return {
    root, repo, project, get client() { return client }, env, get url() { return url }, config, configPath, requests, until, close,
    restart: async () => {
      const status = await stop()
      if (!status.cleaned) throw new Error("Owned host did not stop cleanly before restart")
      url = ""
      running = start()
      await until(() => url, "restarted host")
      client = connect()
    },
    respond: (callback: typeof respond) => { respond = callback },
    parallel: (expected: number) => {
      let release!: () => void
      const promise = new Promise<void>((resolve) => { release = resolve })
      barrier = { arrivals: 0, expected, promise, release }
      return { count: () => barrier?.arrivals ?? 0, release: () => { release(); barrier = undefined } }
    },
    hold: () => {
      let release!: () => void
      hold = { promise: new Promise<void>((resolve) => { release = resolve }), release: () => release() }
      return () => { release(); hold = undefined }
    },
  }
}
