import assert from "node:assert/strict"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { fixture } from "./host-fixture.ts"
import { terminal } from "./terminal.ts"
import { remoteHost } from "../src/control.ts"
import { Controller } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { hash } from "../src/fingerprint.ts"
import { deferred } from "../test/async.ts"

const executable = process.argv[2]
const test = await fixture(executable, undefined, { subagents: true })
const summary = deferred<void>(), response = deferred<void>()
const checks: string[] = []
let passed = false, child = "", summarizing = false, responding = false
let tui: ReturnType<typeof terminal> | undefined
let remote: ReturnType<typeof remoteHost> | undefined
const snapshot = async (id: string) => ({ metadata: (await test.client.session.get({ sessionID: id })).metadata, messages: await test.client.session.context({ sessionID: id }) })
try {
  const parent = await test.client.session.create({ location: { directory: test.project }, title: "Subagent observation fixture", model: { providerID: "fixture", id: "fixture" } })
  child = (await test.client.session.create({ parentID: parent.id, title: "Observed worker", agent: "fixture-worker", model: { providerID: "fixture", id: "small" } })).id
  const nested = await test.client.session.create({ parentID: child, title: "Nested worker", agent: "fixture-worker", model: { providerID: "fixture", id: "fixture" } })
  test.respond((wire, scope) => {
    if (scope.parentID === child && scope.sessionID !== nested.id && JSON.stringify(wire.messages).includes("<selected_range_")) {
      summarizing = true
      return { text: `OBSERVED_SUMMARY ${"Relevant retained fact. ".repeat(100)}`, finish: "stop", pause: summary.promise }
    }
    if (scope.sessionID === child && JSON.stringify(wire.messages.at(-1)).includes("WAIT_ACTIVE")) {
      responding = true
      return { text: "OBSERVED_FINAL_RESULT", finish: "stop", pause: response.promise }
    }
    return "Completed fixture step"
  })
  await test.client.session.prompt({ sessionID: child, text: "BASELINE_FACT ".repeat(1000) })
  await test.client.session.wait({ sessionID: child }, { signal: AbortSignal.timeout(60000) })
  assert.equal((await test.client.session.get({ sessionID: child })).outcome, "succeeded")
  test.usage((_wire, scope) => scope.sessionID === child ? { input: 9800, output: 500 } : undefined)
  await test.client.session.prompt({ sessionID: child, text: "SECOND_STEP" })
  await test.client.session.wait({ sessionID: child }, { signal: AbortSignal.timeout(60000) })
  assert.equal((await test.client.session.get({ sessionID: child })).outcome, "succeeded")
  test.usage(() => undefined)
  await test.client.session.prompt({ sessionID: child, text: "WAIT_ACTIVE" })
  await test.until(() => summarizing, "child automatic helper paused")
  remote = remoteHost(test.client, child, true)
  const initial = await remote.load()
  assert.equal(initial.auto.pause?.phase, "auto")
  const controller = new Controller(remote.host, child, settings(initial.settings), remote.artifacts)
  const before = await snapshot(child), count = test.calls.length
  for (let i = 0; i < 3; i++) {
    const view = await controller.load()
    assert.equal(view.idle, false)
    assert.equal(view.auto?.pause?.phase, "auto")
    await assert.rejects(controller.restoreRanges([view.blocks[0].sourceIDs]), /read-only/)
  }
  assert.equal(hash(await snapshot(child)), hash(before))
  assert.equal(test.calls.length, count)
  const rootRemote = remoteHost(test.client, parent.id, true)
  const children = await rootRemote.children()
  assert.equal(children.items.find(item => item.id === child)?.status, "Compacting")
  assert.deepEqual((await remote.children()).items.map(item => item.id), [nested.id])
  await rootRemote.close()
  checks.push("read-only RPC observes the live AUTO gate without writes, helpers, cancellation or resume; nested list hides internal helpers")

  tui = terminal({ executable, url: test.url, project: test.project, sessionID: parent.id, env: test.env, output: path.join(test.root, "observation-tui.log") })
  const seen = (text: string) => test.until(async () => (await tui!.text()).includes(text), `observer UI: ${text}`)
  const keys = async (text: string) => { tui!.keys(text); await new Promise(resolve => setTimeout(resolve, 200)) }
  await seen("Subagent observation")
  await keys("/context-agents")
  await test.until(async () => /\/context-agents\s+Subagent contexts/.test(await tui!.text()), "observer command registered")
  await keys("\r")
  await seen("Compacting · Observed worker")
  await keys("s")
  await seen("Nested worker")
  await keys("\x1b")
  await seen("Compacting · Observed worker")
  await keys("\r")
  await seen("READ-ONLY")
  await seen("PAUSED (auto)")
  await keys("  cagmto\x05")
  await keys("v")
  await seen("LOCAL CONTEXT")
  await writeFile(path.join(test.root, "observation-auto.screen.txt"), await tui.text())
  assert.equal(hash(await snapshot(child)), hash(before))
  assert.equal(test.calls.length, count)
  checks.push("actual ConPTY discovers children, drills into nested children and browses AUTO context with mutation keys disabled")

  summary.resolve()
  await test.until(() => responding, "held request resumes and primary response pauses")
  await test.until(async () => !(await tui!.text()).includes("PAUSED (auto)"), "observer stays open after automatic cleanup")
  await seen("SUMMARY")
  const reduced = await snapshot(child), resumedCalls = test.calls.length
  await keys("\r")
  await seen("OBSERVED_SUMMARY")
  await keys("er\x13")
  assert.ok(!(await tui.text()).includes("MANUAL EDIT"))
  assert.equal(hash(await snapshot(child)), hash(reduced))
  await keys("\x1b")
  tui.resize(60, 24)
  await test.until(async () => {
    const lines = (await tui!.text()).split("\n").map(line => line.slice(0, 60))
    return lines.some(line => /^\s*(Selected|No selection)/.test(line)) && !lines.some(line => line.includes("─Details"))
  }, "narrow full-width observer repainted")
  await writeFile(path.join(test.root, "observation-narrow.screen.txt"), (await tui.text()).split("\n").map(line => line.slice(0, 60)).join("\n"))
  response.resolve()
  await test.client.session.wait({ sessionID: child }, { signal: AbortSignal.timeout(60000) })
  assert.equal((await test.client.session.get({ sessionID: child })).outcome, "succeeded")
  await seen("Idle · Observed worker")
  assert.equal(test.calls.length, resumedCalls)
  await keys("\x1b")
  await seen("Subagent contexts")
  await keys("\x1b")
  await seen("Subagent observation")
  assert.equal(await tui.close(), 0)
  tui = undefined
  await controller.dispose()
  checks.push("observer auto-refreshes summary and running-to-idle state, reads summary without editing, and exits without stopping the child")
  for (let i = 0; i < 51; i++) await test.client.session.create({ parentID: parent.id, title: `Page child ${i}`, agent: "fixture-worker" })
  const browser = remoteHost(test.client, parent.id, true)
  const firstPage = await browser.children()
  assert.equal(firstPage.items.length, 50)
  assert.ok(firstPage.next)
  const secondPage = await browser.children(firstPage.next)
  assert.equal(secondPage.items.length, 2)
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map(item => item.id)).size, 52)
  assert.equal(secondPage.next, undefined)
  assert.equal(test.calls.length, resumedCalls)
  await browser.close()
  checks.push("native child pagination preserves parent filtering and reaches children beyond the first fifty without model requests")
  passed = true
} finally {
  summary.resolve(); response.resolve()
  if (tui) await tui.close()
  await remote?.close()
  await test.close({ passed, checks })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
