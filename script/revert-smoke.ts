import { applySummary } from "../test/fixtures.ts"
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { fixture } from "./host-fixture.ts"
import { terminal } from "./terminal.ts"
import { verifyRevertEdges } from "./revert-edges.ts"
import { Controller } from "../src/controller.ts"
import { remoteHost } from "../src/control.ts"
import { KEY, VERSION, settings } from "../src/config.ts"
import { emptyPolicy, hash, type Block } from "../src/context.ts"

const test = await fixture(process.argv[2], undefined, { keep: 0 })
console.log(test.root)
const location = { directory: test.project }
const observations: Record<string, unknown>[] = []
let passed = false
let summary = 0
const native = (sessionID: string) => test.client.session.context({ sessionID })
const info = (sessionID: string) => test.client.session.get({ sessionID })
const requests = (id: string) => test.calls.filter((call) => call.scope.sessionID === id)
const meaning = (blocks: Block[]) => blocks.map((block) => ({ kind: block.kind, messages: block.messages.map((message) => ({ role: message.info.role, parts: JSON.parse(JSON.stringify(message.parts, (key, value) => ["id", "sessionID", "messageID", "operationID"].includes(key) ? undefined : value)) })) }))
const retained = (blocks: Block[], ids: Set<string>): Block[] => blocks.flatMap((block) => {
  const sourceIDs = block.sourceIDs.filter((id) => ids.has(id))
  if (!sourceIDs.length) return []
  if (sourceIDs.length === block.sourceIDs.length) return [block]
  return block.kind === "turn" ? [{ ...block, sourceIDs, messages: block.messages.filter((message) => ids.has(message.info.id)) }] : retained(block.previous!, ids)
})
const controller = async (id: string) => {
  const remote = remoteHost(test.client, id)
  const loaded = await remote.load()
  assert.equal(loaded.version, VERSION)
  return new Controller(remote.host, id, settings(loaded.settings), remote.artifacts)
}
const send = async (id: string, text: string) => {
  await test.client.session.prompt({ sessionID: id, text })
  await test.client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(90000) })
  const current = await info(id)
  assert.equal(current.outcome, "succeeded", JSON.stringify((await native(id)).at(-2)))
  return current
}
const seed = async (title: string) => {
  const session = await test.client.session.create({ location, title, model: { providerID: "fixture", id: "fixture" }, metadata: { unrelated: "KEEP" } })
  const value = await controller(session.id)
  await value.host.auto!.command(session.id, { action: "strategy", strategy: "MANUAL" })
  for (let n = 1; n <= 11; n++) await send(session.id, `TURN_${String(n).padStart(2, "0")}_RAW${n === 1 ? "EXERCISE_TOOL" : ""}`)
  return value
}
const summarize = async (value: Controller, start: number, length: number, mode: "compact" | "brief" = "brief") => {
  summary++
  const loaded = await value.load()
  const draft = await value.summarize(mode, loaded.blocks.slice(start, start + length).flatMap((block) => block.sourceIDs), undefined, undefined, "total")
  await applySummary(value, draft)
}
const range = async (value: Controller, start: number, length: number) => (await value.load()).blocks.slice(start, start + length).flatMap((block) => block.sourceIDs)
const restore = async (value: Controller) => value.restoreRanges([(await value.load()).blocks[0].sourceIDs])

async function probe(value: Controller, label: string, cut: number, restart = false) {
  const id = value.sessionID
  const beforeNative = await native(id)
  const before = await value.load()
  const beforePolicy = hash((await info(id)).metadata?.[KEY])
  const users = beforeNative.filter((message) => message.type === "user")
  const messageID = users[cut - 1].id
  const prefix = beforeNative.slice(0, beforeNative.findIndex((message) => message.id === messageID))
  const expected = retained(before.blocks, new Set(prefix.map((message) => message.id)))
  const beforeCalls = requests(id).length
  const stage = () => test.client.session.revert.stage({ sessionID: id, messageID, files: false })
  await stage()
  assert.equal((await info(id)).revert?.messageID, messageID)
  assert.equal(hash(await native(id)), hash(beforeNative))
  assert.deepEqual(meaning((await value.load()).blocks), meaning(expected), `${label}: staged prefix`)
  assert.equal(hash((await info(id)).metadata?.[KEY]), beforePolicy, "staging keeps redo state")
  await test.client.session.revert.clear({ sessionID: id })
  await test.client.session.wait({ sessionID: id })
  assert.equal(hash((await value.load()).blocks), hash(before.blocks))
  const redone = await native(id)
  assert.deepEqual(redone.filter((message) => beforeNative.some((old) => old.id === message.id)), beforeNative)
  assert.ok(redone.filter((message) => !beforeNative.some((old) => old.id === message.id)).every((message) => message.type === "idle"))
  assert.equal(hash((await info(id)).metadata?.[KEY]), beforePolicy)
  await stage()
  if (restart) {
    await test.restart()
    value = await controller(id)
    assert.deepEqual(meaning((await value.load()).blocks), meaning(expected))
    await test.client.session.revert.clear({ sessionID: id })
    await test.client.session.wait({ sessionID: id })
    assert.equal(hash((await value.load()).blocks), hash(before.blocks))
    await stage()
  }
  const edited = `TURN_${String(cut).padStart(2, "0")}_EDITED`
  const current = await send(id, edited)
  assert.equal(current.revert, undefined)
  assert.equal(current.metadata?.unrelated, "KEEP")
  const afterNative = await native(id)
  const afterUsers = afterNative.filter((message) => message.type === "user")
  assert.deepEqual(afterUsers.map((message) => message.text), [...users.slice(0, cut - 1).map((message) => message.text), edited])
  assert.deepEqual(afterNative.filter((message) => prefix.some((entry) => entry.id === message.id)), prefix)
  assert.equal(requests(id).length - beforeCalls, 1)
  const wire = JSON.stringify(requests(id).at(-1)!.wire.messages)
  assert.ok(wire.includes(edited))
  for (let n = cut; n <= 11; n++) assert.ok(!wire.includes(`TURN_${String(n).padStart(2, "0")}_RAW`))
  for (const block of expected) for (const message of block.messages) for (const part of message.parts)
    if (part.type === "text") assert.ok(wire.includes(JSON.stringify(part.text).slice(1, -1)), "retained effective text reaches provider")
  const after = await value.load()
  assert.deepEqual(meaning(after.blocks.slice(0, expected.length)), meaning(expected))
  assert.equal(after.blocks.length, expected.length + 1)
  await test.client.session.revert.clear({ sessionID: id })
  await test.client.session.wait({ sessionID: id })
  assert.deepEqual((await native(id)).filter((message) => message.type === "user"), afterUsers)
  if (restart) {
    await test.restart()
    value = await controller(id)
    assert.deepEqual(meaning((await value.load()).blocks), meaning(after.blocks))
    await send(id, "AFTER_COMMITTED_REVERT_RESTART")
  }
  const restored = await value.load()
  const groups = restored.blocks.filter((block) => block.summaryID || block.deletionID || block.pruning?.length).map((block) => block.sourceIDs)
  if (groups.length) {
    const preview = await value.prepareRestore(groups)
    await value.applyOperations(preview.operations, preview)
    await send(id, "AFTER_ONE_LAYER_RESTORATION")
  }
  observations.push({ label, cut, retained: expected.map((block) => block.kind), redo: true, continuation: true, restoration: !!groups.length, restart })
  console.log(JSON.stringify(observations.at(-1)))
}

try {
  await test.until(async () => (await test.client.plugin.list({ location })).data.some((plugin) => plugin.id === "context-manager" && plugin.state.status === "active"), "plugin activation")
  test.respond((wire) => JSON.stringify(wire.messages).includes("<selected_range_") ? `SAVED_SUMMARY_${summary} covers selected facts.` : undefined)
  await probe(await seed("plain"), "plain", 8)
  const empty = await seed("empty-ledger")
  await test.client.session.update({ sessionID: empty.sessionID, metadata: { ...(await info(empty.sessionID)).metadata, [KEY]: emptyPolicy(empty.sessionID) } })
  await probe(empty, "empty-ledger", 8)
  for (const cut of [1, 8, 10, 11]) {
    const value = await seed(`compact-cut-${cut}`)
    await summarize(value, 0, 10, "compact")
    await probe(value, `compact-1-10/cut-${cut}`, cut, cut === 8 || cut === 11)
  }
  const cases: { label: string; setup(value: Controller): Promise<unknown> }[] = [
    { label: "brief-1-10", setup: (value) => summarize(value, 0, 10) },
    { label: "only-later-summary-9-10", setup: (value) => summarize(value, 8, 2) },
    { label: "earlier-and-crossing-summaries", setup: async (value) => { await summarize(value, 0, 3); await summarize(value, 1, 7) } },
    { label: "nested-summary", setup: async (value) => { await summarize(value, 0, 3); await summarize(value, 0, 8) } },
    { label: "revised-summary", setup: async (value) => { await summarize(value, 0, 10); await value.editSummary(await value.summary((await value.load()).blocks[0].summaryID!), "REVISED_SENTINEL") } },
    { label: "expanded-summary-audit", setup: async (value) => { await summarize(value, 0, 10); await restore(value) } },
    { label: "deleted-1-10", setup: async (value) => value.deleteRanges([await range(value, 0, 10)]) },
    { label: "restored-deletion-audit", setup: async (value) => { await value.deleteRanges([await range(value, 0, 10)]); await restore(value) } },
    ...(["large", "all", "delete", undefined] as const).map((tools) => ({ label: `prune-crossing-${tools ?? "reason"}`, setup: async (value: Controller) => value.prune(await range(value, 0, 10), { reasoning: true, ...(tools ? { tools } : {}) }) })),
    { label: "prune-before-boundary", setup: async (value) => value.prune(await range(value, 0, 1), { reasoning: true, tools: "all" }) },
    { label: "summary-before-boundary", setup: (value) => summarize(value, 0, 3) },
    { label: "fully-restored-prune-audit", setup: async (value) => { const ids = await range(value, 0, 10); await value.prune(ids, { reasoning: true, tools: "all" }); await value.restoreRanges([ids]) } },
  ]
  for (const scenario of cases) {
    const value = await seed(scenario.label)
    await scenario.setup(value)
    await probe(value, scenario.label, 8)
  }
  const parent = await seed("fork-parent")
  await summarize(parent, 0, 3)
  const original = hash({ info: await info(parent.sessionID), native: await native(parent.sessionID) })
  const fork = await test.client.session.fork({ sessionID: parent.sessionID })
  await probe(await controller(fork.id), "fork-saved-turn-ends", 8)
  assert.equal(hash({ info: await info(parent.sessionID), native: await native(parent.sessionID) }), original)

  if (process.argv.includes("--tui")) {
    const value = await seed("REVERT_UI")
    await summarize(value, 0, 10)
    const user8 = (await native(value.sessionID)).filter((message) => message.type === "user")[7]
    const tui = terminal({ executable: process.argv[2], url: test.url, project: test.project, sessionID: value.sessionID, env: test.env, output: path.join(test.root, "revert-tui.log") })
    const seen = (pattern: RegExp) => test.until(async () => pattern.test((await tui.text()).replace(/\s+/g, " ")), `revert UI ${pattern}`)
    try {
      await seen(/REVERT_UI/)
      tui.keys("/timeline")
      await seen(/\/timeline\s+Jump to message/)
      tui.keys("\r")
      await seen(/Timeline/)
      tui.keys("TURN_08_RAW")
      await seen(/TURN_08_RAW/)
      tui.keys("\r")
      await seen(/Message Actions/)
      tui.keys("\x1b[B\r")
      await test.until(async () => (await info(value.sessionID)).revert?.messageID === user8.id, "UI revert turn 8")
      await seen(/4 messages reverted/)
      const screen = await tui.text()
      assert.ok(screen.split("\n").slice(-8).join("\n").includes("TURN_08_RAW"))
      await writeFile(path.join(test.root, "revert-staged.screen.txt"), screen)
      assert.deepEqual((await value.load()).blocks.map((block) => block.kind), Array(7).fill("turn"))
      const before = requests(value.sessionID).length
      tui.keys("_EDITED\r")
      await test.until(async () => !(await info(value.sessionID)).revert, "UI submit commits revert")
      await test.until(async () => (await native(value.sessionID)).some(message => message.type === "user" && message.text === "TURN_08_RAW_EDITED"), "edited UI prompt admitted after revert commit")
      await test.until(() => requests(value.sessionID).length > before, "edited UI prompt reaches provider")
      await test.client.session.wait({ sessionID: value.sessionID }, { signal: AbortSignal.timeout(60000) })
      assert.equal((await info(value.sessionID)).outcome, "succeeded")
      assert.equal(requests(value.sessionID).length, before + 1)
      tui.keys("/context-manager")
      await seen(/\/context-manager\s+Context manager/)
      tui.keys("\r")
      await seen(/Ready\./)
      await seen(/USER/)
      tui.keys("\x1b")
      await test.until(async () => !(await tui.text()).includes("Local text"), "exit inspector")
      observations.push({ label: "actual-tui-revert-8", draft: true, retained: 7, continued: true, inspector: true })
    } finally { assert.equal(await tui.close(), 0) }
  }
  observations.push(...await verifyRevertEdges(test))
  passed = true
} finally {
  await test.close({ passed, pluginVersion: VERSION, observations })
  console.log(JSON.stringify({ root: test.root, passed, scenarios: observations.length }))
}
