import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdir, writeFile, readFile, open } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Controller } from "../src/controller.ts"
import { sdkHost } from "../src/sdk-host.ts"
import { settings } from "../src/config.ts"
import { Storage } from "../src/storage.ts"
import { tokenCount } from "../src/tokens.ts"
import { readPolicy } from "../src/context.ts"
import { SummaryBatch } from "../src/batch.ts"
import { SummaryEditor } from "../src/summary-editor.ts"
import { AUTO_KEY, type Strategy } from "../src/auto-state.ts"
import { controlClient } from "../src/control.ts"

const [executable, root] = process.argv.slice(2)
if (!executable || !root) throw new Error("Usage: host-smoke.ts <absolute opencode executable> <isolated temporary root>")
const project = path.join(root, "project")
for (const dir of [project, "home", "config", "data", "cache", "state"].map((p) => path.isAbsolute(p) ? p : path.join(root, p))) await mkdir(dir, { recursive: true })
const requests: Record<string, unknown>[] = []
let parallelGate: Promise<void> | undefined
let releaseParallel: (() => void) | undefined
let parallelArrivals = 0
let concurrent = false
const provider = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  requests.push(input)
  const serialized = JSON.stringify(input.messages)
  const last = input.messages.at(-1)
  const summarize = serialized.includes("<selected_range_")
  const editing = serialized.includes("Only the supplied summary and this editing dialogue are available")
  if (summarize && parallelGate) {
    const gate = parallelGate
    if (++parallelArrivals === 2) { concurrent = true; parallelGate = undefined; releaseParallel!() }
    await gate
  }
  const lastUser = input.messages.findLast((message: { role: string }) => message.role === "user")
  const revise = summarize && JSON.stringify(lastUser).includes("Requested changes:")
  const tool = !summarize && last?.role === "user" && JSON.stringify(last).includes("EXERCISE_TOOL")
  const text = editing ? (serialized.includes("FRESH_EDIT_ONE") ? "FRESH_EDIT_TWO: corrected summary" : "FRESH_EDIT_ONE: clarified summary") : revise ? "Revised retained facts: ROOT_FACT; MANUAL_KEEP; next step is to validate the fixture." : summarize ? "Detailed retained facts: ROOT_FACT; fixture tool produced HEAD_FIXTURE and TAIL_FIXTURE. Work remains understood." : "Fixture assistant response; ROOT_FACT retained."
  const delta = tool ? { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "fixture_large", arguments: "{}" } }] } : { content: text }
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }])
    res.write(`data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [choice] })}\n\n`)
  res.end("data: [DONE]\n\n")
})
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
const address = provider.address()
if (!address || typeof address === "string") throw new Error("No fixture provider address")
const password = randomUUID()
const options = { prune: { threshold: 5000, head: 1000, tail: 1000 }, ui: { maxLinesPerTurn: 7 } }
const config = {
  "$schema": "https://opencode.ai/config.json", autoupdate: false, snapshot: false, share: "disabled", lsp: false, formatter: false,
  enabled_providers: ["fixture"], model: "fixture/fixture-model", permission: "allow",
  plugin: [[pathToFileURL(path.resolve("test/pause-fixture.ts")).href, { root }], [pathToFileURL(path.resolve("src/server.ts")).href, options], pathToFileURL(path.resolve("test/spill-fixture.ts")).href],
  provider: { fixture: {
    name: "Local test fixture", npm: "@ai-sdk/openai-compatible", options: { apiKey: "fixture-not-a-secret", baseURL: `http://127.0.0.1:${address.port}/v1` },
    models: {
      "fixture-model": { name: "Fixture", limit: { context: 200000, output: 32000 }, variants: { high: { temperature: 0.2 } } },
      "fixture-other": { name: "Other fixture", limit: { context: 200000, output: 32000 }, variants: { fast: { temperature: 0.1 } } },
      "fixture-gate": { name: "Autocompaction fixture", limit: { context: 50000, input: 30000, output: 20000 } },
    },
  } },
}
const log = await open(path.join(root, "host.log"), "a")
const child = spawn(executable, ["--print-logs", "--log-level", "DEBUG", "serve", "--hostname", "127.0.0.1", "--port", "41973"], {
  cwd: project, stdio: ["ignore", log.fd, log.fd], windowsHide: true,
  env: {
    ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"), OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_SERVER_USERNAME: "fixture", OPENCODE_SERVER_PASSWORD: password,
  },
})
child.on("error", (error) => console.error(error))
const headers = { authorization: `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}` }
let completed = false
try {
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited ${child.exitCode}`)
    try { ready = (await fetch("http://127.0.0.1:41973/global/health", { headers, signal: AbortSignal.timeout(1000) })).ok } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.ok(ready, "Isolated OpenCode did not start")
  const client = createOpencodeClient({
    baseUrl: "http://127.0.0.1:41973", directory: project, headers,
    fetch: (input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const timeout = AbortSignal.timeout(45000)
      return fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    },
  })
  const host = sdkHost(client)
  const created = (await client.session.create({ title: "Context manager isolated smoke" }, { throwOnError: true })).data!
  const send = async (text: string) => {
    const result = (await client.session.prompt({ sessionID: created.id, model: { providerID: "fixture", modelID: "fixture-model" }, parts: [{ type: "text", text }] }, { throwOnError: true, signal: AbortSignal.timeout(45000) })).data!
    assert.ok(!result.info.error, JSON.stringify(result.info.error))
    return result
  }
  await send("ROOT_FACT " + "Useful information. ".repeat(500) + " EXERCISE_TOOL")
  const stored = await host.messages(created.id)
  const tool = stored.flatMap((m) => m.parts).find((p) => p.type === "tool")
  assert.ok(tool?.type === "tool" && tool.state.status === "completed", JSON.stringify(stored))
  assert.ok(tool.state.output.includes("HEAD_FIXTURE") && tool.state.output.includes("TAIL_FIXTURE"), "head/tail spill preview failed")
  const storage = new Storage(project, path.join(root, "home", ".local", "state", "opencode-context-manager"))
  const published = await storage.config()
  assert.equal(published?.settings.ui.maxLinesPerTurn, 7)
  assert.deepEqual(published?.settings.prune, options.prune, "Server must publish token-only options unchanged")
  const controller = new Controller(host, created.id, settings(published!.settings), storage)
  const loaded = await controller.load()
  assert.ok(loaded.runtime?.system?.length, "System capture unavailable in isolated plugin storage")
  assert.ok(loaded.runtime?.tools?.some((tool) => tool.id === "fixture_large"), "Fixture tool not present in captured catalog")
  const ids = loaded.blocks[0].sourceIDs
  await controller.prune(ids)
  const savedPrune = readPolicy(await host.session(created.id)).operations.at(-1)!.rule
  assert.ok(savedPrune?.unit === "tokens")
  assert.equal(savedPrune.threshold, 5000)
  assert.equal(savedPrune.head, 1000)
  assert.equal(savedPrune.tail, 1000)
  assert.ok(JSON.stringify((await controller.load()).blocks).includes("middle omitted"))
  const beforePrunedRequest = requests.length
  await send("Continue immediately after tool-prune only")
  assert.ok(requests.length > beforePrunedRequest, "Post-pruning prompt did not reach the provider")
  const prunedRequest = JSON.stringify(requests.at(-1)!.messages)
  assert.ok(prunedRequest.includes("middle omitted"), "Provider did not receive the pruned tool result")
  assert.ok(prunedRequest.includes("HEAD_FIXTURE") && prunedRequest.includes("TAIL_FIXTURE"))
  const toolResults = (requests.at(-1)!.messages as { role: string; content: string }[]).filter((message) => message.role === "tool")
  const prunedTool = toolResults.find((message) => message.content.includes("HEAD_FIXTURE"))
  assert.ok(prunedTool && tokenCount(prunedTool.content, savedPrune.encoding) < savedPrune.threshold, "Provider did not receive a token-budgeted result")
  assert.ok(!prunedTool.content.includes(tool.state.output), "Unpruned tool output leaked into the request")
  const beforeUnprune = requests.length
  const unprune = await controller.prepareRestore("unprune", ids)
  assert.equal(unprune.outputs, 1)
  await controller.applyRestore(unprune)
  assert.equal(requests.length, beforeUnprune, "Unprune must not invoke a model")
  await send("Continue after restoring selected tool outputs")
  assert.ok(JSON.stringify(requests.at(-1)!.messages).includes("x".repeat(5000)), "Stored tool output was not restored")
  await controller.prune(ids)
  const beforeSummary = requests.length
  const draft = await controller.summarize("compact", ids, { providerID: "fixture", modelID: "fixture-model", variant: "high" })
  assert.equal(draft.attempts, 2, "Overshort compact draft must receive one expansion request")
  const initialSummaryRequest = requests[beforeSummary]
  const expansionRequest = requests[beforeSummary + 1]
  assert.equal(requests.length, beforeSummary + 2, "There must be exactly one automatic retry")
  const expansionPrompt = JSON.stringify((expansionRequest.messages as { role: string }[]).findLast((message) => message.role === "user"))
  assert.ok(expansionPrompt.includes(`Initial selected range size: ${draft.operation.beforeTokens} tokens`))
  assert.ok(expansionPrompt.includes("Your complete replacement size:") && expansionPrompt.includes("Reduction: x"))
  assert.ok(expansionPrompt.includes("too short") && expansionPrompt.includes("not targets or requirements"))
  assert.ok(expansionPrompt.includes("no useful information"), "Sparse-source exception is missing")
  assert.equal(initialSummaryRequest.max_tokens, 32000, "Plugin must not lower the host/provider output cap")
  assert.equal(expansionRequest.max_tokens, 32000)
  assert.ok(!JSON.stringify(initialSummaryRequest.messages).includes("CRITICAL - MAXIMUM STEPS REACHED"), "Summarizer request was overridden by OpenCode's generic max-steps work recap")
  assert.ok(!Array.isArray(initialSummaryRequest.tools) || initialSummaryRequest.tools.length === 0, "Summarizer must remain tool-disabled")
  const helperBefore = await host.messages(draft.jobID)
  assert.ok(helperBefore[0].parts.some((p) => p.type === "text" && p.text.includes("<selected_range_")), "First helper prompt lost original context")
  const revised = await controller.refine(draft, draft.operation.summary + "\nMANUAL_KEEP", "Include next steps.", { providerID: "fixture", modelID: "fixture-other", variant: "fast" })
  assert.equal(revised.jobID, draft.jobID)
  const helperAfter = await host.messages(draft.jobID)
  assert.deepEqual(helperAfter[0], helperBefore[0])
  const helperUsers = helperAfter.filter((m) => m.info.role === "user")
  assert.equal(helperUsers.length, 3)
  const latestUser = helperUsers.at(-1)!
  assert.ok(latestUser.info.role === "user" && latestUser.info.model.variant === "fast")
  assert.ok(latestUser.parts.some((p) => p.type === "text" && p.text.includes("MANUAL_KEEP")))
  const revisionRequest = requests.at(-1)!
  assert.equal(revisionRequest.model, "fixture-other")
  assert.equal(revisionRequest.max_tokens, 32000)
  const revisionHistory = JSON.stringify(revisionRequest.messages)
  assert.ok(revisionHistory.includes("<selected_range_") && revisionHistory.includes("Include next steps."), "Provider request did not retain compaction conversation")
  assert.ok(!revisionHistory.includes("CRITICAL - MAXIMUM STEPS REACHED"), "Revision request got the host's generic work recap")
  await controller.apply(revised, revised.operation.summary!)
  await assert.rejects(host.session(draft.jobID), "Applied summary helper must be deleted")
  const beforeRequest = requests.length
  await send("Continue after selected-range summary")
  assert.ok(requests.length > beforeRequest)
  const final = JSON.stringify(requests.at(-1))
  assert.ok(final.includes("Context manager compact summary"), "Provider did not receive summary projection")
  assert.ok(!final.includes("Useful information. Useful information."), "Original selected range leaked into effective context")
  const beforeExpand = requests.length
  const expand = await controller.prepareRestore("expand", ids)
  assert.equal(expand.summaries, 1)
  await controller.applyRestore(expand)
  assert.equal(requests.length, beforeExpand, "Expansion must not invoke a model")
  await send("Continue after expanding the selected summary")
  const expandedRequest = JSON.stringify(requests.at(-1)!.messages)
  assert.ok(expandedRequest.includes("middle omitted"), "Expansion must retain pre-summary pruning")
  assert.ok(!expandedRequest.includes("Context manager compact summary"), "Expanded summary still in effective context")
  await controller.dump("1.18.33")
  await controller.undo(-1)
  assert.equal((await controller.load()).blocks[0].kind, "compact")
  await controller.undo(1)
  assert.equal((await controller.load()).blocks[0].kind, "turn")
  const restored = await host.messages(created.id)
  assert.deepEqual(restored.slice(0, stored.length), stored)
  const batch = new SummaryBatch(controller)
  const beforeBatch = await controller.load()
  const batchRanges = [beforeBatch.blocks[0].sourceIDs, beforeBatch.blocks[2].sourceIDs]
  await batch.start("brief", batchRanges)
  parallelGate = new Promise<void>((resolve) => { releaseParallel = resolve })
  const timeout = setTimeout(() => { parallelGate = undefined; releaseParallel!() }, 10000)
  const firstParallelRequest = requests.length
  try { await batch.generate() } finally { clearTimeout(timeout) }
  assert.ok(concurrent, "The host must reach both provider requests before either response completes")
  assert.equal(batch.entries.filter((entry) => entry.status === "ready").length, 2)
  assert.equal(requests.length, firstParallelRequest + 2)
  for (const request of requests.slice(firstParallelRequest)) {
    const body = JSON.stringify(request.messages)
    assert.ok(body.includes("Continue immediately after tool-prune only"))
    assert.ok(body.includes("Continue after restoring selected tool outputs"))
    assert.ok(body.includes("Continue after expanding the selected summary"))
    assert.ok(!body.includes("PARALLEL_SUMMARY_"), "A sibling result leaked into frozen background")
  }
  const jobIDs = batch.entries.map((entry) => entry.draft!.jobID)
  assert.equal(new Set(jobIDs).size, 2)
  const update = host.update
  let writes = 0
  host.update = async (...args) => { writes++; await update(...args) }
  batch.entries[0].text = "PARALLEL_SUMMARY_ONE: retained ROOT_FACT"
  batch.entries[1].text = "PARALLEL_SUMMARY_TWO: retained second selected range"
  await batch.apply()
  assert.equal(writes, 1)
  host.update = update
  for (const id of jobIDs) await assert.rejects(host.session(id), "Batch helper must be deleted after application")
  await send("Continue after applying the parallel batch")
  const batchRequest = JSON.stringify(requests.at(-1)!.messages)
  assert.ok(batchRequest.includes("PARALLEL_SUMMARY_ONE") && batchRequest.includes("PARALLEL_SUMMARY_TWO"))
  assert.ok(batchRequest.includes("Continue immediately after tool-prune only"), "Unselected gap was altered")
  await batch.dispose()
  const summaryID = readPolicy(await host.session(created.id)).operations.find((op) => op.summary?.includes("PARALLEL_SUMMARY_ONE"))!.id
  const editor = new SummaryEditor(controller, await controller.summary(summaryID))
  const createJob = host.createJob
  const editJobs: string[] = []
  host.createJob = async (purpose) => { const id = await createJob(purpose); if (purpose === "edit") editJobs.push(id); return id }
  const editChoice = { providerID: "fixture", modelID: "fixture-model", variant: "high" }
  await editor.request("Clarify this summary", editChoice)
  const editFirst = requests.at(-1)!
  const editBody = JSON.stringify(editFirst.messages)
  assert.ok(editBody.includes("PARALLEL_SUMMARY_ONE"))
  assert.ok(!editBody.includes("PARALLEL_SUMMARY_TWO") && !editBody.includes("Continue immediately after tool-prune only") && !editBody.includes("<selected_range_"), "Edit dialogue must not receive original session background")
  assert.ok(!Array.isArray(editFirst.tools) || editFirst.tools.length === 0, "Summary editor must be tool-disabled")
  assert.equal(editFirst.max_tokens, 32000)
  assert.equal((await controller.summary(summaryID)).text, "PARALLEL_SUMMARY_ONE: retained ROOT_FACT")
  const firstEditMessage = (await host.messages(editJobs[0]))[0]
  await editor.request("Make another correction", editChoice)
  assert.equal(editJobs.length, 1)
  assert.deepEqual((await host.messages(editJobs[0]))[0], firstEditMessage)
  assert.ok(JSON.stringify(requests.at(-1)!.messages).includes("FRESH_EDIT_ONE"))
  await editor.apply()
  assert.equal((await controller.summary(summaryID)).text, "FRESH_EDIT_TWO: corrected summary")
  await assert.rejects(host.session(editJobs[0]), "Applied edit dialogue must be disposed")
  await send("Continue after editing a saved summary")
  const editedRequest = JSON.stringify(requests.at(-1)!.messages)
  assert.ok(editedRequest.includes("FRESH_EDIT_TWO") && editedRequest.includes("PARALLEL_SUMMARY_TWO"))
  await controller.undo(-1)
  assert.equal((await controller.summary(summaryID)).text, "PARALLEL_SUMMARY_ONE: retained ROOT_FACT")
  await controller.undo(1)
  assert.equal((await controller.summary(summaryID)).text, "FRESH_EDIT_TWO: corrected summary")
  await editor.dispose()
  host.createJob = createJob
  const beforeNoReply = requests.length
  await client.session.prompt({ sessionID: created.id, model: editChoice, noReply: true, parts: [{ type: "text", text: "USER_ONLY_CANARY: this request has no assistant response yet" }] }, { throwOnError: true })
  assert.equal(requests.length, beforeNoReply)
  const pendingTurn = (await controller.load()).blocks.at(-1)!
  assert.equal(pendingTurn.closed, false)
  assert.equal(pendingTurn.messages.length, 1)
  const originalPending = structuredClone(pendingTurn.messages)
  const pendingDraft = await controller.summarize("brief", pendingTurn.sourceIDs)
  assert.ok(JSON.stringify(requests.at(-1)!.messages).includes("unfinished snapshot"))
  await controller.apply(pendingDraft, "UNFINISHED_SUMMARY: the user asked a question; no response was recorded.")
  const appliedPending = (await controller.load()).blocks.at(-1)!
  assert.deepEqual(appliedPending.messages.map((message) => message.info.role), ["user", "assistant"])
  assert.notEqual(appliedPending.messages[0].info.id, appliedPending.messages[1].info.id)
  await send("Continue after summarizing a user-only turn")
  const pendingRequest = JSON.stringify(requests.at(-1)!.messages)
  assert.ok(pendingRequest.includes("UNFINISHED_SUMMARY") && !pendingRequest.includes("USER_ONLY_CANARY"))
  const pendingRestore = await controller.prepareRestore("expand", pendingTurn.sourceIDs)
  await controller.applyRestore(pendingRestore)
  assert.deepEqual((await controller.load()).blocks.find((block) => block.sourceIDs[0] === pendingTurn.sourceIDs[0])!.messages, originalPending)
  await send("Continue after expanding the user-only turn")
  assert.ok(JSON.stringify(requests.at(-1)!.messages).includes("USER_ONLY_CANARY"))
  const waitForPause = async () => {
    for (let index = 0; index < 400; index++) {
      const raw = await host.messages(created.id)
      const user = raw.findLast((message) => message.info.role === "user")!
      const file = path.join(root, `pause-${user.info.id}.json`)
      const state = await readFile(file, "utf8").then(JSON.parse).catch(() => undefined)
      if (state?.status === "paused") return { file, users: raw.filter((message) => message.info.role === "user").length }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error("Pause probe did not reach the gate")
  }
  const pending = send("PAUSE_PROBE EXERCISE_TOOL")
  const paused = await waitForPause()
  assert.equal(await host.idle(created.id), false)
  const requestsAtPause = requests.length
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(requests.length, requestsAtPause, "No provider request may pass the suspended hook")
  const maintenance = new Controller({ ...host, idle: async (id) => id === created.id || host.idle(id) }, created.id, settings(published!.settings), storage)
  const oldBlock = (await maintenance.load()).blocks[0]
  const pausedDraft = await maintenance.summarize("brief", oldBlock.sourceIDs)
  await maintenance.apply(pausedDraft, "PAUSE_CHANGED: earlier context replaced while the main loop was suspended.")
  await writeFile(paused.file, JSON.stringify({ action: "resume" }))
  await pending
  assert.ok(JSON.stringify(requests.at(-1)!.messages).includes("PAUSE_CHANGED"))
  assert.equal((await host.messages(created.id)).filter((message) => message.info.role === "user").length, paused.users, "Resume must not create a user message")
  const cancelled = send("PAUSE_PROBE EXERCISE_TOOL").catch(() => undefined)
  const stopped = await waitForPause()
  await host.abort(created.id)
  await cancelled
  assert.equal(await host.idle(created.id), true)
  for (let i = 0; i < 100 && JSON.parse(await readFile(stopped.file, "utf8")).status !== "aborted"; i++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(JSON.parse(await readFile(stopped.file, "utf8")).status, "aborted")
  await maintenance.dispose()
  assert.ok(published?.control)
  const control = controlClient(published.control)
  const controlledHost = sdkHost(client, control)
  const gateModel = { providerID: "fixture", modelID: "fixture-gate" }
  const pauseFor = async (id: string) => {
    for (let i = 0; i < 600; i++) {
      const state = await control.state(id)
      if (state.pause?.phase === "manual") return state.pause
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error("Production context gate was not reached")
  }
  const seed = async (mode: Strategy, parts: string[]) => {
    const session = (await client.session.create({ title: `Isolated ${mode} gate` }, { throwOnError: true })).data!
    await control.command(session.id, { action: "strategy", strategy: mode })
    for (const text of parts) await client.session.prompt({ sessionID: session.id, model: gateModel, noReply: true, parts: [{ type: "text", text }] }, { throwOnError: true })
    return session.id
  }
  const startGated = (id: string, text: string) => client.session.prompt({ sessionID: id, model: gateModel, parts: [{ type: "text", text }] }, { throwOnError: true })
  const manualID = await seed("MANUAL", ["OLD_GATE_CONTEXT " + "value ".repeat(14000)])
  const manualPending = startGated(manualID, "Protected request; manual gate fixture")
  const manualPause = await pauseFor(manualID)
  assert.equal(manualPause.threshold, 10000)
  assert.equal(manualPause.derived, false)
  assert.equal(await host.idle(manualID), false, "Host must still own the suspended loop")
  assert.equal(await controlledHost.idle(manualID), true, "Only the live control gate grants maintenance")
  const gatedController = new Controller(controlledHost, manualID, settings(published.settings), storage)
  const gatedLoaded = await gatedController.load()
  const protectedIDs = gatedLoaded.blocks.at(-1)!.sourceIDs
  await assert.rejects(gatedController.prune(protectedIDs), /protected/)
  await assert.rejects(control.command(manualID, { action: "resume", pauseID: manualPause.id }), /Resume blocked/)
  const manualDraft = await gatedController.summarize("brief", gatedLoaded.blocks[0].sourceIDs)
  await gatedController.apply(manualDraft, "MANUAL_GATE_REPLACEMENT: older context reduced while suspended.")
  await control.command(manualID, { action: "resume", pauseID: manualPause.id })
  const resumed = (await manualPending).data!
  assert.ok(!resumed.info.error, JSON.stringify(resumed.info.error))
  assert.ok(JSON.stringify(requests.at(-1)!.messages).includes("MANUAL_GATE_REPLACEMENT"))
  assert.ok(!JSON.stringify(requests.at(-1)!.messages).includes("OLD_GATE_CONTEXT"))
  assert.equal((await host.messages(manualID)).filter((message) => message.info.role === "user").length, 2)
  await gatedController.dispose()
  for (const mode of ["AUTO_SESSION", "AUTO_PER_TURN"] as const) {
    const id = await seed(mode, mode === "AUTO_SESSION" ? ["value ".repeat(14000)] : ["value ".repeat(6000), "value ".repeat(6000)])
    const reply = (await startGated(id, mode === "AUTO_SESSION" ? "Protected AUTO_SESSION request" : "p ".repeat(8000))).data!
    assert.ok(!reply.info.error, JSON.stringify(reply.info.error))
    const policy = readPolicy(await host.session(id))
    assert.equal(policy.cursor, mode === "AUTO_SESSION" ? 1 : 2)
    const latest = (await host.messages(id)).findLast((message) => message.info.role === "user")!
    assert.ok(policy.operations.every((op) => !op.sourceIDs.includes(latest.info.id)))
    assert.equal((await control.state(id)).pause, undefined)
    assert.equal((await host.session(id)).metadata?.[AUTO_KEY] && (await control.state(id)).strategy, mode)
  }
  const toolGateID = await seed("MANUAL", [])
  const toolPending = startGated(toolGateID, "EXERCISE_TOOL").catch(() => undefined)
  const toolPause = await pauseFor(toolGateID)
  const toolHistory = await host.messages(toolGateID)
  assert.ok(toolHistory.some((message) => message.parts.some((part) => part.type === "tool" && part.state.status === "completed")), "Tool result must be saved before the production gate")
  const callsBeforeStop = requests.length
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(requests.length, callsBeforeStop)
  await control.command(toolGateID, { action: "abort", pauseID: toolPause.id })
  await toolPending
  assert.equal(await host.idle(toolGateID), true)
  assert.equal((await control.state(toolGateID)).pause, undefined)
  completed = true
  console.log("PASS: stock OpenCode; manual/AUTO context gates, same-loop resume with no user prompt, protected tail, after-tool persistence, abort, all prior context workflows. Local fake provider only.")
} finally {
  await writeFile(path.join(root, "result.json"), JSON.stringify({ passed: completed, providerRequests: requests.length }, null, 2))
  provider.closeAllConnections()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
  if (child.exitCode === null) {
    const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill()
    await stopped
  }
  await log.close()
}
