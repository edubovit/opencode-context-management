import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { inputBudget } from "../src/auto-state.ts"
import { settings } from "../src/config.ts"
import { remoteHost } from "../src/control.ts"
import { Controller } from "../src/controller.ts"
import { contentTokens } from "../src/metrics.ts"
import { tokenCount, type TokenBasis } from "../src/tokens.ts"
import { fixture, type Wire } from "./host-fixture.ts"

const executable = process.argv[2]
assert.ok(executable && path.isAbsolute(executable), "Pass the absolute path to the OpenCode executable")

const test = await fixture(executable, process.argv[3])
const checks: string[] = []
const evidence: { scenario: string; tokens: number[]; selected: string[]; helperRequests: number; mainRequests: number }[] = []
let passed = false

function padded(marker: string, target: number, basis: TokenBasis) {
  const text = marker + " x".repeat(target - tokenCount(marker, basis.encoding, basis.library))
  assert.equal(tokenCount(text, basis.encoding, basis.library), target, "Synthetic source must have the intended production token count")
  return text
}

function selectedRange(wire: Wire) {
  const match = JSON.stringify(wire.messages).match(/<selected_range_([^>]+)>([\s\S]*?)<\/selected_range_\1>/)
  assert.ok(match, "Automatic helper must receive an explicitly delimited selected range")
  return { id: match[1], text: match[2] }
}

async function scenario(name: string, targets: number[], selectedCount: number, minimum = 10000, fallback = false) {
  const session = await test.client.session.create({ location: { directory: test.project }, title: `Automatic range: ${name}`, model: { providerID: "fixture", id: "fixture" } })
  const remote = remoteHost(test.client, session.id)
  let barrier: ReturnType<typeof test.parallel> | undefined
  try {
    const initial = await remote.load()
    const config = settings(initial.settings)
    assert.equal(config.autocompaction.minRangeTokens, minimum)
    assert.equal(initial.auto.strategy, "AUTO_PER_TURN")
    const controller = new Controller(remote.host, session.id, config, remote.artifacts)
    const empty = await controller.load()
    const basis = empty.tokenizer
    const model = empty.models.find(model => model.providerID === "fixture" && model.id === "fixture")!
    const { threshold } = inputBudget(model, config.autocompaction.headroom)
    const highInput = threshold + 500
    const markers = targets.map((_, index) => `AUTO_RANGE_${name}_SOURCE_${index + 1}`)
    const replies = targets.map((_, index) => `AUTO_RANGE_${name}_REPLY_${index + 1}`)
    const active = `AUTO_RANGE_${name}_ACTIVE_REQUEST`
    const summary = `AUTO_RANGE_${name}_SUMMARY: The selected synthetic turns contained repetitive padding and no additional facts.`
    const admissions: { id: string; text: string }[] = []
    const mainCalls = () => test.calls.filter(call => call.scope.sessionID === session.id)
    const helperCalls = () => test.calls.filter(call => call.scope.parentID === session.id)
    const wait = async () => {
      await test.client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) })
      assert.equal((await test.client.session.get({ sessionID: session.id })).outcome, "succeeded")
    }
    test.respond((wire, scope) => {
      if (scope.parentID === session.id) return summary
      if (scope.sessionID !== session.id) return undefined
      const last = JSON.stringify(wire.messages.findLast(message => message.role === "user"))
      const index = markers.findIndex(marker => last.includes(marker))
      return index < 0 ? `AUTO_RANGE_${name}_FINAL_RESPONSE` : replies[index]
    })
    test.usage((wire, scope) => {
      const last = JSON.stringify(wire.messages.findLast(message => message.role === "user"))
      return { input: scope.sessionID === session.id && last.includes(markers.at(-1)!) ? highInput : 1000, output: 20 }
    })

    for (const [index, target] of targets.entries()) {
      const text = padded(markers[index], target - tokenCount(replies[index], basis.encoding, basis.library), basis)
      const admitted = await test.client.session.prompt({ sessionID: session.id, text })
      admissions.push({ id: admitted.id, text })
      await wait()
      const loaded = await controller.load()
      assert.equal(loaded.policy.operations.length, 0, "Priming must not compact early")
      assert.equal(loaded.auto?.pause, undefined)
      assert.ok(loaded.runtime!.budget!.tokens <= threshold, "Each priming request must dispatch below the context threshold")
      assert.equal(loaded.blocks.length, index + 1)
      assert.ok(loaded.blocks.every(block => block.kind === "turn" && block.closed))
      assert.deepEqual(loaded.blocks.map(block => contentTokens(block.messages, basis)), targets.slice(0, index + 1))
      assert.equal(mainCalls().length, index + 1, "Exactly one provider response must complete each priming turn")
      assert.equal(helperCalls().length, 0)
    }

    const before = await controller.load()
    const rawBefore = await test.client.session.context({ sessionID: session.id })
    const finalPrime = rawBefore.findLast(message => message.type === "assistant")!
    assert.equal(finalPrime.type, "assistant")
    assert.equal(finalPrime.tokens?.input, highInput, "Only the final priming response raises reported usage")
    assert.deepEqual(rawBefore.filter(message => message.type === "assistant").map(message => message.tokens?.input), targets.map((_, index) => index === targets.length - 1 ? highInput : 1000))
    const tokens = before.blocks.map(block => contentTokens(block.messages, basis))
    const selected = before.blocks.slice(0, selectedCount).flatMap(block => block.sourceIDs)
    const untouched = before.blocks.slice(selectedCount).flatMap(block => block.sourceIDs)
    if (fallback) {
      assert.ok(tokens.reduce((sum, count) => sum + count, 0) <= minimum)
      assert.equal(selectedCount, targets.length)
    } else {
      assert.ok(tokens.slice(0, selectedCount - 1).reduce((sum, count) => sum + count, 0) <= minimum)
      assert.ok(tokens.slice(0, selectedCount).reduce((sum, count) => sum + count, 0) > minimum)
    }

    barrier = test.parallel(2)
    const requestStart = test.calls.length
    const admitted = await test.client.session.prompt({ sessionID: session.id, text: active })
    admissions.push({ id: admitted.id, text: active })
    await test.until(() => barrier!.count() === 1, `${name}: first automatic helper held`)
    const held = await controller.load()
    const pause = held.auto?.pause
    assert.equal(pause?.phase, "auto")
    assert.equal(pause.userID, admitted.id)
    assert.ok(pause.protectedIDs?.includes(admitted.id))
    assert.ok(pause.tokens > pause.threshold && pause.accounting!.local < pause.threshold)
    assert.equal(pause.accounting?.source, "provider-matched")
    assert.equal(pause.accounting?.reported?.messageID, finalPrime.id)
    assert.equal(pause.accounting?.reported?.input, highInput)
    if (fallback) assert.match(pause.message, /whole earlier prefix.*one fallback pass/i)
    assert.equal(mainCalls().length, targets.length, "The held request cannot reach the provider before cleanup")
    assert.equal(held.policy.operations.length, 0)
    assert.equal(helperCalls().length, 1)
    const firstHelper = helperCalls()[0]
    const range = selectedRange(firstHelper.wire)
    for (const marker of [...markers.slice(0, selectedCount), ...replies.slice(0, selectedCount), ...selected]) assert.ok(range.text.includes(marker), `Selected range is missing ${marker}`)
    for (const marker of [...markers.slice(selectedCount), ...replies.slice(selectedCount), ...untouched, active, admitted.id]) assert.ok(!range.text.includes(marker), `Selected range must exclude ${marker}`)
    const rawHeld = await test.client.session.context({ sessionID: session.id })
    const activeUser = rawHeld.find(message => message.id === admitted.id)
    assert.ok(activeUser?.type === "user" && activeUser.text === active)
    assert.deepEqual(rawHeld.filter(message => rawBefore.some(prior => prior.id === message.id)), rawBefore)

    barrier.release()
    barrier = undefined
    await wait()
    const after = await controller.load()
    assert.equal(after.auto?.pause, undefined)
    assert.equal(after.policy.operations.length, 1, "A detailed-summary review is not a second applied summary")
    const operation = after.policy.operations[0]
    assert.equal(operation.mode, "compact")
    assert.equal(operation.checkpoint, undefined, "The ordinary range/prefix path must not fall through to last resort")
    assert.deepEqual(operation.sourceIDs, selected)
    assert.equal(operation.beforeTokens, tokens.slice(0, selectedCount).reduce((sum, count) => sum + count, 0))
    assert.deepEqual(operation.tokenizer, basis, "Range sizing must use the consuming/main model basis")
    assert.equal(operation.summary, summary)
    assert.equal(after.blocks.filter(block => block.kind === "compact").length, 1)
    assert.deepEqual(after.blocks.slice(1, 1 + targets.length - selectedCount), before.blocks.slice(selectedCount), "Later effective turns remain untouched")
    assert.ok(after.runtime!.budget!.tokens <= threshold)

    const helpers = helperCalls()
    assert.ok(helpers.length >= 1 && helpers.length <= 2, "Only the initial summary and optional detailed review may call the model")
    assert.equal(new Set(helpers.map(call => call.scope.sessionID)).size, 1)
    for (const helper of helpers) {
      assert.equal(selectedRange(helper.wire).id, range.id, "Review must retain the same source range")
      assert.equal(helper.wire.tools, undefined)
    }
    const resumed = test.calls.slice(requestStart).filter(call => call.scope.sessionID === session.id)
    assert.equal(resumed.length, 1, "The original held request must resume exactly once")
    assert.equal(test.calls.slice(requestStart).length, helpers.length + 1, "No extra provider calls may be fabricated")
    assert.equal(test.calls.at(-1), resumed[0], "The next main request must follow cleanup directly")
    const wire = JSON.stringify(resumed[0].wire.messages)
    assert.ok(wire.includes(summary))
    assert.match(wire, /Context manager compact summary/)
    for (const marker of [...markers.slice(0, selectedCount), ...replies.slice(0, selectedCount)]) assert.ok(!wire.includes(marker), `Compacted raw source leaked: ${marker}`)
    for (const marker of [...markers.slice(selectedCount), ...replies.slice(selectedCount), active]) assert.ok(wire.includes(marker), `Untouched context disappeared: ${marker}`)
    assert.equal(wire.split(active).length - 1, 1)
    assert.ok(JSON.stringify(resumed[0].wire.messages.findLast(message => message.role === "user")).includes(active))
    const rawAfter = await test.client.session.context({ sessionID: session.id })
    assert.deepEqual(rawAfter.filter(message => rawBefore.some(prior => prior.id === message.id)), rawBefore, "Compaction must not rewrite stored history")
    assert.deepEqual(rawAfter.find(message => message.id === admitted.id), activeUser)
    assert.deepEqual(rawAfter.filter(message => message.type === "user").map(message => ({ id: message.id, text: message.text })), admissions, "Resume must not fabricate another user input")
    assert.deepEqual(rawAfter.filter(message => message.type === "synthetic" || message.type === "compaction"), rawBefore.filter(message => message.type === "synthetic" || message.type === "compaction"))
    assert.equal(rawAfter.filter(message => message.type === "assistant").length, targets.length + 1)
    checks.push(`${name}: exact source selection, one applied compact summary, protected active request resumed once, next-wire replacement and unchanged raw history`)
    evidence.push({ scenario: name, tokens, selected, helperRequests: helpers.length, mainRequests: mainCalls().length })
  } finally {
    barrier?.release()
    test.respond(() => undefined)
    test.usage(() => undefined)
    try {
      await test.client.session.interrupt({ sessionID: session.id, resume: false })
      await test.client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(10000) })
      await remote.close()
      await test.client.session.remove({ sessionID: session.id })
    } catch (error) {
      checks.push(`${name}: session cleanup failed: ${String(error)}`)
      throw error
    }
  }
}

try {
  await test.until(async () => (await test.client.plugin.list({ location: { directory: test.project } })).data.some(plugin => plugin.id === "context-manager" && plugin.state.status === "active"), "plugin activation")
  await scenario("DEFAULT", [4000, 5000, 2000, 6000, 7000], 3)
  await scenario("STRICT", [4000, 6000, 2000, 6000, 7000], 3)
  await scenario("FALLBACK", [4000, 5000], 2, 10000, true)
  const zero = {
    ...test.config,
    plugins: test.config.plugins.map(plugin => typeof plugin === "string" ? plugin : {
      ...plugin, options: { ...plugin.options, autocompaction: { ...plugin.options.autocompaction, minRangeTokens: 0 } },
    }),
  }
  await writeFile(test.configPath, JSON.stringify(zero, null, 2))
  await test.restart()
  await test.until(async () => (await test.client.plugin.list({ location: { directory: test.project } })).data.some(plugin => plugin.id === "context-manager" && plugin.state.status === "active"), "configured zero-threshold plugin activation")
  await scenario("ZERO", [4000, 5000, 2000, 6000, 7000], 1, 0)
  passed = true
} finally {
  await test.close({ passed, checks, evidence })
  console.log(JSON.stringify({ root: test.root, version: test.hostVersion, passed, checks: checks.length, evidence }))
}
