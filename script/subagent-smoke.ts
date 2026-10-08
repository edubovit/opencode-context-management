import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { Controller } from "../src/controller.ts"
import { remoteHost } from "../src/control.ts"
import { settings } from "../src/config.ts"
import { AUTO_KEY } from "../src/auto-state.ts"
import { fixture } from "./host-fixture.ts"
import { tokenCount } from "../src/tokens.ts"

const test = await fixture(process.argv[2], undefined, { subagents: true, keep: 300 })
const checks: string[] = []
const roots: string[] = []
const leaves = new Map<string, number>()
const launches = new Map<string, { background: boolean; nested: boolean; started: boolean }>()
const branches = new Set<string>()
const failedHelpers = new Set<string>()
const largeLeaves = new Set<string>()
const manual: string[] = []
const watch = new AbortController()
let passed = false
let streamFailure: unknown
const text = "LEAF_TASK ROOT_FACT preserve the exempt tail and finish verification. " + "Earlier detailed findings and useful facts. ".repeat(700)
const events = (async () => {
  for await (const event of test.client.event.subscribe({ signal: watch.signal })) {
    if (event.type === "session.metadata.updated") {
      const auto = event.data.metadata?.[AUTO_KEY] as { pause?: { phase?: string } } | undefined
      if (auto?.pause?.phase === "manual") manual.push(event.data.sessionID)
    }
  }
})().catch((error) => { if (!watch.signal.aborted) streamFailure = error })
const helper = (messages: unknown) => JSON.stringify(messages).includes("<selected_range_")
test.respond((wire, scope) => {
  if (helper(wire.messages)) return scope.parentID && failedHelpers.has(scope.parentID) ? { text: "Incomplete summary", finish: "length" } : "ROOT_FACT: earlier findings retained. The delegated task remains unfinished; continue verification using the unchanged recent tool results."
  const launch = launches.get(scope.sessionID)
  if (launch && !launch.started) {
    launch.started = true
    return { tool: { name: "subagent", input: { agent: "fixture-worker", description: "Synthetic child compaction", prompt: launch.nested ? "SPAWN_LEAF" : text, ...(launch.nested ? {} : { model: "fixture/small" }), background: launch.background } } }
  }
  const current = JSON.stringify(wire.messages.findLast((message) => message.role === "user"))
  if (current.includes("SPAWN_LEAF") && !branches.has(scope.sessionID)) {
    branches.add(scope.sessionID)
    return { tool: { name: "subagent", input: { agent: "fixture-worker", description: "Nested compaction leaf", prompt: text, model: "fixture/small" } } }
  }
  if (current.includes("LEAF_TASK") || leaves.has(scope.sessionID)) {
    const count = (leaves.get(scope.sessionID) ?? 0) + 1
    leaves.set(scope.sessionID, count)
    return count <= (largeLeaves.has(scope.sessionID) ? 3 : 2) ? { tool: { name: "fixture_tool", input: { small: !largeLeaves.has(scope.sessionID) } } } : "LEAF_DONE ROOT_FACT"
  }
  return undefined
})
test.usage((wire, scope) => helper(wire.messages) ? undefined : leaves.has(scope.sessionID) ? { input: largeLeaves.has(scope.sessionID) ? leaves.get(scope.sessionID) === 1 ? 80000 : leaves.get(scope.sessionID) === 2 ? 130000 : 40000 : leaves.get(scope.sessionID) === 1 ? 10500 : 2000, output: 100 } : undefined)
const controller = async (id: string) => {
  const remote = remoteHost(test.client, id)
  const initial = await remote.load()
  return new Controller(remote.host, id, settings(initial.settings), remote.artifacts)
}
const send = async (id: string, prompt: string) => {
  await test.client.session.prompt({ sessionID: id, text: prompt })
  await test.client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(60000) })
}
const make = async () => {
  const session = await test.client.session.create({ location: { directory: test.project }, title: "Subagent smoke", model: { providerID: "fixture", id: "fixture" }, metadata: { unrelated: "parent-value" } })
  roots.push(session.id)
  return session.id
}
const verifyLeaf = async (id: string) => {
  await test.client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(60000) })
  const info = await test.client.session.get({ sessionID: id })
  const cm = await controller(id)
  const loaded = await cm.load()
  assert.equal(info.outcome, "succeeded", JSON.stringify(info))
  assert.equal(loaded.policy.sessionID, id)
  assert.ok(loaded.policy.operations.some((op) => op.checkpoint))
  assert.equal(loaded.auto?.strategy, "AUTO_PER_TURN")
  assert.equal(loaded.auto?.pause, undefined)
  assert.equal(leaves.get(id), 3, "same turn continues through another tool step after compaction")
  const history = await test.client.session.context({ sessionID: id })
  assert.equal(history.filter((message) => message.type === "user").length, 1, "no fabricated continuation prompt")
  assert.equal(history.filter((message) => message.type === "idle").length, 1, "same uninterrupted execution")
  const firstAssistant = history.find((message) => message.type === "assistant")!
  assert.equal(firstAssistant.type, "assistant")
  const sourceTool = firstAssistant.content.find((part) => part.type === "tool")!
  const requests = test.calls.filter((call) => call.scope.sessionID === id).map((call) => call.wire)
  const continued = requests[1]
  assert.match(JSON.stringify(continued), /Context manager compact summary/)
  assert.ok(!JSON.stringify(continued).includes("Earlier detailed findings"))
  assert.match(JSON.stringify(continued), /HEAD_FIXTURE[\s\S]*TAIL_FIXTURE/)
  assert.ok(JSON.stringify(continued).includes(sourceTool.id), "retained tool call and result share original ID")
  const outputs = continued.messages.filter((message) => message.role === "tool")
  assert.equal(outputs.length, 1)
  assert.equal(sourceTool.state.status, "completed")
  assert.equal(outputs[0].content, sourceTool.state.content.map((part) => part.type === "text" ? part.text : "").join("\n"))
  assert.ok(!manual.includes(id))
  assert.equal((await test.client.session.list({ parentID: id })).data.filter((child) => child.metadata?.context_manager_job).length, 0)
  return cm
}
try {
  await test.until(async () => (await test.client.plugin.list({ location: { directory: test.project } })).data.some((plugin) => plugin.id === "context-manager" && plugin.state.status === "active"), "activation")
  const primary = await make()
  assert.equal((await (await controller(primary)).load()).auto?.strategy, "AUTO_PER_TURN")
  await test.client.session.switchModel({ sessionID: primary, model: { providerID: "fixture", id: "small" } })
  await send(primary, text)
  await verifyLeaf(primary)
  checks.push("default AUTO_PER_TURN last resort in one active turn; exact exempt tool tail; later tool continuation")

  for (const scenario of [{ background: false, nested: false }, { background: true, nested: false }, { background: false, nested: true }, { background: true, nested: true }]) {
    const parent = await make()
    await send(parent, "PARENT_ONLY EXERCISE_TOOL")
    const cm = await controller(parent)
    await cm.prune((await cm.load()).blocks[0].sourceIDs, { reasoning: true })
    await cm.host.auto!.command(parent, { action: "strategy", strategy: "MANUAL" })
    const policy = structuredClone((await cm.load()).policy)
    launches.set(parent, { ...scenario, started: false })
    await send(parent, "LAUNCH_DELEGATION")
    const child = await test.until(async () => (await test.client.session.list({ parentID: parent })).data.find((item) => !item.metadata?.context_manager_job), "child created")
    const leaf = scenario.nested ? await test.until(async () => (await test.client.session.list({ parentID: child.id })).data.find((item) => !item.metadata?.context_manager_job), "nested child created") : child
    await verifyLeaf(leaf.id)
    await test.client.session.wait({ sessionID: child.id }, { signal: AbortSignal.timeout(60000) })
    assert.equal((await test.client.session.get({ sessionID: child.id })).outcome, "succeeded")
    assert.equal((await test.client.session.get({ sessionID: parent })).outcome, "succeeded")
    assert.deepEqual((await cm.load()).policy, policy)
    assert.equal((await test.client.session.get({ sessionID: leaf.id })).metadata?.unrelated, "parent-value")
    const leafCM = await controller(leaf.id)
    assert.equal((await leafCM.host.auto!.command(leaf.id, { action: "strategy", strategy: "MANUAL" })).strategy, "AUTO_PER_TURN")
    checks.push(`${scenario.background ? "background" : "foreground"} ${scenario.nested ? "nested" : "direct"} built-in subagent: inherited ledger isolated, parent MANUAL overridden, active-prefix recovery without manual input`)
  }

  const queued = await make()
  await test.client.session.switchModel({ sessionID: queued, model: { providerID: "fixture", id: "small" } })
  const barrier = test.parallel(1000)
  await test.client.session.prompt({ sessionID: queued, text })
  await test.until(() => barrier.count() === 1, "last-resort helper held for steering")
  await test.client.session.prompt({ sessionID: queued, text: "STEER_LAST_RESORT", delivery: "steer" })
  await test.client.session.prompt({ sessionID: queued, text: "QUEUE_LAST_RESORT", delivery: "queue" })
  barrier.release()
  await test.client.session.wait({ sessionID: queued }, { signal: AbortSignal.timeout(60000) })
  assert.equal((await test.client.session.get({ sessionID: queued })).outcome, "succeeded")
  const queuedHistory = await test.client.session.context({ sessionID: queued })
  for (const value of [text, "STEER_LAST_RESORT", "QUEUE_LAST_RESORT"]) assert.equal(queuedHistory.filter((message) => message.type === "user" && message.text === value).length, 1)
  assert.ok(!manual.includes(queued))
  checks.push("steered and queued prompts during last-resort summarization delivered exactly once")

  const failed = await make()
  failedHelpers.add(failed)
  await test.client.session.switchModel({ sessionID: failed, model: { providerID: "fixture", id: "small" } })
  await send(failed, text)
  assert.equal((await test.client.session.get({ sessionID: failed })).outcome, "failed")
  assert.equal((await (await controller(failed)).load()).policy.cursor, 0)
  assert.equal((await (await controller(failed)).load()).auto?.pause, undefined)
  assert.equal(leaves.get(failed), 1, "no oversized continuation on summary failure")
  assert.equal((await test.client.session.list({ parentID: failed })).data.length, 0)
  assert.ok(!manual.includes(failed))
  checks.push("failed last-resort summary ends execution without manual gate, partial write or oversized dispatch")

  const stopped = await make()
  launches.set(stopped, { background: false, nested: true, started: false })
  const held = test.parallel(1000)
  await test.client.session.prompt({ sessionID: stopped, text: "LAUNCH_STOPPED_TREE" })
  await test.until(() => held.count() === 1, "nested child last-resort helper held")
  const child = (await test.client.session.list({ parentID: stopped })).data[0]
  const leaf = (await test.client.session.list({ parentID: child.id })).data.find((item) => !item.metadata?.context_manager_job)!
  await test.client.session.interrupt({ sessionID: stopped, resume: false })
  held.release()
  await test.client.session.wait({ sessionID: stopped }, { signal: AbortSignal.timeout(60000) })
  await test.client.session.wait({ sessionID: leaf.id }, { signal: AbortSignal.timeout(60000) })
  const stoppedCM = await controller(leaf.id)
  assert.equal((await stoppedCM.load()).policy.cursor, 0)
  assert.equal((await stoppedCM.load()).auto?.pause, undefined)
  assert.equal(leaves.get(leaf.id), 1)
  await test.until(async () => !(await test.client.session.list({ parentID: leaf.id })).data.length, "cancelled nested helper cleanup")
  checks.push("Stop foreground ancestor cancels nested last-resort work with no late checkpoint or continuation")

  const oversized = await make()
  await test.client.session.switchModel({ sessionID: oversized, model: { providerID: "fixture", id: "small" } })
  const count = test.calls.length
  await send(oversized, "OVERSIZED_SINGLE_MESSAGE ".repeat(6000))
  assert.equal((await test.client.session.get({ sessionID: oversized })).outcome, "failed")
  assert.equal(test.calls.slice(count).filter((call) => call.scope.sessionID === oversized).length, 0)
  assert.equal((await (await controller(oversized)).load()).auto?.pause, undefined)
  checks.push("indivisible oversized exempt tail fails without manual interaction or provider dispatch")

  const configuration = JSON.parse(JSON.stringify(test.config))
  configuration.plugins[1].options.autocompaction.lastResortKeepTokens = 20000
  configuration.plugins[1].options.summarizer.modelID = "small"
  await writeFile(test.configPath, JSON.stringify(configuration))
  await test.until(async () => { try { return (await (await controller(primary)).load()).models.length && (await remoteHost(test.client, primary).load()).settings.autocompaction.lastResortKeepTokens === 20000 } catch { return false } }, "default-sized tail configuration reload")
  const large = await make()
  largeLeaves.add(large)
  await send(large, "LEAF_TASK LARGE ROOT_FACT\n" + "Earlier detailed findings and useful facts. ".repeat(4000))
  assert.equal((await test.client.session.get({ sessionID: large })).outcome, "succeeded")
  const largeCM = await controller(large)
  assert.ok((await largeCM.load()).policy.operations.some((op) => op.checkpoint))
  const largeRequests = test.calls.filter((call) => call.scope.sessionID === large).map((call) => call.wire)
  const tail = largeRequests.find((wire) => JSON.stringify(wire).includes("Context manager compact summary"))!.messages.filter((message) => message.role === "tool")
  assert.ok(tail.reduce((sum, message) => sum + tokenCount(String(message.content)), 0) >= 20000)
  const chunks = test.calls.filter((call) => call.scope.parentID === large && helper(call.wire.messages))
  assert.ok(chunks.length > 1 && chunks.every((call) => call.wire.model === "small"))
  assert.equal((await test.client.session.list({ parentID: large })).data.length, 0)
  checks.push("20000-token exempt tail on the wire with bounded multi-chunk summaries through a smaller helper model")

  const before = (await controller(primary)).load()
  const saved = (await before).policy
  watch.abort()
  await events
  await test.restart()
  const restarted = await controller(primary)
  assert.deepEqual((await restarted.load()).policy, saved)
  await send(primary, "Continue after restarting with a persisted partial-turn checkpoint")
  assert.equal((await test.client.session.get({ sessionID: primary })).outcome, "succeeded")
  checks.push("active-prefix checkpoint survives private server restart and next user turn")
  assert.equal(streamFailure, undefined)
  passed = true
} finally {
  watch.abort()
  await events
  for (const sessionID of roots) await test.client.session.remove({ sessionID }).catch(() => {})
  await test.close({ passed, checks, manual })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
