import assert from "node:assert/strict"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import type { SessionMessageInfo } from "@opencode/client"
import { fixture } from "./host-fixture.ts"
import { Controller } from "../src/controller.ts"
import { remoteHost } from "../src/control.ts"
import { KEY, settings } from "../src/config.ts"
import { hash, historyHash } from "../src/context.ts"
import { nativeFixture } from "../test/native-fixtures.ts"
import { syntheticImage } from "../test/media-fixture.ts"

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
  const messages: SessionMessageInfo[] = nativeFixture().native.map(message => {
    if (message.type !== "assistant") return message
    return { ...message, model: source.model!, providerState: { step: "native-step" }, content: message.content.map(part => {
      if (part.type === "tool") return { ...part, providerState: { call: "native-call" }, state: { ...part.state, content: [{ type: "text" as const, text: "HEAD_0 ".repeat(50) + "x\uFEFFword\n".repeat(300) + " TAIL_0".repeat(50) }] } }
      const { native, ...rest } = part
      return { ...rest, state: native ?? { phase: "native-text" } }
    }) }
  })
  const firstUser = messages.find(message => message.type === "user")!
  if (firstUser.type !== "user") throw new Error("Missing fixture user")
  firstUser.files = [{ mime: "image/png", name: "synthetic.png", data: syntheticImage.uri.split(",")[1], source: { type: "uri", uri: "fixture:synthetic.png" } }]
  const assistant = messages.find(message => message.type === "assistant")!
  if (assistant.type !== "assistant") throw new Error("Missing fixture assistant")
  const tool = assistant.content.find(part => part.type === "tool")!
  if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Missing fixture tool")
  tool.state.content.push(syntheticImage)
  messages.splice(messages.indexOf(assistant), 0,
    { ...assistant, id: "msg_failed_reasoning", error: { type: "aborted", message: "Synthetic failure" }, content: [{ type: "reasoning", text: "FAILED_REASONING_MUST_STAY_OMITTED", time: { created: 2, completed: 3 } }] },
    { ...assistant, id: "msg_interrupted_reasoning", content: [{ type: "reasoning", text: "INTERRUPTED_REASONING_MUST_STAY_OMITTED", time: { created: 2 } }] })
  await test.client.session.remove({ sessionID: source.id })
  const session = await test.client.session.import({ info: source, messages: JSON.parse(JSON.stringify(messages)), location: { directory: test.project } })
  const before = await test.client.session.context({ sessionID: session.id })
  const raw = normalize.transcriptView(session, before)
  let policy = original.emptyPolicy(session.id)
  const blocks = () => original.project(original.activeMessages(raw), policy)
  const rule = { unit: "tokens", threshold: 100, head: 12, tail: 12, encoding: "o200k_base", library: FALLBACK_BASIS.library }
  policy = original.append(policy, { ...original.operation("tool-prune", [blocks()[0]], rule), pruneReason: true })
  const prunedMessages = historyHash(blocks()[0].messages)
  const savedOutput = blocks()[0].messages.flatMap((message: { parts: { type: string; state?: { output?: string } }[] }) => message.parts).find((part: { type: string }) => part.type === "tool")!.state!.output!
  policy = original.append(policy, { ...original.operation("compact", blocks().slice(0, 2)), summary: "UPGRADE_SAVED_SUMMARY" })
  policy = rememberPolicy(raw, policy)
  await test.client.session.update({ sessionID: session.id, metadata: JSON.parse(JSON.stringify({ ...session.metadata, [KEY]: policy })) })
  checks.push(`saved reductions with signed synthetic native data created on ${test.hostVersion}`)
  const continued = await test.client.session.create({ location: { directory: test.project }, model: source.model })
  await test.client.session.prompt({ sessionID: continued.id, text: "EXERCISE_TOOL before background continuation" })
  await test.client.session.wait({ sessionID: continued.id }, { signal: AbortSignal.timeout(45000) })
  const continuedNative = await test.client.session.context({ sessionID: continued.id })
  const continuedRaw = normalize.transcriptView(continued, continuedNative)
  const continuedPolicy = rememberPolicy(continuedRaw, original.append(original.emptyPolicy(continued.id), original.operation("tool-prune-all", original.turns(original.activeMessages(continuedRaw)))))
  await test.client.session.update({ sessionID: continued.id, metadata: JSON.parse(JSON.stringify({ [KEY]: continuedPolicy })) })
  await test.client.session.synthetic({ sessionID: continued.id, text: "BACKGROUND_RESULT_BEFORE_UPGRADE" })
  await test.client.session.wait({ sessionID: continued.id }, { signal: AbortSignal.timeout(45000) })
  const previousOutcome = (await test.client.session.get({ sessionID: continued.id })).outcome
  for (const entry of test.config.plugins) if (typeof entry !== "string") entry.package = path.join(test.repo, "src")
  Object.assign(test.config, { experimental: { ...test.config.experimental, media_blob: true } })
  await writeFile(test.configPath, JSON.stringify(test.config))
  await test.restart(newHost)
  const continuedRemote = remoteHost(test.client, continued.id)
  const continuedInitial = await continuedRemote.load()
  const continuedController = new Controller(continuedRemote.host, continued.id, settings(continuedInitial.settings), continuedRemote.artifacts)
  assert.deepEqual((await continuedController.load()).policy, continuedPolicy)
  await test.client.session.synthetic({ sessionID: continued.id, text: "CONTINUE_AFTER_UPGRADE" })
  await test.client.session.wait({ sessionID: continued.id }, { signal: AbortSignal.timeout(45000) })
  assert.equal((await test.client.session.get({ sessionID: continued.id })).outcome, "succeeded")
  assert.match(JSON.stringify(test.requests.at(-1)), /BACKGROUND_RESULT_BEFORE_UPGRADE/)
  assert.match(JSON.stringify(test.requests.at(-1)), /Tool output pruned/)
  await continuedController.restoreRanges([continuedPolicy.operations[0].sourceIDs])
  await test.client.session.synthetic({ sessionID: continued.id, text: "VERIFY_RESTORED_PREFIX" })
  await test.client.session.wait({ sessionID: continued.id }, { signal: AbortSignal.timeout(45000) })
  assert.equal((await test.client.session.get({ sessionID: continued.id })).outcome, "succeeded")
  assert.match(JSON.stringify(test.requests.at(-1)), /HEAD_FIXTURE/)
  assert.match(JSON.stringify(test.requests.at(-1)), /BACKGROUND_RESULT_BEFORE_UPGRADE/)
  assert.equal(hash((await test.client.session.context({ sessionID: continued.id })).slice(0, continuedNative.length)), hash(continuedNative))
  await continuedController.dispose()
  await continuedRemote.close()
  checks.push(`saved final-turn pruning followed by synthetic continuation (${previousOutcome} on baseline) survives upgrade without ledger repair; next request and restoration preserve the result`)
  const remote = remoteHost(test.client, session.id)
  const inspected = await remote.load()
  const controller = new Controller(remote.host, session.id, settings(inspected.settings), remote.artifacts)
  const loaded = await controller.load()
  assert.equal(loaded.blocks[0].kind, "compact")
  assert.deepEqual(loaded.policy, policy)
  assert.equal(historyHash(normalize.transcriptView(session, before)), historyHash(loaded.raw))
  const forked = await test.client.session.fork({ sessionID: session.id })
  const forkRemote = remoteHost(test.client, forked.id)
  const forkInitial = await forkRemote.load()
  const forkController = new Controller(forkRemote.host, forked.id, settings(forkInitial.settings), forkRemote.artifacts)
  const forkView = await forkController.load()
  assert.equal(forkView.blocks[0].kind, "compact")
  await forkController.restoreRanges([forkView.blocks[0].sourceIDs])
  const forkExpanded = await forkController.load()
  assert.equal(forkExpanded.blocks[0].reasonPruned, true)
  assert.equal((await test.client.session.context({ sessionID: forked.id })).filter(message => message.type === "user").flatMap(message => message.files ?? [])[0].data, firstUser.files[0].data)
  await test.client.session.prompt({ sessionID: forked.id, text: "Verify blob-backed fork media after expansion" })
  await test.client.session.wait({ sessionID: forked.id }, { signal: AbortSignal.timeout(45000) })
  assert.equal((await test.client.session.get({ sessionID: forked.id })).outcome, "succeeded")
  const forkWire = JSON.stringify(test.requests.at(-1)!.messages)
  assert.equal(forkWire.split(syntheticImage.uri).length - 1, 2, "Both hydrated user and tool media must reach the fork's provider")
  assert.doesNotMatch(forkWire, /(?:FAILED|INTERRUPTED)_REASONING_MUST_STAY_OMITTED/)
  assert.deepEqual((await controller.load()).policy, policy)
  await forkController.dispose()
  await forkRemote.close()
  const send = async (text: string) => {
    await test.client.session.prompt({ sessionID: session.id, text })
    await test.client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(45000) })
    assert.equal((await test.client.session.get({ sessionID: session.id })).outcome, "succeeded")
    const wire = JSON.stringify(test.requests.at(-1))
    assert.doesNotMatch(wire, /(?:FAILED|INTERRUPTED)_REASONING_MUST_STAY_OMITTED/)
    return wire
  }
  assert.match(await send("First request after upgrade"), /UPGRADE_SAVED_SUMMARY/)
  await controller.restoreRanges([loaded.blocks[0].sourceIDs])
  const pruned = await controller.load()
  assert.equal(pruned.blocks[0].reasonPruned, true)
  assert.equal(historyHash(pruned.blocks[0].messages), prunedMessages)
  const wire = await send("First request after summary expansion")
  assert.ok(!wire.includes("UPGRADE_SAVED_SUMMARY") && !wire.includes("REASON_0") && wire.includes(JSON.stringify(savedOutput).slice(1, -1)))
  await controller.restoreRanges([pruned.blocks[0].sourceIDs])
  const restored = await send("First request after pruning restoration")
  assert.ok(restored.includes("REASON_0") && restored.includes("HEAD_0") && restored.includes("data:image/png;base64,"))
  const current = await test.client.session.context({ sessionID: session.id })
  assert.equal(historyHash(normalize.transcriptView(session, before)), historyHash((await controller.load()).raw.slice(0, before.length)))
  const snapshot = hash(current)
  await remote.close()
  await test.restart()
  assert.equal(hash(await test.client.session.context({ sessionID: session.id })), snapshot)
  checks.push(`unchanged ledger fingerprints, omitted failed reasoning, blob-backed fork media, same-model continuation, layered restoration and restart on ${test.hostVersion}`)
  passed = true
} finally {
  await test.close({ passed, checks })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
