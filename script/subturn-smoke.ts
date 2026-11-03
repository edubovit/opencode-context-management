import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { inputBudget } from "../src/auto-state.ts"
import { KEY, settings } from "../src/config.ts"
import { historyHash, type Block } from "../src/context.ts"
import { remoteHost } from "../src/control.ts"
import { Controller } from "../src/controller.ts"
import { contentTokens } from "../src/metrics.ts"
import { ContextManager } from "../src/rpc.ts"
import { tokenCount, type TokenBasis } from "../src/tokens.ts"
import { fixture, type Wire } from "./host-fixture.ts"

const args = process.argv.slice(2)
assert.ok(args.every(arg => !arg.startsWith("--") || arg === "--tui"), "Only --tui is supported")
const positional = args.filter(arg => arg !== "--tui")
assert.ok(positional.length <= 2, "Supply an executable, optional destination and optional --tui")
const [executable, destination] = positional
assert.ok(executable && path.isAbsolute(executable), "Pass the absolute path to the OpenCode executable")
const terminalChecks = args.includes("--tui") ? await import("./subturn-tui.ts") : undefined

const test = await fixture(executable, destination)
const checks: string[] = []
const evidence: Record<string, unknown>[] = []
const sessions = new Set<string>()
const connections = new Set<Awaited<ReturnType<typeof connect>>>()
const gates: { sessionID: string; pauseID: string; fallback: boolean }[] = []
let barrier: ReturnType<typeof test.parallel> | undefined
let passed = false
let failure: string | undefined

function padded(marker: string, target: number, basis: TokenBasis) {
  const text = marker + " x".repeat(target - tokenCount(marker, basis.encoding, basis.library))
  assert.equal(tokenCount(text, basis.encoding, basis.library), target)
  return text
}

async function active() {
  await test.until(async () => (await test.client.plugin.list({ location: { directory: test.project } })).data.some(plugin => plugin.id === "context-manager" && plugin.state.status === "active"), "context-manager activation")
}

async function connect(sessionID: string) {
  const remote = remoteHost(test.client, sessionID)
  const initial = await remote.load()
  const controller = new Controller(remote.host, sessionID, settings(initial.settings), remote.artifacts)
  return { remote, controller }
}

async function inspect(sessionID: string) {
  const connection = await connect(sessionID)
  connections.add(connection)
  return connection
}

async function disconnect(connection: Awaited<ReturnType<typeof connect>>) {
  await connection.controller.dispose()
  await connection.remote.close()
  connections.delete(connection)
}

async function create(title: string) {
  const session = await test.client.session.create({ location: { directory: test.project }, title, model: { providerID: "fixture", id: "fixture" } })
  sessions.add(session.id)
  return session
}

async function wait(sessionID: string) {
  await test.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(90000) })
  assert.equal((await test.client.session.get({ sessionID })).outcome, "succeeded")
}

function selectedRange(wire: Wire) {
  const match = JSON.stringify(wire.messages).match(/<selected_range_([^>]+)>([\s\S]*?)<\/selected_range_\1>/)
  assert.ok(match, "Helper must receive an explicitly delimited selected range")
  return { id: match[1], text: match[2] }
}

function sourceTools(messages: readonly SessionMessageInfo[]) {
  return messages.flatMap(message => message.type === "assistant" ? message.content.flatMap(part => part.type === "tool" ? [part] : []) : [])
}

function assertToolPairs(wire: Wire, messages: readonly SessionMessageInfo[], excluded: ReadonlySet<string> = new Set()) {
  const expected = sourceTools(messages.filter(message => !excluded.has(message.id)))
  const calls = wire.messages.flatMap(message => (message.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[])
  const results = wire.messages.filter(message => message.role === "tool") as (Wire["messages"][number] & { tool_call_id: string })[]
  assert.equal(calls.length, expected.length, "No tool call may be duplicated, dropped or fabricated")
  assert.equal(results.length, expected.length, "Every retained tool call needs exactly one retained result")
  for (const tool of expected) {
    assert.equal(tool.state.status, "completed")
    if (tool.state.status !== "completed") throw new Error("Fixture tools must be settled")
    const matching = calls.filter(call => call.id === tool.id)
    const matchingResults = results.filter(result => result.tool_call_id === tool.id)
    assert.equal(matching.length, 1)
    assert.equal(matchingResults.length, 1)
    assert.equal(matching[0].function.name, tool.name)
    assert.deepEqual(JSON.parse(matching[0].function.arguments), tool.state.input)
    assert.equal(matchingResults[0].content, tool.state.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n"))
  }
  const removed = sourceTools(messages.filter(message => excluded.has(message.id)))
  for (const tool of removed) {
    assert.ok(!calls.some(call => call.id === tool.id))
    assert.ok(!results.some(result => result.tool_call_id === tool.id))
  }
}

function assertGrouping(blocks: Block[], original: Block, minimum: number, basis: TokenBasis) {
  assert.ok(blocks.length > 1)
  assert.deepEqual(blocks.flatMap(block => block.sourceIDs), original.sourceIDs)
  assert.equal(historyHash(blocks.flatMap(block => block.messages)), historyHash(original.messages), "Grouping must not alter effective content")
  for (const block of blocks) {
    assert.equal(block.kind, "turn")
    assert.equal(block.subturn?.originID, original.sourceIDs[0])
    assert.ok(contentTokens(block.messages, basis) >= minimum, "Every subturn must meet the configured minimum")
  }
  for (const message of original.messages) {
    const owners = blocks.filter(block => block.sourceIDs.includes(message.info.id))
    assert.equal(owners.length, 1, "A native assistant batch is indivisible")
    assert.deepEqual(owners[0].messages.find(item => item.info.id === message.info.id), message)
  }
}

function importedTurn(session: SessionInfo, basis: TokenBasis): SessionMessageInfo[] {
  const id = () => `msg_${randomUUID().replaceAll("-", "")}`
  const now = Date.now() - 1000
  const messages: SessionMessageInfo[] = [{ id: id(), type: "user", text: padded("SUBTURN_MANUAL_USER", 12000, basis), time: { created: now } }]
  for (let batch = 1; batch <= 5; batch++) {
    const created = now + batch * 10
    messages.push({
      id: id(), type: "assistant", agent: "build", model: session.model!, finish: "tool-calls", time: { created, completed: created + 1 },
      content: [1, 2].map(index => ({
        type: "tool", id: `call_manual_${batch}_${index}`, name: "subturn_fixture", time: { created, completed: created + 1 },
        state: { status: "completed", input: { marker: `SUBTURN_MANUAL_INPUT_${batch}_${index}`, padding: 6000 }, content: [{ type: "text", text: padded(`SUBTURN_MANUAL_OUTPUT_${batch}_${index}`, 6000, basis) }], metadata: {} },
      })),
    })
  }
  messages.push({ id: id(), type: "assistant", agent: "build", model: session.model!, finish: "stop", time: { created: now + 70, completed: now + 71 }, content: [{ type: "text", text: "SUBTURN_MANUAL_ORIGINAL_FINAL" }] })
  messages.push({ id: id(), type: "idle", outcome: "succeeded", time: { created: now + 72 } })
  return messages
}

async function manual() {
  const empty = await create("Manual subturn grouping")
  const initial = await inspect(empty.id)
  const basis = (await initial.controller.load()).tokenizer
  const messages = importedTurn(empty, basis)
  await disconnect(initial)
  await test.client.session.remove({ sessionID: empty.id })
  sessions.delete(empty.id)
  const session = await test.client.session.import({ info: empty, messages, location: { directory: test.project } })
  sessions.add(session.id)
  let connection = await inspect(session.id)
  let controller = connection.controller
  await controller.host.auto!.command(session.id, { action: "strategy", strategy: "MANUAL" })
  const before = await controller.load()
  const raw = await test.client.session.context({ sessionID: session.id })
  assert.equal(raw.filter(message => message.type === "user").length, 1)
  assert.equal(before.blocks.length, 1)
  assert.equal(before.blocks[0].closed, true)
  assert.ok(contentTokens(before.blocks[0].messages, basis) > controller.config.subturns.minSplitTokens)
  const mainCalls = () => test.calls.filter(call => call.scope.sessionID === session.id)
  const helpers = () => test.calls.filter(call => call.scope.parentID === session.id)
  const summary = "SUBTURN_MANUAL_SELECTED_SUMMARY: Only the selected first subturn was summarized."
  test.respond((_wire, scope) => scope.parentID === session.id ? summary : scope.sessionID === session.id ? "SUBTURN_MANUAL_PROBE_REPLY" : undefined)
  test.usage(() => ({ input: 1000, output: 20 }))
  const probe = async () => {
    const start = mainCalls().length
    await test.client.session.generate({ sessionID: session.id, prompt: "SUBTURN_MANUAL_WIRE_PROBE" }, { signal: AbortSignal.timeout(60000) })
    assert.equal(mainCalls().length, start + 1)
    assert.deepEqual(await test.client.session.context({ sessionID: session.id }), raw, "Transient probes cannot change stored history")
    return mainCalls().at(-1)!.wire
  }
  const originalWire = await probe()
  assert.match(JSON.stringify(originalWire.messages), /SUBTURN_MANUAL_USER/)
  assertToolPairs(originalWire, raw)
  if (terminalChecks) {
    const result = await terminalChecks.verifySubturnControls(test, controller, executable, async () => {
      assert.deepEqual((await probe()).messages, originalWire.messages, "Actual terminal grouping must preserve the immediate next wire")
    })
    evidence.push({ scenario: "manual-tui", ...result })
    checks.push("ConPTY: registered command, count entry/cancellation, requested 10 reduced to 5, sibling selection and merge; unchanged ledger on cancel, no grouping model calls, unchanged raw history and immediate wire")
  }
  let callsBeforeGrouping = test.calls.length
  const requested = 10
  const actual = await controller.splitTurn(before.blocks[0].sourceIDs, requested)
  const split = await controller.load()
  assert.ok(actual >= 2 && actual < requested, "An impossible requested count must be reduced, not create undersized pieces")
  assert.equal(split.blocks.length, actual)
  assertGrouping(split.blocks, before.blocks[0], controller.config.subturns.minTokens, basis)
  assert.ok(split.policy.revision > before.policy.revision)
  assert.deepEqual((await test.client.session.get({ sessionID: session.id })).metadata?.[KEY], split.policy, "RPC must persist the split ledger")
  assert.equal(test.calls.length, callsBeforeGrouping, "Splitting must make no model request")
  assert.deepEqual((await probe()).messages, originalWire.messages, "The exact next same-model wire must not change after splitting")
  callsBeforeGrouping = test.calls.length
  await controller.mergeSubturns(split.blocks.flatMap(block => block.sourceIDs))
  const merged = await controller.load()
  assert.equal(merged.blocks.length, 1)
  assert.deepEqual(merged.blocks[0].sourceIDs, before.blocks[0].sourceIDs)
  assert.equal(historyHash(merged.blocks[0].messages), historyHash(before.blocks[0].messages))
  assert.equal(test.calls.length, callsBeforeGrouping, "Merging must make no model request")
  assert.deepEqual((await probe()).messages, originalWire.messages, "The exact next same-model wire must not change after merging")
  callsBeforeGrouping = test.calls.length
  assert.equal(await controller.splitTurn(merged.blocks[0].sourceIDs, 3), 3)
  const regrouped = await controller.load()
  assertGrouping(regrouped.blocks, before.blocks[0], controller.config.subturns.minTokens, basis)
  assert.equal(test.calls.length, callsBeforeGrouping, "Re-splitting must make no model request")
  assert.deepEqual(await test.client.session.context({ sessionID: session.id }), raw)
  assert.deepEqual((await probe()).messages, originalWire.messages, "The exact next same-model wire must not change after re-splitting")
  checks.push("manual: native multi-tool batches stay indivisible; count reduction, merge and re-split persist through real RPC without model calls or history/wire changes")

  const selected = regrouped.blocks[0].sourceIDs
  const draft = await controller.summarize("brief", selected)
  assert.deepEqual(draft.operation.sourceIDs, selected)
  assert.equal(helpers().length, 1)
  const range = selectedRange(helpers()[0].wire)
  for (const id of selected) assert.ok(range.text.includes(id))
  for (const id of regrouped.blocks.slice(1).flatMap(block => block.sourceIDs)) assert.ok(!range.text.includes(id), "Unselected subturn must stay outside the selected range")
  assert.equal(helpers()[0].wire.tools, undefined)
  await controller.applyOperations([draft.operation], draft)
  await controller.discard()
  const summarized = await controller.load()
  assert.equal(summarized.blocks[0].kind, "brief")
  assert.deepEqual(summarized.blocks.slice(1), regrouped.blocks.slice(1))
  const reducedWire = await probe()
  assert.ok(JSON.stringify(reducedWire.messages).includes(summary))
  assertToolPairs(reducedWire, raw, new Set(selected))
  const beforeExpand = test.calls.length
  await controller.restoreRanges([selected])
  const expanded = await controller.load()
  assert.deepEqual(expanded.blocks, regrouped.blocks, "Expanding a summary must retain the saved subturn grouping")
  assert.equal(test.calls.length, beforeExpand)
  assert.deepEqual((await probe()).messages, originalWire.messages, "Expansion must restore the exact next wire, including every tool input/result")
  const savedPolicy = expanded.policy
  await disconnect(connection)
  await test.restart()
  await active()
  connection = await inspect(session.id)
  controller = connection.controller
  const restarted = await controller.load()
  assert.deepEqual(restarted.policy, savedPolicy)
  assert.deepEqual(restarted.blocks, regrouped.blocks)
  assert.deepEqual((await probe()).messages, originalWire.messages)
  assertToolPairs(mainCalls().at(-1)!.wire, raw)
  const start = mainCalls().length
  const admission = await test.client.session.prompt({ sessionID: session.id, text: "SUBTURN_MANUAL_REAL_CONTINUATION" })
  await wait(session.id)
  assert.equal(mainCalls().length, start + 1)
  assertToolPairs(mainCalls().at(-1)!.wire, raw)
  const continued = await test.client.session.context({ sessionID: session.id })
  assert.deepEqual(continued.filter(message => raw.some(prior => prior.id === message.id)), raw)
  assert.deepEqual(continued.filter(message => message.type === "user").map(message => message.id), [raw.find(message => message.type === "user")!.id, admission.id])
  checks.push("manual: first-subturn-only summary, untouched siblings, expansion retaining grouping, exact restored wire, cold restart and genuine same-model continuation")
  evidence.push({ scenario: "manual", requested, actual, tokens: regrouped.blocks.map(block => contentTokens(block.messages, basis)), grouping: regrouped.blocks.map(block => block.sourceIDs), helperRequests: helpers().length, policyVersion: savedPolicy.version })
  await disconnect(connection)
}

async function automatic(name: string, userTokens: number, batches: number, padding: number, fallback = false) {
  const session = await create(`Subturn ${name}`)
  const connection = await inspect(session.id)
  const { controller } = connection
  const initial = await controller.load()
  const config = controller.config
  assert.equal(initial.auto?.strategy, "AUTO_PER_TURN")
  assert.equal(config.subturns.minTokens, 10000)
  assert.equal(config.subturns.minSplitTokens, 50000)
  assert.equal(config.autocompaction.splitThresholdTokens, 100000)
  assert.equal(config.autocompaction.maxSubturnTokens, 50000)
  const model = initial.models.find(model => model.providerID === "fixture" && model.id === "fixture")!
  const { threshold } = inputBudget(model, config.autocompaction.headroom)
  const highInput = threshold - 5000
  const mainCalls = () => test.calls.filter(call => call.scope.sessionID === session.id)
  const helpers = () => test.calls.filter(call => call.scope.parentID === session.id)
  const summary = padded(`SUBTURN_${name}_SUMMARY`, 2500, initial.tokenizer)
  const text = padded(`SUBTURN_${name}_ORIGINAL_USER`, userTokens, initial.tokenizer)
  const warnings: { sessionID: string; pauseID: string; message: string }[] = []
  const stop = new AbortController()
  const off = test.client.rpc(ContextManager).events.on("warning", event => {
    if (event.data.sessionID === session.id) warnings.push(event.data)
  })
  const events = test.client.event.subscribe({ types: ["session.execution.started"], signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]) })[Symbol.asyncIterator]()
  let warningTerminal: Awaited<ReturnType<NonNullable<typeof terminalChecks>["watchFallbackToast"]>> | undefined
  let completed = false
  try {
    const connected = await events.next()
    assert.equal(connected.value?.type, "server.connected", "Warning subscription must be connected before execution")
    await events.return?.()
    if (fallback && terminalChecks) warningTerminal = await terminalChecks.watchFallbackToast(test, controller, executable)
    test.respond((_wire, scope) => {
      if (scope.parentID === session.id) return summary
      if (scope.sessionID !== session.id) return undefined
      const count = mainCalls().length
      return count <= batches ? { tool: { name: "subturn_fixture", input: { marker: `SUBTURN_${name}_RESULT_${count}`, padding } } } : `SUBTURN_${name}_FINAL`
    })
    test.usage((_wire, scope) => ({ input: scope.sessionID === session.id && mainCalls().length === batches ? highInput : 1000, output: 20 }))
    barrier = test.parallel(2)
    const admission = await test.client.session.prompt({ sessionID: session.id, text })
    await test.until(() => barrier!.count() === 1, `${name}: first summary held`)
    const held = await controller.load()
    const raw = await test.client.session.context({ sessionID: session.id })
    const pause = held.auto?.pause
    assert.equal(pause?.phase, "auto")
    gates.push({ sessionID: session.id, pauseID: pause.id, fallback })
    assert.ok(pause.tokens > pause.threshold && pause.accounting!.local < pause.threshold)
    assert.equal(pause.accounting?.source, "provider-matched")
    assert.equal(pause.accounting?.reported?.input, highInput)
    assert.equal(mainCalls().length, batches, "The pending continuation must not dispatch while its helper is held")
    assert.equal(helpers().length, 1)
    assert.deepEqual(raw.filter(message => message.type === "user").map(message => ({ id: message.id, text: message.text })), [{ id: admission.id, text }])
    assert.equal(raw.filter(message => message.type === "synthetic" || message.type === "idle" || message.type === "compaction").length, 0, "This is one genuinely unfinished user/tool execution, without synthetic admissions")
    assert.equal(sourceTools(raw).length, batches)
    assert.ok(sourceTools(raw).every(tool => tool.state.status === "completed"))
    assert.equal(raw.findLast(message => message.type === "assistant")?.finish, "tool-calls")
    assert.equal(held.policy.operations.filter(op => op.mode === "compact").length, 0)
    const total = held.blocks.reduce((sum, block) => sum + contentTokens(block.messages, initial.tokenizer), 0)
    if (fallback) {
      assert.ok(total < config.autocompaction.splitThresholdTokens)
      assert.equal(held.policy.operations.length, 0)
      await test.until(() => warnings.length === 1, "fallback warning delivered before helper release")
      assert.equal(warnings[0].pauseID, pause.id)
      assert.match(warnings[0].message, /last.resort/i)
      if (warningTerminal) {
        evidence.push({ scenario: "fallback-warning-tui", ...await warningTerminal.verify(pause.id) })
        checks.push("ConPTY: real last-resort warning toast appears while AUTO is held, without leaving the original session or opening the inspector")
      }
    } else {
      assert.ok(total > config.autocompaction.splitThresholdTokens)
      assert.ok(held.policy.operations.length > 0, "Automatic grouping must be committed before summarization")
      assert.deepEqual((await test.client.session.get({ sessionID: session.id })).metadata?.[KEY], held.policy)
      assert.ok(held.blocks.length >= 3)
      assert.ok(held.blocks.every(block => block.subturn?.originID === admission.id))
      assert.ok(held.blocks.every(block => contentTokens(block.messages, initial.tokenizer) >= config.subturns.minTokens && contentTokens(block.messages, initial.tokenizer) <= config.autocompaction.maxSubturnTokens))
      assert.deepEqual(pause.protectedIDs, held.blocks.at(-1)!.sourceIDs, "Only the final subturn stays protected")
      assert.equal(held.blocks.at(-1)!.closed, false)
      assert.equal(warnings.length, 0)
    }
    const selected = fallback ? [admission.id] : held.blocks[0].sourceIDs
    const range = selectedRange(helpers()[0].wire)
    if (fallback) assert.equal(range.id, "last_resort")
    for (const id of selected) assert.ok(range.text.includes(id), `Selected source missing: ${id}`)
    for (const message of raw.filter(message => !selected.includes(message.id))) assert.ok(!range.text.includes(message.id), `Unselected source leaked into summary range: ${message.id}`)
    assert.ok(!selected.some(id => !fallback && pause.protectedIDs?.includes(id)))
    const untouched = held.blocks.slice(1)
    const heldCalls = test.calls.length
    barrier.release()
    barrier = undefined
    await wait(session.id)
    const after = await controller.load()
    assert.equal(after.auto?.pause, undefined)
    const summaries = after.policy.operations.filter(op => op.mode === "compact")
    assert.equal(summaries.length, 1, "Only the earliest eligible subturn/prefix must be summarized")
    assert.deepEqual(summaries[0].sourceIDs, selected)
    assert.equal(summaries[0].summary, summary)
    assert.equal(summaries[0].checkpoint, fallback ? true : undefined)
    assert.equal(after.policy.operations.length, held.policy.operations.length + 1)
    assert.ok(after.runtime!.budget!.tokens <= threshold)
    assert.equal(helpers().length, 1, "The in-band synthetic summary needs no size-review or fallback request")
    assert.equal(test.calls.length, heldCalls + 1, "Exactly the original held continuation resumes after cleanup")
    assert.equal(mainCalls().length, batches + 1)
    const resumed = mainCalls().at(-1)!
    assert.equal(test.calls.at(-1), resumed)
    assert.ok(JSON.stringify(resumed.wire.messages).includes(summary))
    assertToolPairs(resumed.wire, raw, new Set(selected))
    const stored = await test.client.session.context({ sessionID: session.id })
    assert.deepEqual(stored.filter(message => raw.some(prior => prior.id === message.id)), raw, "Automatic maintenance must not rewrite any original user, tool input or result")
    assert.deepEqual(stored.filter(message => message.type === "user").map(message => ({ id: message.id, text: message.text })), [{ id: admission.id, text }])
    assert.equal(stored.filter(message => message.type === "synthetic" || message.type === "compaction").length, 0)
    if (!fallback) {
      for (const block of untouched) {
        const current = after.blocks.find(item => item.sourceIDs.includes(block.sourceIDs[0]))!
        assert.ok(current)
        assert.deepEqual(current.messages.filter(message => block.sourceIDs.includes(message.info.id)), block.messages, "All later subturn content, including the protected tail, stays unchanged")
        assert.equal(current.subturn?.originID, admission.id)
      }
      assert.equal(warnings.length, 0, "Safe splitting must not emit the last-resort warning")
    } else assert.equal(warnings.length, 1, "Real last resort emits exactly one warning for its gate")
    checks.push(`${name}: ${fallback ? "one genuine last-resort warning and checkpoint" : "persisted safe split, first-subturn-only summary and protected last subturn without a last-resort warning"}; one original user/tool loop resumes once, preserving raw history and retained wire pairs`)
    evidence.push({ scenario: name, total, selected, grouping: held.blocks.map(block => ({ ids: block.sourceIDs, tokens: contentTokens(block.messages, initial.tokenizer) })), helperRequests: helpers().length, mainRequests: mainCalls().length, warnings: warnings.length, reportedInput: highInput, forecast: pause.tokens, threshold })
    completed = true
  } finally {
    barrier?.release()
    barrier = undefined
    try {
      off()
      stop.abort()
      await events.return?.()
    } finally { await warningTerminal?.close(completed) }
  }
  await disconnect(connection)
}

try {
  test.config.plugins.push(path.join(test.repo, "test/subturn-fixture"))
  test.config.permissions.push({ action: "subturn_fixture", resource: "*", effect: "allow" })
  await writeFile(test.configPath, JSON.stringify(test.config, null, 2))
  await test.restart()
  await active()
  await test.until(async () => (await test.client.plugin.list({ location: { directory: test.project } })).data.some(plugin => plugin.id === "context-manager-subturn-test-tools" && plugin.state.status === "active"), "synthetic subturn tool activation")
  await manual()
  await automatic("AUTO_SAFE", 18000, 5, 18000)
  await automatic("FALLBACK_WARNING", 65000, 1, 22000, true)
  passed = true
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error)
  throw error
} finally {
  barrier?.release()
  const cleanupErrors: string[] = []
  for (const sessionID of sessions) {
    try {
      await test.client.session.interrupt({ sessionID, resume: false })
      await test.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(10000) })
    } catch (error) { cleanupErrors.push(String(error)) }
  }
  for (const connection of connections) {
    try { await disconnect(connection) } catch (error) { cleanupErrors.push(String(error)) }
  }
  for (const sessionID of sessions) {
    try { await test.client.session.remove({ sessionID }) } catch (error) { cleanupErrors.push(String(error)) }
  }
  passed &&= cleanupErrors.length === 0
  try {
    await test.close({ passed, checks, evidence, failure, cleanupErrors })
    if (passed) {
      const hostLog = await readFile(path.join(test.root, "host.log"), "utf8")
      const warnings = hostLog.split(/\r?\n/).filter(line => line.includes("Context manager last resort:"))
      for (const gate of gates) {
        const entries = warnings.filter(line => line.includes(gate.sessionID) && line.includes(gate.pauseID))
        assert.equal(entries.length, gate.fallback ? 1 : 0, "The persisted host log must contain exactly one warning for a last-resort gate and none for safe splitting")
        for (const entry of entries) assert.match(entry, /\blevel=warn(?:ing)?\b/i, "Last-resort host records must use warning severity")
      }
      assert.equal(warnings.length, gates.filter(gate => gate.fallback).length, "The host log must not duplicate or fabricate last-resort warnings")
      checks.push("host.log after owned-host shutdown: one real last-resort warning for its exact session/gate; no warning for safe splitting")
      evidence.push({ scenario: "host-warning-log", file: "host.log", warnings: warnings.length, gates })
    }
  } catch (error) {
    passed = false
    failure ??= error instanceof Error ? error.stack ?? error.message : String(error)
    throw error
  } finally {
    const resultPath = path.join(test.root, "result.json")
    const result = await readFile(resultPath, "utf8").then(text => JSON.parse(text)).catch(() => undefined)
    if (result) await writeFile(resultPath, JSON.stringify({ ...result, result: { passed, checks, evidence, failure, cleanupErrors } }, null, 2))
    console.log(JSON.stringify({ root: test.root, version: test.hostVersion, passed, checks: checks.length, evidence, failure, cleanupErrors }))
  }
  if (!failure && cleanupErrors.length) throw new Error(`Owned fixture cleanup failed: ${cleanupErrors.join("; ")}`)
}
