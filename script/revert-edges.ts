import { applySummary } from "../test/fixtures.ts"
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import type { fixture } from "./host-fixture.ts"
import { Controller } from "../src/controller.ts"
import { remoteHost } from "../src/control.ts"
import { KEY, settings } from "../src/config.ts"
import { hash, readPolicy } from "../src/context.ts"

export async function verifyRevertEdges(test: Awaited<ReturnType<typeof fixture>>) {
  const location = { directory: test.project }
  const observations: Record<string, unknown>[] = []
  const info = (sessionID: string) => test.client.session.get({ sessionID })
  const native = (sessionID: string) => test.client.session.context({ sessionID })
  const requests = (sessionID: string) => test.calls.filter((call) => call.scope.sessionID === sessionID)
  const load = async (id: string) => {
    const remote = remoteHost(test.client, id)
    const loaded = await remote.load()
    return new Controller(remote.host, id, settings(loaded.settings), remote.artifacts)
  }
  const make = async (title: string) => {
    const session = await test.client.session.create({ location, title, model: { providerID: "fixture", id: "fixture" } })
    const controller = await load(session.id)
    await controller.host.auto!.command(session.id, { action: "strategy", strategy: "MANUAL" })
    return controller
  }
  const send = async (sessionID: string, text: string) => {
    await test.client.session.prompt({ sessionID, text })
    await test.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60000) })
    assert.equal((await info(sessionID)).outcome, "succeeded")
  }
  const summarize = async (controller: Controller, length: number) => {
    const loaded = await controller.load()
    const draft = await controller.summarize("brief", loaded.blocks.slice(0, length).flatMap((block) => block.sourceIDs))
    await applySummary(controller, draft)
  }
  const git = (...args: string[]) => { const result = spawnSync("git", args, { cwd: test.project, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr) }
  git("init")
  await writeFile(path.join(test.project, "revert-state.txt"), "initial")
  git("add", "revert-state.txt")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic baseline")
  test.config.snapshots = true
  test.config.plugins.push(path.join(test.repo, "test/revert-fixture"))
  test.config.permissions.push({ action: "revert_fixture_write", resource: "*", effect: "allow" })
  await writeFile(test.configPath, JSON.stringify(test.config))
  await test.restart()
  await test.until(async () => (await test.client.plugin.list({ location })).data.some((entry) => entry.id === "context-manager-revert-test-tools" && entry.state.status === "active"), "file tools active")
  test.respond((wire) => {
    if (JSON.stringify(wire.messages).includes("<selected_range_")) return "SUMMARY_FILE_STEPS"
    const last = wire.messages.findLastIndex((message) => message.role === "user")
    const match = JSON.stringify(wire.messages[last]).match(/FILE_TURN_([123])/)
    if (match && !wire.messages.slice(last).some((message) => message.role === "tool")) return { tool: { name: "revert_fixture_write", input: { text: `after-${match[1]}` } } }
    return undefined
  })
  const files = await make("file-rollback")
  for (let n = 1; n <= 3; n++) await send(files.sessionID, `FILE_TURN_${n}`)
  const filepath = path.join(test.project, "revert-state.txt")
  assert.equal(await readFile(filepath, "utf8"), "after-3")
  const original = await native(files.sessionID)
  assert.ok(original.some((message) => message.type === "assistant" && message.snapshot?.files?.includes("revert-state.txt")))
  await summarize(files, 2)
  const policy = hash((await info(files.sessionID)).metadata?.[KEY])
  const user2 = original.filter((message) => message.type === "user")[1]
  await test.client.session.revert.stage({ sessionID: files.sessionID, messageID: user2.id })
  assert.equal(await readFile(filepath, "utf8"), "after-1")
  assert.equal((await files.load()).blocks.length, 1)
  assert.equal(hash((await info(files.sessionID)).metadata?.[KEY]), policy)
  await test.client.session.revert.clear({ sessionID: files.sessionID })
  await test.client.session.wait({ sessionID: files.sessionID })
  assert.equal(await readFile(filepath, "utf8"), "after-3")
  assert.equal((await files.load()).blocks[0].kind, "brief")
  await test.client.session.revert.stage({ sessionID: files.sessionID, messageID: user2.id, files: false })
  assert.equal(await readFile(filepath, "utf8"), "after-3")
  await test.client.session.revert.clear({ sessionID: files.sessionID })
  await test.client.session.wait({ sessionID: files.sessionID })
  await test.client.session.revert.stage({ sessionID: files.sessionID, messageID: user2.id })
  const calls = requests(files.sessionID).length
  await send(files.sessionID, "EDITED_SECOND_FILE_TASK")
  assert.equal(await readFile(filepath, "utf8"), "after-1")
  assert.equal(requests(files.sessionID).length, calls + 1)
  observations.push({ label: "files", staged: true, redo: true, filesFalse: true, continued: true })

  let explicit = await make("explicit-commit")
  for (let n = 1; n <= 3; n++) await send(explicit.sessionID, `EXPLICIT_${n}`)
  await summarize(explicit, 2)
  const users = (await native(explicit.sessionID)).filter((message) => message.type === "user")
  const saved = (await info(explicit.sessionID)).metadata!
  for (const at of [1, 2, 0]) {
    await test.client.session.revert.stage({ sessionID: explicit.sessionID, messageID: users[at].id, files: false })
    const view = await explicit.load()
    assert.deepEqual(view.blocks.map((block) => block.kind), at === 2 ? ["brief"] : Array(at).fill("turn"))
    assert.equal(hash((await info(explicit.sessionID)).metadata?.[KEY]), hash(saved[KEY]))
    if (at === 2) await assert.rejects(explicit.prepareRestore([view.blocks[0].sourceIDs]), /undo\/unrevert/)
  }
  await test.client.session.revert.clear({ sessionID: explicit.sessionID })
  await test.client.session.wait({ sessionID: explicit.sessionID })
  await test.client.session.revert.stage({ sessionID: explicit.sessionID, messageID: users[1].id, files: false })
  await test.client.session.revert.commit({ sessionID: explicit.sessionID })
  await explicit.load()
  await test.client.session.update({ sessionID: explicit.sessionID, metadata: saved })
  await test.restart()
  explicit = await load(explicit.sessionID)
  assert.equal((await explicit.load()).blocks.length, 1)
  assert.equal((await explicit.load()).policy.operations.length, 0)
  await send(explicit.sessionID, "AFTER_COLD_COMMIT")
  observations.push({ label: "boundary-movement-and-cold-commit", originalPolicyRestoredToSimulateMissedEvent: true, restarted: true, continued: true })

  const legacy = await make("format-12-backfill")
  for (let n = 1; n <= 3; n++) await send(legacy.sessionID, `LEGACY_${n}`)
  await summarize(legacy, 2)
  const { sources: _sources, epoch: _epoch, ...old } = (await legacy.load()).policy
  await test.client.session.update({ sessionID: legacy.sessionID, metadata: { [KEY]: { ...old, version: 12 } } })
  const upgraded = await legacy.load()
  assert.ok(upgraded.policy.sources?.length)
  assert.deepEqual(upgraded.policy.operations, old.operations)
  await test.client.session.revert.stage({ sessionID: legacy.sessionID, messageID: (await native(legacy.sessionID)).filter((message) => message.type === "user")[1].id, files: false })
  await send(legacy.sessionID, "LEGACY_REVERT_CONTINUES")
  observations.push({ label: "format-12-backfill", originalOperationsUnchanged: true, continued: true })

  const draft = await make("stale-helper")
  for (let n = 1; n <= 3; n++) await send(draft.sessionID, `DRAFT_${n}`)
  const loaded = await draft.load()
  const proposal = await draft.summarize("brief", loaded.blocks.slice(0, 2).flatMap((block) => block.sourceIDs))
  await test.client.session.revert.stage({ sessionID: draft.sessionID, messageID: (await native(draft.sessionID)).filter((message) => message.type === "user")[1].id, files: false })
  await assert.rejects(applySummary(draft, proposal), /undo\/unrevert/)
  await test.client.session.revert.clear({ sessionID: draft.sessionID })
  await test.client.session.wait({ sessionID: draft.sessionID })
  await assert.rejects(applySummary(draft, proposal), /changed/i)
  await draft.discard()
  observations.push({ label: "stale-helper", stagedApplyRejected: true, staleApplyRejectedAfterRedo: true })

  const busy = await make("busy")
  await send(busy.sessionID, "BUSY_OLD")
  const older = (await native(busy.sessionID)).find((message) => message.type === "user")!
  const release = test.hold()
  try {
    await test.client.session.prompt({ sessionID: busy.sessionID, text: "HOLD_FIXTURE" })
    await test.until(() => requests(busy.sessionID).length === 2, "busy provider arrival")
    await assert.rejects(test.client.session.revert.stage({ sessionID: busy.sessionID, messageID: older.id, files: false }), /busy|running|active/i)
  } finally { release() }
  await test.client.session.wait({ sessionID: busy.sessionID })
  assert.equal((await info(busy.sessionID)).revert, undefined)
  observations.push({ label: "busy-session", stageRejected: true })

  const checkpoint = await make("checkpoint")
  await checkpoint.host.auto!.command(checkpoint.sessionID, { action: "strategy", strategy: "AUTO_PER_TURN" })
  await test.client.session.switchModel({ sessionID: checkpoint.sessionID, model: { providerID: "fixture", id: "small" } })
  await send(checkpoint.sessionID, "CHECKPOINT_SOURCE " + " fact".repeat(15000))
  assert.ok((await checkpoint.load()).policy.operations.some((op) => op.checkpoint))
  const first = (await native(checkpoint.sessionID)).find((message) => message.type === "user")!
  await test.client.session.revert.stage({ sessionID: checkpoint.sessionID, messageID: first.id, files: false })
  assert.deepEqual((await checkpoint.load()).blocks, [])
  await test.client.session.revert.clear({ sessionID: checkpoint.sessionID })
  await test.client.session.wait({ sessionID: checkpoint.sessionID })
  assert.ok((await checkpoint.load()).policy.operations.some((op) => op.checkpoint))
  await test.client.session.revert.stage({ sessionID: checkpoint.sessionID, messageID: first.id, files: false })
  await send(checkpoint.sessionID, "CHECKPOINT_REPLACEMENT")
  assert.equal((await checkpoint.load()).policy.operations.length, 0)
  observations.push({ label: "automatic-checkpoint", redo: true, continued: true })

  const accounting = await make("usage-after-revert")
  test.usage((_wire, scope) => scope.sessionID === accounting.sessionID ? { input: 1000, output: 10 } : undefined)
  for (let n = 1; n <= 3; n++) await send(accounting.sessionID, `USAGE_${n}`)
  await summarize(accounting, 2)
  await test.client.session.revert.stage({ sessionID: accounting.sessionID, messageID: (await native(accounting.sessionID)).filter((message) => message.type === "user")[1].id, files: false })
  await send(accounting.sessionID, "USAGE_AFTER_REVERT")
  const after = await accounting.load()
  assert.ok(readPolicy(after.session).epoch)
  assert.equal(after.runtime?.budget?.source, "local-fallback")
  await send(accounting.sessionID, "USAGE_NEXT_REQUEST")
  assert.equal((await accounting.load()).runtime?.budget?.source, "provider-matched")
  observations.push({ label: "usage-after-revert", fallbackThenMatched: true })
  return observations
}
