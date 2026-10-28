import assert from "node:assert/strict"
import { Controller } from "../src/controller.ts"
import { remoteHost } from "../src/control.ts"
import { settings } from "../src/config.ts"
import { hash } from "../src/fingerprint.ts"
import { fixture } from "./host-fixture.ts"
import { deferred } from "../test/async.ts"

const test = await fixture(process.argv[2], undefined, { subagents: true })
const gates = [deferred<void>(), deferred<void>()]
const children: string[] = []
const checks: string[] = []
let parent = ""
let step = 0
let passed = false
let cm: Controller | undefined
const controller = async () => {
  const remote = remoteHost(test.client, parent)
  const initial = await remote.load()
  return new Controller(remote.host, parent, settings(initial.settings), remote.artifacts)
}
test.respond((wire, scope) => {
  if (scope.parentID === parent) {
    const index = JSON.stringify(wire.messages).includes("CHILD_TWO_TASK") ? 1 : 0
    children[index] = scope.sessionID
    return { text: `CHILD_COMPLETION_${index + 1}`, finish: "stop", pause: gates[index].promise }
  }
  if (scope.sessionID !== parent) return undefined
  const current = step++
  if ([0, 4, 6].includes(current)) return { tool: { name: "fixture_tool", input: {} } }
  if (current === 1 || current === 2) return { tool: { name: "subagent", input: { agent: "fixture-worker", description: `Background child ${current}`, prompt: current === 1 ? "CHILD_ONE_TASK" : "CHILD_TWO_TASK", background: true } } }
  return "PARENT_FINISHED"
})
try {
  parent = (await test.client.session.create({ location: { directory: test.project }, title: "Background continuation", model: { providerID: "fixture", id: "fixture" } })).id
  cm = await controller()
  await test.client.session.prompt({ sessionID: parent, text: "Run two background children and finish the primary work" })
  await test.client.session.wait({ sessionID: parent }, { signal: AbortSignal.timeout(60000) })
  await test.until(() => children.filter(Boolean).length === 2, "two child responses paused")
  assert.equal((await test.client.session.get({ sessionID: parent })).outcome, "succeeded")
  for (const id of children) assert.equal((await test.client.session.context({ sessionID: id })).some(m => m.type === "idle"), false)
  const original = await test.client.session.context({ sessionID: parent })
  const originalHash = hash(original)
  const requests = () => test.calls.filter(call => call.scope.sessionID === parent)
  const originalTool = requests().at(-1)!.wire.messages.find(m => m.role === "tool")!.content
  const before = await cm.load()
  const ids = before.blocks.flatMap(b => b.sourceIDs)
  const count = requests().length
  await cm.prune(ids)
  assert.equal(requests().length, count)
  assert.equal(hash(await test.client.session.context({ sessionID: parent })), originalHash)
  const saved = (await cm.load()).policy
  const stale = await cm.prepareRestore([ids])
  checks.push("idle primary with two running background children accepts large-tool pruning without changing native history")
  for (let index = 0; index < gates.length; index++) {
    const start = requests().length
    gates[index].resolve()
    await test.client.session.wait({ sessionID: children[index] }, { signal: AbortSignal.timeout(60000) })
    await test.until(() => requests().length >= start + 2, "automatic parent continuation and next tool step")
    await test.client.session.wait({ sessionID: parent }, { signal: AbortSignal.timeout(60000) })
    assert.equal((await test.client.session.get({ sessionID: parent })).outcome, "succeeded")
    const next = requests()[start].wire
    assert.match(String(next.messages.find(m => m.role === "tool")!.content), /middle omitted from tool output/)
    for (let child = 0; child <= index; child++) assert.equal(next.messages.filter(m => m.role === "user" && JSON.stringify(m.content).includes(`CHILD_COMPLETION_${child + 1}`)).length, 1)
    assert.deepEqual((await cm.load()).policy, saved)
    const history = await test.client.session.context({ sessionID: parent })
    const tool = history.flatMap(m => m.type === "assistant" ? m.content : []).findLast(p => p.type === "tool" && p.name === "fixture_tool")!
    assert.ok(tool.type === "tool" && tool.state.status === "completed")
    assert.equal(requests()[start + 1].wire.messages.filter(m => m.role === "tool").at(-1)!.content, tool.state.content.map(p => p.type === "text" ? p.text : "").join("\n"), "new tool result is outside the old prune")
    assert.equal(hash(history.slice(0, original.length)), originalHash)
    assert.equal(history.filter(m => m.type === "user").length, 1, "no fabricated user turn")
    assert.equal(history.filter(m => m.type === "synthetic").length, index + 1)
    checks.push(`background completion ${index + 1} resumes the same primary successfully; old prune persists, new input/tool output remains intact`)
  }
  await assert.rejects(cm.applyOperations(stale.operations, stale), /changed/)
  await cm.dispose()
  await test.restart()
  cm = await controller()
  assert.deepEqual((await cm.load()).policy, saved)
  await test.client.session.synthetic({ sessionID: parent, text: "AFTER_RESTART" })
  await test.client.session.wait({ sessionID: parent }, { signal: AbortSignal.timeout(60000) })
  assert.equal((await test.client.session.get({ sessionID: parent })).outcome, "succeeded")
  const retained = requests().at(-1)!.wire.messages
  assert.match(String(retained.find(m => m.role === "tool")!.content), /middle omitted from tool output/)
  await cm.restoreRanges([ids])
  await test.client.session.synthetic({ sessionID: parent, text: "AFTER_RESTORE" })
  await test.client.session.wait({ sessionID: parent }, { signal: AbortSignal.timeout(60000) })
  assert.equal((await test.client.session.get({ sessionID: parent })).outcome, "succeeded")
  const restored = requests().at(-1)!.wire.messages
  assert.equal(restored.find(m => m.role === "tool")!.content, originalTool)
  for (const marker of ["CHILD_COMPLETION_1", "CHILD_COMPLETION_2", "AFTER_RESTART", "AFTER_RESTORE"]) assert.equal(restored.filter(m => m.role === "user" && JSON.stringify(m.content).includes(marker)).length, 1)
  assert.equal(hash((await test.client.session.context({ sessionID: parent })).slice(0, original.length)), originalHash)
  checks.push("private restart preserves the saved prune; stale restoration is rejected and fresh restoration keeps every later completion")
  passed = true
} finally {
  gates.forEach(gate => gate.resolve())
  await cm?.dispose()
  await test.close({ passed, checks })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
