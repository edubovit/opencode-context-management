import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Controller } from "../src/controller.ts"
import { SummaryBatch } from "../src/batch.ts"
import { SummaryEditor } from "../src/summary-editor.ts"
import { remoteHost } from "../src/control.ts"
import { settings, KEY, VERSION } from "../src/config.ts"
import { fixture } from "./host-fixture.ts"
import { ContextManager } from "../src/rpc.ts"
import { verifyInspector } from "./host-tui.ts"

const arguments_ = process.argv.slice(2).filter((value) => !value.startsWith("--"))
const test = await fixture(arguments_[0], arguments_[1])
const checks: string[] = []
const sessions: string[] = []
let passed = false
const make = async () => {
  const session = await test.client.session.create({ location: { directory: test.project }, model: { providerID: "fixture", id: "fixture" }, title: "Context manager production smoke", metadata: { unrelated: "keep" } })
  sessions.push(session.id)
  const remote = remoteHost(test.client, session.id)
  const loaded = await remote.load()
  assert.equal(loaded.version, VERSION)
  return new Controller(remote.host, session.id, settings(loaded.settings), remote.artifacts)
}
const send = async (controller: Controller, text: string) => {
  await test.client.session.prompt({ sessionID: controller.sessionID, text })
  await test.client.session.wait({ sessionID: controller.sessionID })
  const info = await test.client.session.get({ sessionID: controller.sessionID })
  assert.equal(info.outcome, "succeeded", JSON.stringify(await test.client.session.context({ sessionID: controller.sessionID })))
}
try {
  await test.until(async () => {
    const list = await test.client.plugin.list({ location: { directory: test.project } })
    const item = list.data.find((item) => item.id === "context-manager")
    if (item?.state.status === "failed") throw new Error(item.state.error)
    return item?.state.status === "active" && item.features.tui
  }, "production plugin loading")
  checks.push("production V2 server and automatic TUI discovery")
  for (const options of [{ reasoning: true }, { reasoning: false, tools: "large" as const }, { reasoning: true, tools: "large" as const }, { reasoning: false, tools: "all" as const }, { reasoning: true, tools: "all" as const }, { reasoning: true, tools: "delete" as const }]) {
    const controller = await make()
    await send(controller, "ROOT_FACT EXERCISE_TOOL")
    const original = await test.client.session.context({ sessionID: controller.sessionID })
    const loaded = await controller.load()
    assert.ok(loaded.runtime?.tools?.some((tool) => tool.id === "fixture_tool"))
    assert.ok(JSON.stringify(loaded.raw).includes("HEAD_FIXTURE") && JSON.stringify(loaded.raw).includes("TAIL_FIXTURE"))
    await controller.prune(loaded.blocks[0].sourceIDs, options)
    assert.equal((await controller.load()).policy.version, 7)
    await send(controller, "Immediate next request after context edit")
    const request = JSON.stringify(test.requests.at(-1)?.messages)
    assert.equal(request.includes("REASONING_FIXTURE"), !options.reasoning)
    if (options.tools === "large") assert.match(request, /HEAD_FIXTURE[\s\S]*middle omitted[\s\S]*TAIL_FIXTURE/)
    if (options.tools === "all") { assert.match(request, /Tool output pruned/); assert.ok(!request.includes("HEAD_FIXTURE")) }
    if (options.tools === "delete") { assert.ok(!request.includes("HEAD_FIXTURE")); assert.ok(!request.includes("call_fixture")) }
    const stored = await test.client.session.context({ sessionID: controller.sessionID })
    assert.deepEqual(stored.filter((message) => original.some((before) => before.id === message.id)), original)
    assert.equal((await test.client.session.get({ sessionID: controller.sessionID })).metadata?.unrelated, "keep")
    checks.push(`actual RPC/controller ${JSON.stringify(options)}; unchanged stored transcript`)
  }
  const controller = await make()
  await send(controller, "ROOT_FACT " + "Selected information. ".repeat(400) + " EXERCISE_TOOL")
  await send(controller, "SECOND_FACT " + "Independent information. ".repeat(400))
  await send(controller, "THIRD_FACT " + "More independent information. ".repeat(400))
  let loaded = await controller.load()
  await controller.prune(loaded.blocks[0].sourceIDs)
  loaded = await controller.load()
  const before = structuredClone(loaded.blocks[0])
  const draft = await controller.summarize("compact", loaded.blocks[0].sourceIDs)
  assert.ok(draft.attempts >= 1 && draft.attempts <= 2)
  await controller.apply(draft, draft.operation.summary!)
  await send(controller, "Observe compact summary now")
  assert.match(JSON.stringify(test.requests.at(-1)?.messages), /Context manager compact summary/)
  const summary = (await controller.load()).blocks[0]
  const view = await controller.summary(summary.summaryID!)
  await controller.editSummary(view, "MANUAL_KEEP ROOT_FACT")
  await send(controller, "Observe edited summary now")
  assert.match(JSON.stringify(test.requests.at(-1)?.messages), /MANUAL_KEEP/)
  await controller.applyRestore(await controller.prepareRestore("expand", summary.sourceIDs))
  assert.deepEqual((await controller.load()).blocks[0], before)
  await send(controller, "Observe expanded previously pruned context")
  assert.match(JSON.stringify(test.requests.at(-1)?.messages), /middle omitted/)
  checks.push("summary, revision, exact expansion with prior pruning; immediate provider requests")

  loaded = await controller.load()
  const batch = new SummaryBatch(controller)
  await batch.start("brief", [loaded.blocks[0].sourceIDs, loaded.blocks[2].sourceIDs])
  const batchStart = test.requests.length
  const barrier = test.parallel(2)
  await batch.generate()
  assert.ok(batch.ready, JSON.stringify(batch.entries.map((entry) => entry.error)))
  assert.equal(barrier.count(), 2)
  for (const request of test.requests.slice(batchStart)) {
    const text = JSON.stringify(request.messages)
    for (const fact of ["ROOT_FACT", "SECOND_FACT", "THIRD_FACT"]) assert.ok(text.includes(fact))
    assert.ok(!text.includes("Retained selected facts:"), "A sibling summary leaked into an initial frozen request")
  }
  barrier.release()
  const revision = (await controller.load()).policy.revision
  await batch.apply()
  assert.equal((await controller.load()).policy.revision, revision + 2)
  checks.push("parallel helpers see frozen background; complete batch applies")
  await send(controller, "Observe parallel summaries")
  assert.equal((JSON.stringify(test.requests.at(-1)?.messages).match(/Context manager brief summary/g) ?? []).length, 2)
  const editor = new SummaryEditor(controller, await controller.summary((await controller.load()).blocks[0].summaryID!))
  const count = test.requests.length
  await editor.request("Clarify this saved summary", { providerID: "fixture", modelID: "fixture" })
  assert.equal(editor.draft, "EDIT_ONE: clarified saved summary")
  const editing = JSON.stringify(test.requests[count])
  assert.ok(!editing.includes("SECOND_FACT") && !editing.includes("EXERCISE_TOOL"))
  await editor.request("Correct the proposal", { providerID: "fixture", modelID: "fixture", variant: "high" })
  await editor.apply()
  assert.match((await controller.load()).blocks[0].messages.map((message) => JSON.stringify(message.parts)).join(""), /EDIT_TWO/)
  await editor.dispose()
  checks.push("summary-only editing, continued proposal, variant switch, explicit apply")
  const dump = JSON.parse(await readFile(await controller.dump("2.0.24"), "utf8"))
  assert.equal(dump.pluginVersion, VERSION)
  assert.equal(dump.schemaVersion, 3)
  assert.ok(!JSON.stringify(dump.blocks).includes('"previous"'))
  checks.push("server-owned effective export excludes expansion layers")

  for (const strategy of ["MANUAL", "AUTO_PER_TURN", "AUTO_SESSION"] as const) {
    const auto = await make()
    await send(auto, "EARLIER_ROOT " + "Useful previous facts. ".repeat(4500))
    await send(auto, "EARLIER_SECOND " + "Other previous facts. ".repeat(1000))
    await auto.host.auto!.command(auto.sessionID, { action: "strategy", strategy })
    await test.client.session.switchModel({ sessionID: auto.sessionID, model: { providerID: "fixture", id: "small" } })
    const beforeUsers = (await test.client.session.context({ sessionID: auto.sessionID })).filter((message) => message.type === "user").length
    await test.client.session.prompt({ sessionID: auto.sessionID, text: "ACTIVE_PROTECTED follow up" })
    if (strategy === "MANUAL") {
      const state = await test.until(async () => (await auto.host.auto!.state(auto.sessionID)).pause, "MANUAL suspension")
      const current = await auto.load()
      await assert.rejects(auto.prune(current.blocks.at(-1)!.sourceIDs, { reasoning: true, tools: "delete" }), /protected/)
      const next = await auto.summarize("brief", current.blocks[0].sourceIDs)
      await auto.apply(next, next.operation.summary!)
      await auto.host.auto!.command(auto.sessionID, { action: "resume", pauseID: state.id })
    }
    await test.client.session.wait({ sessionID: auto.sessionID })
    assert.equal((await test.client.session.get({ sessionID: auto.sessionID })).outcome, "succeeded")
    assert.equal((await test.client.session.context({ sessionID: auto.sessionID })).filter((message) => message.type === "user").length, beforeUsers + 1)
    assert.ok((await auto.load()).policy.cursor > 0)
    checks.push(`${strategy} actual near-limit reduction and same-loop resume`)
  }
  const broken = await make()
  await test.client.session.update({ sessionID: broken.sessionID, metadata: { [KEY]: { version: 6, operations: [] }, unrelated: "keep" } })
  await assert.rejects(broken.load(), /V1 or inherited/)
  checks.push("legacy ledger blocked without mutation")
  const rpc = test.client.rpc(ContextManager)
  const first = await make()
  const second = await make()
  const job = await rpc.createJob({ sessionID: first.sessionID, purpose: "summary" }, { location: { directory: test.project } })
  await assert.rejects(rpc.removeJob({ sessionID: second.sessionID, jobID: job }, { location: { directory: test.project } }))
  await rpc.removeJob({ sessionID: first.sessionID, jobID: job }, { location: { directory: test.project } })
  checks.push("helper ownership enforced by server RPC")

  const partial = await make()
  await send(partial, "SUCCESS_RANGE synthetic source")
  await send(partial, "FAIL_RANGE synthetic source")
  const partialBatch = new SummaryBatch(partial)
  const partialSource = await partial.load()
  await partialBatch.start("brief", partialSource.blocks.map((block) => block.sourceIDs))
  let failed = false
  test.respond((wire) => {
    const message = wire.messages.findLast((message) => message.role === "user")
    const text = typeof message?.content === "string" ? message.content : JSON.stringify(message?.content)
    const selected = /<selected_range_[^>]+>([\s\S]*?)<\/selected_range_[^>]+>/.exec(text)?.[1]
    if (!failed && selected?.includes("FAIL_RANGE")) { failed = true; return { text: "Truncated and invalid", finish: "length" } }
    return undefined
  })
  await partialBatch.generate()
  assert.equal(partialBatch.ready, false)
  assert.equal(partialBatch.entries.filter((entry) => entry.status === "ready").length, 1)
  assert.equal((await partial.load()).policy.cursor, 0)
  await assert.rejects(partialBatch.apply(), /Every range/)
  const readyJob = partialBatch.entries.find((entry) => entry.status === "ready")!.draft!.jobID
  const retryStart = test.requests.length
  await partialBatch.generate()
  assert.equal(test.requests.length, retryStart + 1)
  assert.ok(partialBatch.entries.some((entry) => entry.draft?.jobID === readyJob))
  await partialBatch.apply()
  test.respond(() => undefined)
  assert.equal((await partial.load()).policy.cursor, 2)
  checks.push("truncated sibling blocks partial application; retry only failed helper, one complete batch")

  const cancelEditor = new SummaryEditor(partial, await partial.summary((await partial.load()).blocks[0].summaryID!))
  const release = test.hold()
  const cancelRevision = (await partial.load()).policy.revision
  const cancelStart = test.requests.length
  const cancelled = cancelEditor.request("HOLD_FIXTURE do not apply a late answer", { providerID: "fixture", modelID: "fixture" }).catch((error: unknown) => error)
  await test.until(() => test.requests.length > cancelStart, "pending edit provider request")
  await cancelEditor.cancel()
  assert.ok(await cancelled instanceof Error)
  release()
  await cancelEditor.dispose()
  assert.equal((await partial.load()).policy.revision, cancelRevision)
  assert.equal((await test.client.session.list({ parentID: partial.sessionID })).data.length, 0)
  checks.push("cancelled editor cannot apply late output; owned helpers removed")

  const queued = await make()
  await send(queued, "EARLIER_CONTEXT " + "Earlier useful facts. ".repeat(4500))
  await test.client.session.switchModel({ sessionID: queued.sessionID, model: { providerID: "fixture", id: "small" } })
  await test.client.session.prompt({ sessionID: queued.sessionID, text: "ACTIVE_BEFORE_STEER" })
  const queuePause = await test.until(async () => (await queued.host.auto!.state(queued.sessionID)).pause, "pause before steering")
  await test.client.session.prompt({ sessionID: queued.sessionID, text: "STEER_WHILE_PAUSED", delivery: "steer" })
  await test.client.session.prompt({ sessionID: queued.sessionID, text: "QUEUE_WHILE_PAUSED", delivery: "queue" })
  const queueView = await queued.load()
  const queueDraft = await queued.summarize("brief", queueView.blocks[0].sourceIDs)
  await queued.apply(queueDraft, queueDraft.operation.summary!)
  await queued.host.auto!.command(queued.sessionID, { action: "resume", pauseID: queuePause.id })
  await test.client.session.wait({ sessionID: queued.sessionID })
  const queueHistory = await test.client.session.context({ sessionID: queued.sessionID })
  for (const text of ["ACTIVE_BEFORE_STEER", "STEER_WHILE_PAUSED", "QUEUE_WHILE_PAUSED"]) assert.equal(queueHistory.filter((message) => message.type === "user" && message.text === text).length, 1)
  assert.equal(queueHistory.filter((message) => message.type === "user").length, 4)
  checks.push("steered/queued inputs during pause delivered exactly once; no fabricated continuation")

  const stopped = await make()
  await send(stopped, "OVER_BUDGET " + "Earlier useful facts. ".repeat(4500))
  await test.client.session.switchModel({ sessionID: stopped.sessionID, model: { providerID: "fixture", id: "small" } })
  let stopCalls = test.requests.length
  await test.client.session.prompt({ sessionID: stopped.sessionID, text: "NATIVE_STOP" })
  await test.until(async () => (await stopped.host.auto!.state(stopped.sessionID)).pause, "native stop gate")
  await test.client.session.interrupt({ sessionID: stopped.sessionID, resume: false })
  await test.client.session.wait({ sessionID: stopped.sessionID })
  await test.until(async () => !(await stopped.host.auto!.state(stopped.sessionID)).pause, "native stop release")
  assert.equal(test.requests.length, stopCalls)
  await test.client.session.prompt({ sessionID: stopped.sessionID, text: "RPC_ABORT" })
  const abortPause = await test.until(async () => (await stopped.host.auto!.state(stopped.sessionID)).pause, "RPC abort gate")
  await stopped.host.auto!.command(stopped.sessionID, { action: "abort", pauseID: abortPause.id })
  await test.client.session.wait({ sessionID: stopped.sessionID })
  assert.equal(test.requests.length, stopCalls)
  checks.push("native Stop and RPC abort revoke actual autocompaction gates without dispatch")
  await test.client.session.switchModel({ sessionID: stopped.sessionID, model: { providerID: "fixture", id: "fixture" } })
  const unfinished = (await stopped.load()).blocks.find((block) => block.messages[0].parts.some((part) => part.type === "text" && part.text === "NATIVE_STOP"))!
  assert.equal(unfinished.closed, false)
  const unfinishedDraft = await stopped.summarize("brief", unfinished.sourceIDs)
  await stopped.apply(unfinishedDraft, unfinishedDraft.operation.summary!)
  await send(stopped, "Observe user-only summary after an interrupted turn")
  assert.match(JSON.stringify(test.requests.at(-1)?.messages), /Context manager brief summary/)
  await stopped.applyRestore(await stopped.prepareRestore("expand", unfinished.sourceIDs))
  checks.push("interrupted user-only turn summarizes with valid distinct assistant and expands")
  await test.client.session.switchModel({ sessionID: stopped.sessionID, model: { providerID: "fixture", id: "small" } })

  const moved = await make()
  await send(moved, "MOVE_ROOT EXERCISE_TOOL")
  await moved.prune((await moved.load()).blocks[0].sourceIDs, { reasoning: true })
  const orphanCandidate = await rpc.createJob({ sessionID: moved.sessionID, purpose: "summary" }, { location: { directory: test.project } })
  const destination = path.join(test.root, "moved")
  await mkdir(destination)
  await test.client.session.move({ sessionID: moved.sessionID, directory: destination })
  await test.client.session.wait({ sessionID: moved.sessionID })
  await test.until(async () => (await test.client.session.get({ sessionID: moved.sessionID })).location.directory === destination, "session move")
  await test.until(async () => !(await test.client.session.list({ parentID: moved.sessionID })).data.some((session) => session.id === orphanCandidate), "moved helper cleanup")
  await send(moved, "Request after moving the session")
  assert.ok(!JSON.stringify(test.requests.at(-1)?.messages).includes("REASONING_FIXTURE"))
  checks.push("session movement preserves policy, routes RPC by session location and cleans old helpers")

  await test.client.session.prompt({ sessionID: stopped.sessionID, text: "RELOAD_WHILE_PAUSED" })
  const oldPause = await test.until(async () => (await stopped.host.auto!.state(stopped.sessionID)).pause, "reload gate")
  stopCalls = test.requests.length
  const altered = { ...test.config, plugins: ["-opencode.provider.*", { package: path.join(test.repo, "src"), options: { autocompaction: { headroom: 2001 }, summarizer: { providerID: "fixture", modelID: "fixture" } } }, path.join(test.repo, "test/host-fixture")] }
  await writeFile(test.configPath, JSON.stringify(altered))
  await test.until(async () => { try { return (await rpc.inspect({ sessionID: stopped.sessionID }, { location: { directory: test.project } })).settings.autocompaction.headroom === 2001 } catch { return false } }, "production plugin reload")
  await test.client.session.wait({ sessionID: stopped.sessionID })
  assert.equal((await stopped.host.auto!.state(stopped.sessionID)).pause, undefined)
  await assert.rejects(stopped.host.auto!.command(stopped.sessionID, { action: "resume", pauseID: oldPause.id }), /no longer active/)
  assert.equal(test.requests.length, stopCalls)
  await writeFile(test.configPath, JSON.stringify(test.config))
  await test.until(async () => { try { return (await rpc.inspect({ sessionID: stopped.sessionID }, { location: { directory: test.project } })).settings.autocompaction.headroom === 2000 } catch { return false } }, "original options restored")
  checks.push("production reload cancels a suspended request; stale persisted notice never grants resume")
  const unauthorized = await fetch(`${test.url}/api/rpc/context-manager/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { sessionID: first.sessionID } }) })
  assert.equal(unauthorized.status, 401)
  checks.push("native RPC authentication rejects unauthenticated control")
  const synthetic = await make()
  await test.client.session.switchModel({ sessionID: synthetic.sessionID, model: { providerID: "fixture", id: "small" } })
  const syntheticCalls = test.requests.length
  await test.client.session.synthetic({ sessionID: synthetic.sessionID, text: "Synthetic-only large context. ".repeat(5000) })
  await test.client.session.wait({ sessionID: synthetic.sessionID })
  assert.equal(test.requests.length, syntheticCalls)
  assert.equal((await test.client.session.get({ sessionID: synthetic.sessionID })).outcome, "failed")
  checks.push("oversized synthetic-only context fails safely instead of bypassing the budget gate")
  if (process.argv.includes("--tui")) {
    const ui = await make()
    await send(ui, "ROOT_FACT EXERCISE_TOOL")
    await send(ui, "Second UI turn")
    await verifyInspector(test, ui, arguments_[0] ?? "opencode")
    checks.push("real production inspector: ranges, pruning, native dialog focus, readers, summarization, model editing/apply, expansion and resize")
  }
  await batch.dispose()
  await controller.dispose()
  await test.client.session.prompt({ sessionID: stopped.sessionID, text: "SERVER_RESTART_WHILE_PAUSED" })
  const restartPause = await test.until(async () => (await stopped.host.auto!.state(stopped.sessionID)).pause, "server restart gate")
  const restartCalls = test.requests.length
  await test.restart()
  const fresh = remoteHost(test.client, stopped.sessionID)
  await test.until(async () => { try { return await fresh.load() } catch { return undefined } }, "plugin after server restart")
  await assert.rejects(fresh.host.auto!.command(stopped.sessionID, { action: "resume", pauseID: restartPause.id }), /no longer active/)
  if (!(await fresh.host.auto!.state(stopped.sessionID)).pause) await test.client.session.prompt({ sessionID: stopped.sessionID, text: "Explicit new input after restart" })
  const newPause = await test.until(async () => (await fresh.host.auto!.state(stopped.sessionID)).pause, "new live pause after restart")
  assert.notEqual(newPause.id, restartPause.id)
  assert.equal(test.requests.length, restartCalls)
  await fresh.host.auto!.command(stopped.sessionID, { action: "abort", pauseID: newPause.id })
  await test.client.session.wait({ sessionID: stopped.sessionID })
  checks.push("real server restart preserves ledger/strategy but replaces pause authority; no raw-context dispatch")
  passed = true
} finally {
  for (const sessionID of sessions) await test.client.session.remove({ sessionID }).catch(() => {})
  await test.close({ passed, checks })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
