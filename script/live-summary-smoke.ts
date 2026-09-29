import { spawn } from "node:child_process"
import { mkdir, open, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { sdkHost } from "../src/sdk-host.ts"
import { operation, turns } from "../src/context.ts"
import { summaryPrompt } from "../src/summarize.ts"
import { messages } from "../test/fixtures.ts"
import { scopeFixture } from "../test/scope-fixture.ts"

const [consent, executable, root, providerID, modelID, variant, scenario = "compact"] = process.argv.slice(2)
if (consent !== "--allow-live" || !executable || !root || !providerID || !modelID)
  throw new Error("Usage: live-summary-smoke.ts --allow-live <absolute opencode executable> <fresh temporary root> <providerID> <modelID> [variant] [compact|brief-scope]. Uses real configured credentials and may incur cost.")
if (scenario !== "compact" && scenario !== "brief-scope") throw new Error("Unknown live smoke scenario")
if (!path.isAbsolute(executable) || !path.isAbsolute(root)) throw new Error("Executable and temporary root must be absolute")
await mkdir(root, { recursive: false })
const project = path.join(root, "project")
await mkdir(project)
const observation = path.join(root, "observation.json")
const inherited = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}")
const config = {
  ...inherited, autoupdate: false, share: "disabled", snapshot: false, lsp: false, formatter: false,
  plugin: [...(inherited.plugin ?? []), pathToFileURL(path.resolve("test/live-safety-plugin.ts")).href],
}
const password = randomUUID()
const log = await open(path.join(root, "host.log"), "ax", 0o600)
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "41974"], {
  cwd: project, stdio: ["ignore", log.fd, log.fd], windowsHide: true,
  env: {
    ...process.env, OPENCODE_DB: path.join(root, "sessions.sqlite"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_SERVER_USERNAME: "context-manager-test", OPENCODE_SERVER_PASSWORD: password,
    CONTEXT_MANAGER_LIVE_OBSERVATION: observation,
  },
})
let spawnError: Error | undefined
child.on("error", (error) => { spawnError = error })
const headers = { authorization: `Basic ${Buffer.from(`context-manager-test:${password}`).toString("base64")}` }
const client = createOpencodeClient({
  baseUrl: "http://127.0.0.1:41974", directory: project, headers,
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(120000) }),
})
const host = sdkHost(client)
let helper: string | undefined
let passed = false
let cleaned = false
let summaryCharacters = 0
const scopeResults: { position: string; summary: string }[] = []
try {
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`Temporary OpenCode exited ${child.exitCode}`)
    try { ready = (await fetch("http://127.0.0.1:41974/global/health", { headers, signal: AbortSignal.timeout(1000) })).ok } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.ok(ready, "Temporary OpenCode did not start")
  assert.equal((await client.session.list({}, { throwOnError: true })).data!.length, 0, "Refusing live test: session database is not empty")
  assert.ok(await host.configured(), "Installed server plugin is not active in this test host")
  const model = (await host.models()).find((m) => m.providerID === providerID && m.id === modelID)
  assert.ok(model, "Requested real model unavailable")
  assert.ok(!variant || variant === "default" || model.variants?.[variant], "Requested variant unavailable")
  const fixture = messages("ses_synthetic_live_test", 2).map((message) => ({ ...message, parts: message.parts.filter((part) => part.type === "text") }))
  const facts = [
    "Synthetic test only: build a small local CLI that writes sample.json. Do not use a database or network. Preserve Unicode and use an atomic temporary-file rename. The user wants readable errors, not raw provider metadata.",
    "Chosen design: validate inputs, serialize UTF-8 JSON, write to a temporary sibling file, rename into sample.json. Validation failure leaves existing content unchanged. Tests must cover Unicode, interrupted writes and invalid input. These are synthetic fixture decisions, not real project work.",
    "The selected range needs a concise detailed summary for continuing this synthetic task. Keep the filename, constraints and the atomic-write decision. This is background outside the selected range.",
    "Next step: implement and test the local CLI. No real files have been changed. This is the end of the synthetic background conversation.",
  ]
  fixture.forEach((message, index) => { const part = message.parts[0]; if (part.type === "text") part.text = facts[index] })
  const blocks = turns(fixture)
  const cases = scenario === "brief-scope"
    ? (["middle", "first"] as const).map((position) => {
        const fixture = scopeFixture(position)
        return { name: position, prompt: summaryPrompt(fixture.op, fixture.blocks, fixture.runtime) }
      })
    : [{ name: "compact", prompt: summaryPrompt(operation("compact", blocks.slice(0, 1)), blocks) }]
  for (const item of cases) {
    helper = await host.createJob()
    console.log(`Testing disposable ${scenario}/${item.name}: ${providerID}/${modelID}, variant ${variant ?? "default"}`)
    const result = await host.generate(helper, { providerID, modelID, variant }, item.prompt)
    const length = Array.from(result).length
    summaryCharacters += length
    assert.ok(length > 0, "Empty summary")
    if (scenario === "brief-scope") {
      scopeResults.push({ position: item.name, summary: result })
      assert.match(result, /--color/, "Summary lost the selected documentation correction")
      assert.doesNotMatch(result, /AtlasCluster|MercuryLaunch|Kubernetes|billing|subscription|deployment|rollout|roadmap|remaining tasks|maximum steps/i, "Summary imported unrelated background or step-limit recap content")
    } else assert.match(result, /sample\.json/i, "Summary did not preserve the synthetic task filename")
    const observed = JSON.parse(await readFile(observation, "utf8"))
    if (providerID === "openai") assert.equal(observed.outputCapOmitted, true)
    await host.remove(helper)
    helper = undefined
  }
  passed = true
  console.log(`PASS: ${cases.length} real-provider ${scenario} request(s); ${scenario === "brief-scope" ? "selected-range scope checks passed; " : ""}output-cap omission preserved.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : "Live test failed")
  process.exitCode = 1
} finally {
  try {
    if (helper) {
      await host.abort(helper)
      await host.remove(helper)
    }
    cleaned = (await client.session.list({}, { throwOnError: true })).data!.length === 0
  } catch {
    console.error("Temporary-session cleanup failed; inspect only the isolated test database.")
    process.exitCode = 1
  }
  await writeFile(path.join(root, "result.json"), JSON.stringify({ passed, cleaned, scenario, providerID, modelID, variant, summaryCharacters, scopeResults }, null, 2), { mode: 0o600 })
  if (child.pid && child.exitCode === null) {
    const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill()
    await stopped
  }
  await log.close()
}
