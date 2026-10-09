import assert from "node:assert/strict"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { writeFile } from "node:fs/promises"
import { fixture } from "./host-fixture.ts"
import { Controller } from "../src/controller.ts"
import { remoteHost } from "../src/control.ts"
import { KEY, VERSION, settings } from "../src/config.ts"

const baseline = process.argv[3]
if (!baseline) throw new Error("Supply an installed 3.2.0 source directory after the OpenCode executable")
const load = (name: string) => import(pathToFileURL(path.join(baseline, name)).href)
const original = await load("context.ts")
const normalize = await load("v2/normalize.ts")
const test = await fixture(process.argv[2], undefined, { plugin: path.resolve(baseline) })
const checks: string[] = []
let passed = false
const send = async (id: string, text: string) => {
  await test.client.session.prompt({ sessionID: id, text })
  await test.client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(45000) })
  assert.equal((await test.client.session.get({ sessionID: id })).outcome, "succeeded")
}
try {
  const sessions = []
  for (const version of [7, 8]) {
    const session = await test.client.session.create({ location: { directory: test.project }, model: { providerID: "fixture", id: "fixture" }, metadata: { unrelated: "keep" } })
    await send(session.id, "ROOT_FACT EXERCISE_TOOL")
    await send(session.id, "SECOND_FACT")
    const raw = normalize.transcriptView(await test.client.session.get({ sessionID: session.id }), await test.client.session.context({ sessionID: session.id }))
    let policy = original.emptyPolicy(session.id)
    const blocks = () => original.project(original.nativeActive(raw), policy)
    policy = original.append(policy, { ...original.operation("tool-prune", [blocks()[0]], { unit: "tokens", threshold: 300, head: 40, tail: 160, library: "gpt-tokenizer@4.0.0", encoding: "o200k_base" }), pruneReason: true })
    const compact = { ...original.operation("compact", [blocks()[0]]), summary: `UPGRADE_SUMMARY_${version}`, ...(version === 8 ? { checkpoint: true } : {}) }
    policy = original.append(policy, compact)
    policy = original.append(policy, { ...original.operation("revise", [blocks()[0]]), targetID: compact.id, summary: `UPGRADE_REVISED_${version}` })
    assert.equal(policy.version, version)
    await test.client.session.update({ sessionID: session.id, metadata: JSON.parse(JSON.stringify({ ...session.metadata, [KEY]: policy })) })
    await send(session.id, "Observe saved policy before upgrade")
    assert.ok(JSON.stringify(test.requests.at(-1)).includes(`UPGRADE_REVISED_${version}`))
    sessions.push({ id: session.id, policy: JSON.parse(JSON.stringify(policy)), summaryID: compact.id })
  }
  checks.push("3.2.0 applies genuine format-7/8 pruning, summaries and revisions on the host")
  for (const entry of test.config.plugins) if (typeof entry !== "string") entry.package = path.join(test.repo, "src")
  await writeFile(test.configPath, JSON.stringify(test.config))
  await test.restart()
  for (const saved of sessions) {
    const remote = remoteHost(test.client, saved.id)
    const published = await remote.load()
    assert.equal(published.version, VERSION)
    assert.deepEqual((await test.client.session.get({ sessionID: saved.id })).metadata?.[KEY], saved.policy)
    const controller = new Controller(remote.host, saved.id, settings(published.settings), remote.artifacts)
    assert.equal((await controller.summary(saved.summaryID)).text, `UPGRADE_REVISED_${saved.policy.version}`)
    await send(saved.id, "First main request after upgrade")
    assert.ok(JSON.stringify(test.requests.at(-1)).includes(`UPGRADE_REVISED_${saved.policy.version}`))
    const before = await controller.load()
    const preview = await controller.prepareRestore("expand", before.blocks[0].sourceIDs)
    await controller.applyRestore(preview)
    const after = await controller.load()
    assert.equal(after.policy.version, 9)
    assert.equal("cursor" in after.policy, false)
    assert.deepEqual(after.policy.operations.slice(0, 3), saved.policy.operations)
    assert.equal(after.blocks[0].reasonPruned, true)
    assert.ok(Object.keys(after.blocks[0].pruned ?? {}).length)
    await send(saved.id, "First main request after expansion")
    const wire = JSON.stringify(test.requests.at(-1))
    assert.ok(!wire.includes("UPGRADE_REVISED") && wire.includes("middle omitted") && !wire.includes("REASONING_FIXTURE"))
    assert.equal((await test.client.session.get({ sessionID: saved.id })).metadata?.unrelated, "keep")
    await remote.close()
    checks.push(`format ${saved.policy.version}: unchanged stored ledger on read; same-model replay, expansion and append-only upgrade`)
  }
  await test.restart()
  for (const saved of sessions) await send(saved.id, "Format 9 survives restart")
  checks.push("upgraded ledgers survive a second private restart")
  passed = true
} finally {
  await test.close({ passed, checks })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
