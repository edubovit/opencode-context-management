import { applySummary } from "../test/fixtures.ts"
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import path from "node:path"
import { fixture } from "./host-fixture.ts"
import { terminal } from "./terminal.ts"
import { Controller } from "../src/controller.ts"
import { remoteHost } from "../src/control.ts"
import { KEY, VERSION, settings } from "../src/config.ts"
import { emptyPolicy, hash, type Block } from "../src/context.ts"
import { contentTokens } from "../src/metrics.ts"
import { tokenCount } from "../src/tokens.ts"
import { ContextManager } from "../src/rpc.ts"

const test = await fixture(process.argv[2], undefined, { keep: 0 })
const sessions = new Set<string>()
const checks: string[] = []
const observations: Record<string, unknown>[] = []
const location = { directory: test.project }
let passed = false
let summaryText: string | undefined
let enforceCapacity = false
const native = (sessionID: string) => test.client.session.context({ sessionID })
const info = (sessionID: string) => test.client.session.get({ sessionID })
const requests = (id: string) => test.calls.filter((call) => call.scope.sessionID === id)
const controller = async (id: string) => {
  const remote = remoteHost(test.client, id)
  const loaded = await remote.load()
  assert.equal(loaded.version, VERSION)
  return new Controller(remote.host, id, settings(loaded.settings), remote.artifacts)
}
const make = async (title: string) => {
  const session = await test.client.session.create({ location, title, model: { providerID: "fixture", id: "fixture" }, metadata: { unrelated: "KEEP" } })
  sessions.add(session.id)
  const value = await controller(session.id)
  await value.host.auto!.command(session.id, { action: "strategy", strategy: "MANUAL" })
  return value
}
const send = async (id: string, text: string) => {
  await test.client.session.prompt({ sessionID: id, text })
  await test.client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(120000) })
  assert.equal((await info(id)).outcome, "succeeded")
}
const seed = async (title: string, tool = false) => {
  const value = await make(title)
  for (const text of [`${title}_FIRST ${tool ? "EXERCISE_TOOL" : ""}`, `${title}_SECOND`, `${title}_THIRD`]) await send(value.sessionID, text)
  return value
}
const summarize = async (value: Controller, start: number, length = 1, mode: "compact" | "brief" = "compact", isolation: "off" | "head" | "total" = "off") => {
  const loaded = await value.load()
  const draft = await value.summarize(mode, loaded.blocks.slice(start, start + length).flatMap((block) => block.sourceIDs), undefined, undefined, isolation)
  await applySummary(value, draft)
}
const meaning = (blocks: Block[]) => blocks.map((block) => ({ kind: block.kind, messages: block.messages.map((message) => ({ role: message.info.role, parts: JSON.parse(JSON.stringify(message.parts, (key, value) => ["id", "sessionID", "messageID", "operationID"].includes(key) ? undefined : value)) })) }))
const retained = (blocks: Block[], ids: Set<string>): Block[] => blocks.flatMap((block) => {
  const sourceIDs = block.sourceIDs.filter((id) => ids.has(id))
  if (!sourceIDs.length) return []
  if (sourceIDs.length === block.sourceIDs.length) return [block]
  return block.kind === "turn" ? [{ ...block, sourceIDs, messages: block.messages.filter((message) => ids.has(message.info.id)) }] : retained(block.previous!, ids)
})

async function verifyFork(parentID: string, label: string, before?: string) {
  const parent = await controller(parentID)
  const loaded = await parent.load()
  const originalInfo = await info(parentID)
  const source = await native(parentID)
  const fingerprint = hash({ originalInfo, source })
  const copied = before ? source.slice(0, source.findIndex((message) => message.id === before)) : source
  const expected = retained(loaded.blocks, new Set(copied.map((message) => message.id)))
  const start = performance.now()
  const fork = await test.client.session.fork({ sessionID: parentID, ...(before ? { before } : {}) })
  sessions.add(fork.id)
  const child = await controller(fork.id)
  const childView = await child.load()
  const forkMs = Math.round(performance.now() - start)
  assert.equal(childView.policy.sessionID, fork.id)
  assert.equal(childView.session.metadata?.unrelated, "KEEP")
  assert.deepEqual(meaning(childView.blocks), meaning(expected))
  const childNative = await native(fork.id)
  assert.deepEqual(childNative.map(({ id: _id, ...message }) => message), copied.map(({ id: _id, ...message }) => message))
  assert.ok(childNative.every((message) => !source.some((old) => old.id === message.id)))
  await send(fork.id, "FORK_CONTINUATION_PROBE")
  assert.ok(requests(fork.id).length > 0)
  assert.equal(hash({ originalInfo: await info(parentID), source: await native(parentID) }), fingerprint)
  observations.push({ label, forkMs, rawMessages: copied.length, effectiveTokens: contentTokens(childView.blocks.flatMap((block) => block.messages)), operations: childView.policy.operations.length, outcome: "succeeded" })
  console.log(JSON.stringify(observations.at(-1)))
  return fork.id
}

try {
  await test.until(async () => (await test.client.plugin.list({ location })).data.some((plugin) => plugin.id === "context-manager" && plugin.state.status === "active"), "plugin activation")
  test.respond((wire) => {
    if (!JSON.stringify(wire.messages).includes("<selected_range_")) return undefined
    if (enforceCapacity && tokenCount(JSON.stringify(wire.messages)) > 922000) return { error: { status: 400, code: "context_length_exceeded", message: "Synthetic helper input exceeds capacity" } }
    return summaryText
  })
  const plain = await seed("PLAIN")
  await verifyFork(plain.sessionID, "plain/full")
  const plainUsers = (await native(plain.sessionID)).filter((message) => message.type === "user")
  await verifyFork(plain.sessionID, "plain/partial", plainUsers[1].id)
  await test.client.session.update({ sessionID: plain.sessionID, metadata: { ...(await info(plain.sessionID)).metadata, [KEY]: emptyPolicy(plain.sessionID) } })
  await verifyFork(plain.sessionID, "empty-ledger/full")

  const compact = await seed("COMPACT")
  const users = (await native(compact.sessionID)).filter((message) => message.type === "user")
  await summarize(compact, 0, 2)
  const full = await verifyFork(compact.sessionID, "compact/full")
  await verifyFork(compact.sessionID, "compact/inside-summary", users[1].id)
  await verifyFork(compact.sessionID, "compact/after-summary", users[2].id)
  await verifyFork(compact.sessionID, "compact/empty", users[0].id)
  await verifyFork(full, "fork-of-fork/full")
  checks.push("full/partial/empty forks preserve eligible layers and native cutoffs; nested forks continue independently")

  const nested = await seed("NESTED", true)
  await nested.prune((await nested.load()).blocks[0].sourceIDs, { reasoning: true, tools: "all" })
  await summarize(nested, 0)
  await summarize(nested, 1, 1, "brief")
  await summarize(nested, 0, 2, "brief")
  await nested.editSummary(await nested.summary((await nested.load()).blocks[0].summaryID!), "REVISED_OUTER")
  await nested.deleteRanges([(await nested.load()).blocks[1].sourceIDs])
  const restoredFork = await verifyFork(nested.sessionID, "nested-revised-pruned-deleted/full")
  const independent = await controller(restoredFork)
  const parentHash = hash({ info: await info(nested.sessionID), native: await native(nested.sessionID) })
  for (let layer = 0; layer < 4; layer++) {
    const loaded = await independent.load()
    const ranges = loaded.blocks.filter((block) => block.summaryID || block.deletionID || block.pruning?.length).map((block) => block.sourceIDs)
    if (!ranges.length) break
    const preview = await independent.prepareRestore(ranges)
    await independent.applyOperations(preview.operations, preview)
  }
  await send(restoredFork, "RESTORED_FORK_REQUEST")
  const restoredWire = JSON.stringify(requests(restoredFork).at(-1)!.wire.messages)
  for (const marker of ["HEAD_FIXTURE", "REASONING_FIXTURE", "NESTED_FIRST", "NESTED_SECOND", "NESTED_THIRD"]) assert.ok(restoredWire.includes(marker), marker)
  assert.equal(hash({ info: await info(nested.sessionID), native: await native(nested.sessionID) }), parentHash)
  checks.push("fork expansion independently restores nested revisions, deleted ranges and prior pruning on the next request")

  for (const strategy of ["AUTO_PER_TURN", "AUTO_SESSION"] as const) {
    const parent = await make(strategy)
    await send(parent.sessionID, "AUTO_OLDER " + " fact".repeat(10000))
    await parent.host.auto!.command(parent.sessionID, { action: "strategy", strategy })
    await test.client.session.switchModel({ sessionID: parent.sessionID, model: { providerID: "fixture", id: "small" } })
    await send(parent.sessionID, "AUTO_CURRENT")
    await verifyFork(parent.sessionID, strategy)
  }
  const checkpoint = await make("CHECKPOINT")
  await checkpoint.host.auto!.command(checkpoint.sessionID, { action: "strategy", strategy: "AUTO_PER_TURN" })
  await test.client.session.switchModel({ sessionID: checkpoint.sessionID, model: { providerID: "fixture", id: "small" } })
  await send(checkpoint.sessionID, "CHECKPOINT_SOURCE " + " fact".repeat(15000))
  assert.ok((await checkpoint.load()).policy.operations.some((op) => op.checkpoint))
  await verifyFork(checkpoint.sessionID, "last-resort-checkpoint")
  checks.push("forks preserve automatic and last-resort checkpoint reductions")

  for (const mode of ["compact", "brief"] as const) for (const isolation of ["head", "total"] as const) {
    const isolated = await seed(`ISOLATION_${mode}_${isolation}`)
    const beforeCalls = test.calls.length
    await summarize(isolated, 1, 1, mode, isolation)
    const helper = test.calls.slice(beforeCalls).filter((call) => call.scope.parentID === isolated.sessionID)
    assert.ok(helper.length)
    const first = JSON.stringify(helper[0].wire.messages)
    assert.ok(first.includes(`ISOLATION_${mode}_${isolation}_SECOND`))
    assert.equal(first.includes(`ISOLATION_${mode}_${isolation}_FIRST`), isolation === "head")
    assert.ok(!first.includes(`ISOLATION_${mode}_${isolation}_THIRD`))
    for (const call of helper) assert.ok(!JSON.stringify(call.wire.messages).includes("<runtime_background_"))
  }
  checks.push("both isolated options with both summary modes send exactly the selected history scope through the real helper")

  await test.restart()
  await send(full, "FORK_AFTER_RESTART")
  await send(compact.sessionID, "PARENT_AFTER_RESTART")
  await test.client.session.remove({ sessionID: compact.sessionID })
  await send(full, "FORK_AFTER_PARENT_DELETION")
  const afterRemoval = await controller(full)
  await afterRemoval.restoreRanges([(await afterRemoval.load()).blocks[0].sourceIDs])
  await send(full, "RESTORE_WITHOUT_PARENT")
  checks.push("forks survive restart and parent deletion; inherited summaries still expand without reading the parent")

  if (process.argv.includes("--tui")) {
    const parent = await seed("FORK_UI")
    await summarize(parent, 0)
    const existing = new Set((await test.client.session.list()).data.map((session) => session.id))
    const tui = terminal({ executable: process.argv[2], url: test.url, project: test.project, sessionID: parent.sessionID, env: test.env, output: path.join(test.root, "fork-tui.log") })
    const seen = (pattern: RegExp) => test.until(async () => pattern.test((await tui.text()).replace(/\s+/g, " ")), `fork UI ${pattern}`)
    try {
      await seen(/FORK_UI/)
      tui.keys("/fork")
      await seen(/\/fork\s+Fork session/)
      tui.keys("\r")
      await seen(/Full session/)
      tui.keys("\r")
      await seen(/Forked session/)
      const fork = await test.until(async () => (await test.client.session.list()).data.find((session) => !existing.has(session.id) && session.fork?.sessionID === parent.sessionID), "UI fork")
      sessions.add(fork.id)
      tui.keys("/context-manager")
      await seen(/\/context-manager\s+Context manager/)
      tui.keys("\r")
      await seen(/Ready\./)
      await seen(/SUMMARY/)
      tui.keys("  ")
      tui.keys("\x05")
      await test.until(async () => (await (await controller(fork.id)).load()).blocks[0].kind === "turn", "UI fork expansion")
      assert.equal((await parent.load()).blocks[0].kind, "compact")
      await seen(/Selected context layers restored/)
      tui.keys("\x1b")
      await test.until(async () => !(await tui.text()).includes("Local text"), "leave fork inspector")
      checks.push("real ConPTY /fork, inspector and Ctrl+E restore work independently of the original session")
    } finally { assert.equal(await tui.close(), 0) }
  }

  if (!process.argv.includes("--small")) {
    test.config.providers.fixture.models.fixture.limit = { context: 1050000, input: 922000, output: 128000 }
    const configured = test.config.plugins.find((entry) => typeof entry === "object")!
    if (typeof configured === "string") throw new Error("Missing options")
    configured.options.autocompaction.headroom = 20000
    await writeFile(test.configPath, JSON.stringify(test.config))
    await test.until(async () => (await test.client.model.list({ location })).data.some((model) => model.id === "fixture" && model.limit.input === 922000), "large capacity")
    const large = await make("LARGE_2M_500K")
    await test.until(async () => (await test.client.rpc(ContextManager).inspect({ sessionID: large.sessionID }, { location })).settings.autocompaction.headroom === 20000, "headroom reload")
    const rawText = " datum".repeat(250000)
    const summaryBody = " retained".repeat(62500)
    for (let n = 0; n < 8; n++) {
      await send(large.sessionID, `RAW_ONLY_${n}${rawText}`)
      summaryText = `SUMMARY_KEEP_${n}${summaryBody}`
      await summarize(large, n)
    }
    await send(large.sessionID, "LARGE_PARENT_CONTINUES")
    const original = await large.load()
    const rawTokens = contentTokens(original.raw)
    const effectiveTokens = contentTokens(original.blocks.flatMap((block) => block.messages))
    assert.ok(rawTokens > 2000000 && effectiveTokens >= 500000 && effectiveTokens < 505000)
    const forkID = await verifyFork(large.sessionID, "2M-to-500k/full")
    const child = await controller(forkID)
    const parentBefore = hash({ info: await info(large.sessionID), native: await native(large.sessionID) })
    const view = await child.load()
    const preview = await child.prepareRestore(view.blocks.filter((block) => block.summaryID).map((block) => block.sourceIDs))
    await child.applyOperations(preview.operations, preview)
    const expanded = await child.load()
    assert.ok(contentTokens(expanded.blocks.flatMap((block) => block.messages)) > 2000000)
    enforceCapacity = true
    await assert.rejects(child.summarize("brief", expanded.blocks[0].sourceIDs), /capacity|context_length/)
    for (let n = 0; n < 8; n++) {
      const beforeCalls = test.calls.length
      summaryText = `FORK_SUMMARY_${n}${summaryBody}`
      await summarize(child, n, 1, "compact", n === 1 ? "head" : "total")
      const call = test.calls.slice(beforeCalls).find((call) => call.scope.parentID === forkID)!
      const text = JSON.stringify(call.wire.messages)
      assert.ok(text.includes(`RAW_ONLY_${n}`))
      for (let other = n + 1; other < 8; other++) assert.ok(!text.includes(`RAW_ONLY_${other}`))
      assert.ok(!text.includes("<runtime_background_"))
      assert.ok(tokenCount(text) < 922000)
    }
    summaryText = undefined
    await send(forkID, "LARGE_FORK_RECOMPRESSED")
    assert.equal(hash({ info: await info(large.sessionID), native: await native(large.sessionID) }), parentBefore)
    const forkTokens = contentTokens((await child.load()).blocks.flatMap((block) => block.messages))
    assert.ok(forkTokens < 505000)
    await test.restart()
    await send(forkID, "LARGE_FORK_AFTER_RESTART")
    await send(large.sessionID, "LARGE_PARENT_AFTER_RESTART")
    observations.push({ label: "large-roundtrip", rawTokens, effectiveTokens, recompressedForkTokens: forkTokens, defaultHelperRejected: true, isolatedHelpersFit: true })
    checks.push("2M raw/500k effective fork continues, independently expands to 2M, and recompresses through isolated helpers when a full-context helper is rejected; restart preserves both sessions")
  }
  passed = true
} finally {
  for (const id of [...sessions].reverse()) await test.client.session.remove({ sessionID: id }).catch(() => {})
  await test.close({ passed, pluginVersion: VERSION, checks, observations })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length, observations }))
}
