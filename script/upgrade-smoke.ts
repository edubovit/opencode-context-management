import assert from "node:assert/strict"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { fixture } from "./host-fixture.ts"
import { Controller } from "../src/controller.ts"
import { remoteHost } from "../src/control.ts"
import { KEY, settings } from "../src/config.ts"
import { hash } from "../src/context.ts"
import { nativeFixture } from "../test/native-fixtures.ts"

const [oldHost, newHost, baseline] = process.argv.slice(2)
if (!oldHost || !newHost || !baseline) throw new Error("Supply baseline/current host executables and an installed baseline source directory; use the same executable for a plugin-only upgrade")
const original = await import(pathToFileURL(path.resolve(baseline, "context.ts")).href)
const normalize = await import(pathToFileURL(path.resolve(baseline, "normalize.ts")).href)
const { rememberPolicy } = await import(pathToFileURL(path.resolve(baseline, "revert.ts")).href)
const { FALLBACK_BASIS } = await import(pathToFileURL(path.resolve(baseline, "tokens.ts")).href)
const test = await fixture(oldHost, undefined, { plugin: path.resolve(baseline) })
const checks: string[] = []
let passed = false
try {
  const source = await test.client.session.create({ location: { directory: test.project }, model: { providerID: "fixture", id: "fixture" } })
  const messages = nativeFixture().native.map(message => {
    if (message.type !== "assistant") return message
    return { ...message, model: source.model!, providerState: { step: "native-step" }, content: message.content.map(part => {
      if (part.type === "tool") return { ...part, providerState: { call: "native-call" }, state: { ...part.state, content: [{ type: "text", text: "HEAD_0 ".repeat(50) + "x\uFEFFword\n".repeat(300) + " TAIL_0".repeat(50) }] } }
      const { native, ...rest } = part
      return { ...rest, state: native ?? { phase: "native-text" } }
    }) }
  })
  await test.client.session.remove({ sessionID: source.id })
  const session = await test.client.session.import({ info: source, messages: JSON.parse(JSON.stringify(messages)), location: { directory: test.project } })
  const before = await test.client.session.context({ sessionID: session.id })
  const raw = normalize.transcriptView(session, before)
  let policy = original.emptyPolicy(session.id)
  const blocks = () => original.project(original.activeMessages(raw), policy)
  const rule = { unit: "tokens", threshold: 100, head: 12, tail: 12, encoding: "o200k_base", library: FALLBACK_BASIS.library }
  policy = original.append(policy, { ...original.operation("tool-prune", [blocks()[0]], rule), pruneReason: true })
  const prunedMessages = hash(blocks()[0].messages)
  const savedOutput = blocks()[0].messages.flatMap((message: { parts: { type: string; state?: { output?: string } }[] }) => message.parts).find((part: { type: string }) => part.type === "tool")!.state!.output!
  policy = original.append(policy, { ...original.operation("compact", blocks().slice(0, 2)), summary: "UPGRADE_SAVED_SUMMARY" })
  policy = rememberPolicy(raw, policy)
  await test.client.session.update({ sessionID: session.id, metadata: JSON.parse(JSON.stringify({ ...session.metadata, [KEY]: policy })) })
  checks.push(`saved reductions with signed synthetic native data created on ${test.hostVersion}`)
  for (const entry of test.config.plugins) if (typeof entry !== "string") entry.package = path.join(test.repo, "src")
  await writeFile(test.configPath, JSON.stringify(test.config))
  await test.restart(newHost)
  const remote = remoteHost(test.client, session.id)
  const inspected = await remote.load()
  const controller = new Controller(remote.host, session.id, settings(inspected.settings), remote.artifacts)
  const loaded = await controller.load()
  assert.equal(loaded.blocks[0].kind, "compact")
  assert.deepEqual(loaded.policy, policy)
  assert.equal(hash(normalize.transcriptView(session, before)), hash(loaded.raw))
  const send = async (text: string) => {
    await test.client.session.prompt({ sessionID: session.id, text })
    await test.client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(45000) })
    assert.equal((await test.client.session.get({ sessionID: session.id })).outcome, "succeeded")
    return JSON.stringify(test.requests.at(-1))
  }
  assert.match(await send("First request after upgrade"), /UPGRADE_SAVED_SUMMARY/)
  await controller.restoreRanges([loaded.blocks[0].sourceIDs])
  const pruned = await controller.load()
  assert.equal(pruned.blocks[0].reasonPruned, true)
  assert.equal(hash(pruned.blocks[0].messages), prunedMessages)
  const wire = await send("First request after summary expansion")
  assert.ok(!wire.includes("UPGRADE_SAVED_SUMMARY") && !wire.includes("REASON_0") && wire.includes(JSON.stringify(savedOutput).slice(1, -1)))
  await controller.restoreRanges([pruned.blocks[0].sourceIDs])
  const restored = await send("First request after pruning restoration")
  assert.ok(restored.includes("REASON_0") && restored.includes("HEAD_0"))
  const current = await test.client.session.context({ sessionID: session.id })
  assert.equal(hash(normalize.transcriptView(session, before)), hash((await controller.load()).raw.slice(0, before.length)))
  const snapshot = hash(current)
  await remote.close()
  await test.restart()
  assert.equal(hash(await test.client.session.context({ sessionID: session.id })), snapshot)
  checks.push(`unchanged ledger fingerprints, same-model continuation, layered restoration and restart on ${test.hostVersion}`)
  passed = true
} finally {
  await test.close({ passed, checks })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
