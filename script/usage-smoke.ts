import assert from "node:assert/strict"
import { readFile, writeFile, unlink } from "node:fs/promises"
import path from "node:path"
import { Storage } from "../src/storage.ts"
import { hash } from "../src/context.ts"
import { Controller } from "../src/controller.ts"
import { remoteHost } from "../src/control.ts"
import { settings } from "../src/config.ts"
import { fixture } from "./host-fixture.ts"

const test = await fixture(process.argv[2])
const checks: string[] = []
const sessions: string[] = []
let passed = false
const make = async (strategy: "MANUAL" | "AUTO_PER_TURN" | "AUTO_SESSION" = "MANUAL") => {
  const session = await test.client.session.create({ location: { directory: test.project }, title: "Provider budget smoke", model: { providerID: "fixture", id: "small" } })
  sessions.push(session.id)
  const remote = remoteHost(test.client, session.id)
  const initial = await remote.load()
  const controller = new Controller(remote.host, session.id, settings(initial.settings), remote.artifacts)
  await remote.host.auto!.command(session.id, { action: "strategy", strategy })
  return { controller, remote }
}
const send = async (id: string, text: string) => {
  await test.client.session.prompt({ sessionID: id, text })
  await test.client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(45000) })
}
const accounting = async (controller: Controller) => (await controller.load()).runtime?.budget
const noHelpers = (input: { messages: unknown }) => /<selected_range_|Only the supplied summary/.test(JSON.stringify(input.messages))
try {
  await test.until(async () => (await test.client.plugin.list({ location: { directory: test.project } })).data.some((plugin) => plugin.id === "context-manager" && plugin.state.status === "active"), "plugin activation")
  for (const strategy of ["MANUAL", "AUTO_PER_TURN", "AUTO_SESSION"] as const) {
    test.usage((wire) => noHelpers(wire) ? undefined : { input: 10000, cached: 6000, written: 1000, output: 800, reasoning: 700 })
    const { controller } = await make(strategy)
    await send(controller.sessionID, "USAGE_BASE " + "Earlier useful facts. ".repeat(1200))
    const fallback = await accounting(controller)
    assert.equal(fallback?.source, "local-fallback")
    assert.equal(fallback?.multiplier, 1.3)
    assert.ok(fallback!.tokens <= 10000)
    const first = await test.client.session.context({ sessionID: controller.sessionID })
    const response = first.findLast((message) => message.type === "assistant")!
    assert.equal(response.type, "assistant")
    assert.deepEqual(response.tokens, { input: 3000, cache: { read: 6000, write: 1000 }, output: 100, reasoning: 700 })
    const start = test.requests.length
    await test.client.session.prompt({ sessionID: controller.sessionID, text: "NEXT_USAGE_REQUEST" })
    if (strategy === "MANUAL") {
      const pause = await test.until(async () => (await controller.host.auto!.state(controller.sessionID)).pause, "provider-based manual pause")
      assert.ok(pause.accounting!.local < pause.threshold && pause.tokens > pause.threshold)
      assert.equal(pause.accounting?.source, "provider-matched")
      assert.deepEqual(pause.accounting?.reported, { messageID: response.id, input: 10000, output: 800 })
      assert.equal(test.requests.length, start, "Local undercount must not dispatch the next request")
      await assert.rejects(controller.host.auto!.command(controller.sessionID, { action: "resume", pauseID: pause.id }), /Resume blocked/)
      const loaded = await controller.load()
      const draft = await controller.summarize("brief", loaded.blocks[0].sourceIDs)
      await controller.apply(draft, draft.operation.summary!)
      const reduced = (await controller.host.auto!.state(controller.sessionID)).pause!
      assert.ok(reduced.tokens < reduced.threshold)
      assert.equal(reduced.accounting?.reported?.messageID, response.id, "Helper reports cannot replace the parent's frozen usage anchor")
      await controller.host.auto!.command(controller.sessionID, { action: "resume", pauseID: pause.id })
    }
    await test.client.session.wait({ sessionID: controller.sessionID })
    assert.equal((await test.client.session.get({ sessionID: controller.sessionID })).outcome, "succeeded")
    assert.ok((await controller.load()).policy.cursor > 0)
    const snapshot = JSON.parse(await readFile(await controller.dump("2.0.24"), "utf8"))
    assert.equal(snapshot.runtime.budget.source, "provider-matched")
    checks.push(`${strategy}: lower local count cannot bypass high provider usage; same-loop reduction/resume and accounting export`)
  }

  let reports = 0
  test.usage((wire) => noHelpers(wire) ? undefined : ++reports === 1 ? { input: 8000, output: 100, cached: 5000 } : { input: 9500, output: 700, cached: 5000, reasoning: 600 })
  const { controller: pruning } = await make()
  await send(pruning.sessionID, "USAGE_TOOL EXERCISE_TOOL " + "Earlier useful facts. ".repeat(1200))
  await test.client.session.prompt({ sessionID: pruning.sessionID, text: "PAUSE_THEN_PRUNE" })
  const prunePause = await test.until(async () => (await pruning.host.auto!.state(pruning.sessionID)).pause, "provider pause before large-output pruning")
  assert.equal(prunePause.accounting?.source, "provider-matched")
  assert.ok(prunePause.accounting!.local < prunePause.threshold)
  await pruning.prune((await pruning.load()).blocks[0].sourceIDs, { reasoning: false, tools: "large" })
  const pruned = (await pruning.host.auto!.state(pruning.sessionID)).pause!
  assert.ok(pruned.tokens < pruned.threshold, JSON.stringify(pruned))
  assert.ok(pruned.accounting!.removed > 0 && pruned.accounting!.added > 0)
  await pruning.host.auto!.command(pruning.sessionID, { action: "resume", pauseID: prunePause.id })
  await test.client.session.wait({ sessionID: pruning.sessionID })
  assert.match(JSON.stringify(test.requests.at(-1)?.messages), /middle omitted/)
  checks.push("large-output pruning lowers a provider-based pause enough to resume without a stale-usage floor")

  test.usage((wire) => noHelpers(wire) ? undefined : { input: 10000, output: 800, cached: 6000, reasoning: 700 })
  const { controller: legacy } = await make()
  await send(legacy.sessionID, "EXISTING_SESSION " + "Earlier useful facts. ".repeat(1200))
  const old = await legacy.load()
  const oldDraft = await legacy.summarize("brief", old.blocks[0].sourceIDs)
  await legacy.apply(oldDraft, oldDraft.operation.summary!)
  const storage = new Storage(test.project, path.join(test.root, "home/.local/state/opencode-context-manager"))
  await unlink(path.join(storage.root, `budget-${hash(legacy.sessionID)}.json`))
  test.usage(() => ({ input: 2000, output: 100 }))
  await send(legacy.sessionID, "Next request after pre-upgrade cleanup")
  const bootstrapped = await accounting(legacy)
  assert.equal(bootstrapped?.source, "provider-unpaired")
  assert.ok(bootstrapped!.tokens < 10000)
  await send(legacy.sessionID, "Recalibrate using the new successful reduced request")
  assert.equal((await accounting(legacy))?.source, "provider-matched")
  assert.equal((await accounting(legacy))?.reported?.input, 2000)
  checks.push("existing already-edited sessions bootstrap conservatively and then acquire a fresh matched report")

  let phase = 0
  test.usage((wire) => noHelpers(wire) ? undefined : phase === 0 ? { input: 9300, output: 100, cached: 5000 } : { input: 9800, output: 100, cached: 5000 })
  const { controller: tools } = await make()
  await send(tools.sessionID, "USAGE_BASE " + "Earlier useful facts. ".repeat(1200))
  phase = 1
  const beforeTool = test.requests.length
  await test.client.session.prompt({ sessionID: tools.sessionID, text: "USAGE_TOOL EXERCISE_TOOL" })
  const toolPause = await test.until(async () => (await tools.host.auto!.state(tools.sessionID)).pause, "post-tool-result budget pause")
  assert.equal(test.requests.length, beforeTool + 1, "Exactly the tool-call request, not its continuation, should reach the provider")
  assert.equal(toolPause.accounting?.reported?.input, 9800)
  assert.ok(toolPause.accounting!.added > 0)
  assert.ok(toolPause.accounting!.local < toolPause.threshold && toolPause.tokens > toolPause.threshold)
  await tools.host.auto!.command(tools.sessionID, { action: "abort", pauseID: toolPause.id })
  await test.client.session.wait({ sessionID: tools.sessionID })
  checks.push("tool continuation includes new local results that previous provider usage did not measure")

  test.usage((wire) => noHelpers(wire) ? undefined : { input: 10000, output: 800, cached: 6000, written: 1000, reasoning: 700 })
  const { controller: restart } = await make()
  await send(restart.sessionID, "USAGE_RESTART " + "Earlier useful facts. ".repeat(1200))
  await test.restart()
  const fresh = remoteHost(test.client, restart.sessionID)
  await test.until(async () => { try { return await fresh.load() } catch { return undefined } }, "restarted accounting plugin")
  await test.client.session.prompt({ sessionID: restart.sessionID, text: "NEXT_AFTER_RESTART" })
  const persisted = await test.until(async () => (await fresh.host.auto!.state(restart.sessionID)).pause, "persisted matched request observation")
  assert.equal(persisted.accounting?.source, "provider-matched")
  assert.equal(persisted.accounting?.reported?.input, 10000)
  await fresh.host.auto!.command(restart.sessionID, { action: "abort", pauseID: persisted.id })
  await test.client.session.wait({ sessionID: restart.sessionID })
  checks.push("request-to-report matching survives actual service restart")

  await test.client.session.switchModel({ sessionID: restart.sessionID, model: { providerID: "fixture", id: "fixture" } })
  test.usage(() => undefined)
  await send(restart.sessionID, "Different model must not use the old smaller-model anchor")
  assert.equal((await fresh.load()).runtime?.budget?.source, "local-fallback")
  checks.push("model switch invalidates incompatible reported usage")

  const { controller: endpoint } = await make()
  test.usage(() => ({ input: 10000, output: 800, cached: 6000, reasoning: 700 }))
  await send(endpoint.sessionID, "USAGE_ENDPOINT " + "Earlier useful facts. ".repeat(1200))
  await test.client.session.prompt({ sessionID: endpoint.sessionID, text: "WAIT_FOR_ENDPOINT_CHANGE" })
  const oldEndpointPause = await test.until(async () => (await endpoint.host.auto!.state(endpoint.sessionID)).pause, "pause before route change")
  const endpointCalls = test.requests.length
  const baseURL = test.config.providers.fixture.settings.baseURL.replace("/v1", "/different-route/v1")
  const changed = { ...test.config, providers: { fixture: { ...test.config.providers.fixture, settings: { ...test.config.providers.fixture.settings, baseURL } } } }
  await writeFile(test.configPath, JSON.stringify(changed))
  await test.until(async () => (await test.client.provider.get({ providerID: "fixture", location: { directory: test.project } })).data.settings?.baseURL === baseURL, "new configured endpoint")
  const invalidated = (await endpoint.host.auto!.state(endpoint.sessionID)).pause
  assert.ok(!invalidated || invalidated.phase === "invalid")
  await assert.rejects(endpoint.host.auto!.command(endpoint.sessionID, { action: "resume", pauseID: oldEndpointPause.id }))
  if (invalidated) await endpoint.host.auto!.command(endpoint.sessionID, { action: "abort", pauseID: invalidated.id })
  await test.client.session.wait({ sessionID: endpoint.sessionID })
  assert.equal(test.requests.length, endpointCalls)
  test.usage(() => undefined)
  await send(endpoint.sessionID, "New endpoint; no compatible report yet")
  assert.equal((await accounting(endpoint))?.source, "local-fallback")
  checks.push("configured endpoint change invalidates a live gate and discards incompatible usage")

  const { controller: parent, remote } = await make()
  const editing = new Controller(remote.host, parent.sessionID, parent.config, remote.artifacts, "edit")
  test.usage((wire) => noHelpers(wire) ? { input: 167500, output: 1000, cached: 100000, reasoning: 900 } : undefined)
  await editing.rewrite("Saved summary", "First edit", { providerID: "fixture", modelID: "fixture" })
  const helperCalls = test.requests.length
  await assert.rejects(editing.rewrite("Saved summary", "Second edit", { providerID: "fixture", modelID: "fixture" }), /exceeds helper input capacity/)
  assert.equal(test.requests.length, helperCalls)
  assert.equal((await parent.load()).auto?.pause, undefined)
  await editing.dispose()
  checks.push("helper usage is isolated and over-capacity helper follow-ups fail before dispatch")
  passed = true
} finally {
  for (const sessionID of sessions) await test.client.session.remove({ sessionID }).catch(() => {})
  await test.close({ passed, checks })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
