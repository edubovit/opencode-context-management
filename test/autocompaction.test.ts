import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Autocompaction } from "../src/autocompaction.ts"
import { AUTO_KEY, inputBudget, type Strategy } from "../src/auto-state.ts"
import { settings, KEY } from "../src/config.ts"
import { Controller } from "../src/controller.ts"
import { append, historyHash, operation, readPolicy, turns } from "../src/context.ts"
import { Storage } from "../src/storage.ts"
import { controlClient, controlServer } from "../src/control.ts"
import { fixtureHost, pruneRule } from "./fixtures.ts"
import { contentTokens } from "../src/metrics.ts"

async function setup(t: { after(fn: () => Promise<void>): void }, selected: Strategy = "MANUAL") {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-auto-"))
  const fixture = fixtureHost()
  fixture.data.idle = false
  fixture.data.session.metadata![AUTO_KEY] = { strategy: selected }
  const config = settings({ autocompaction: { headroom: 160000 } })
  const store = new Storage(dir, dir)
  const auto = new Autocompaction(fixture.host, config, store)
  t.after(async () => { auto.close(); await new Promise((resolve) => setTimeout(resolve, 10)); await rm(dir, { recursive: true, force: true }) })
  const maintenance = new Controller({ ...fixture.host, auto, idle: async () => (await auto.state(fixture.data.session.id)).pause?.phase === "manual", update: (id, metadata, expected) => auto.commit(id, metadata, expected!) }, fixture.data.session.id, config, store)
  t.after(() => maintenance.dispose())
  return { ...fixture, auto, maintenance, store }
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)) }
  assert.fail("Autocompaction condition did not settle")
}

test("headroom uses explicit input once, otherwise context minus output, with invalid budgets rejected", () => {
  assert.deepEqual(inputBudget({ limit: { context: 400000, input: 272000, output: 128000 } }, 20000), { inputLimit: 272000, threshold: 252000, derived: false })
  assert.deepEqual(inputBudget({ limit: { context: 400000, output: 128000 } }, 20000), { inputLimit: 272000, threshold: 252000, derived: true })
  assert.equal(settings().autocompaction.headroom, 20000)
  assert.throws(() => settings({ autocompaction: { headroom: -1 } }), /integer/)
  assert.throws(() => inputBudget({ limit: { context: 20000, output: 5000 } }, 20000), /smaller/)
  assert.throws(() => inputBudget({ limit: { context: 0, output: 5000 } }, 20000), /valid model input/)
})

test("manual gate permits checked earlier-history edits, protects active turn and blocks high-context resume", async (t) => {
  const { data, auto, maintenance } = await setup(t)
  let resumed = false
  const waiting = auto.beforeRequest(data.messages).then(() => { resumed = true })
  await until(async () => !!(await auto.state(data.session.id)).pause)
  const pause = (await auto.state(data.session.id)).pause!
  await assert.rejects(auto.command(data.session.id, { action: "resume", pauseID: pause.id }), /Resume blocked/)
  const loaded = await maintenance.load()
  await assert.rejects(maintenance.prune(loaded.blocks[2].sourceIDs), /protected/)
  await assert.rejects(maintenance.summarize("compact", loaded.blocks[2].sourceIDs), /protected/)
  assert.equal(data.calls.length, 0)
  const forged = append(loaded.policy, operation("tool-prune", [loaded.blocks[2]], loaded.pruneRule))
  await assert.rejects(auto.commit(data.session.id, { ...data.session.metadata, [KEY]: forged }, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }), /protected/)
  const draft = await maintenance.summarize("brief", loaded.blocks.slice(0, 2).flatMap((block) => block.sourceIDs))
  await maintenance.apply(draft, "Earlier work retained.")
  assert.equal(resumed, false)
  await auto.command(data.session.id, { action: "resume", pauseID: pause.id })
  await waiting
  assert.equal(resumed, true)
  assert.equal((await auto.state(data.session.id)).pause, undefined)
  assert.equal(data.messages.filter((message) => message.info.role === "user").length, 3)
})

for (const mode of ["AUTO_PER_TURN", "AUTO_SESSION"] as const) test(`${mode} reduces only older history and resumes automatically`, async (t) => {
  const { data, auto } = await setup(t, mode)
  const last = structuredClone(data.messages.slice(-2))
  await auto.beforeRequest(data.messages)
  const policy = readPolicy(data.session)
  assert.equal(policy.cursor, mode === "AUTO_PER_TURN" ? 2 : 1)
  assert.ok(policy.operations.every((op) => !op.sourceIDs.includes(last[0].info.id)))
  assert.deepEqual(data.messages.slice(-2), last)
  assert.equal((await auto.state(data.session.id)).pause, undefined)
  assert.equal(data.jobs, data.removed.length)
})

test("non-reducing results are skipped, every USER tried once, one fallback, then manual pause", async (t) => {
  const { data, auto } = await setup(t, "AUTO_PER_TURN")
  data.responses = Array(6).fill("padding ".repeat(30000))
  const waiting = auto.beforeRequest(data.messages).catch(() => {})
  await until(async () => (await auto.state(data.session.id)).pause?.message.includes("could not free") ?? false)
  assert.equal(data.calls.length, 6)
  assert.equal(readPolicy(data.session).cursor, 0)
  assert.equal((await auto.state(data.session.id)).pause?.phase, "manual")
  auto.cancel(data.session.id)
  await waiting
})

test("saving strategy does not run it; explicit Run does, and stale metadata never authorizes writes", async (t) => {
  const { data, auto } = await setup(t)
  const waiting = auto.beforeRequest(data.messages)
  await until(async () => !!(await auto.state(data.session.id)).pause)
  const pause = (await auto.state(data.session.id)).pause!
  await auto.command(data.session.id, { action: "strategy", strategy: "AUTO_SESSION" })
  assert.equal(data.calls.length, 0)
  await auto.command(data.session.id, { action: "run", pauseID: pause.id })
  await waiting
  assert.equal((await auto.state(data.session.id)).strategy, "AUTO_SESSION")
  data.session.metadata![AUTO_KEY] = { strategy: "MANUAL", pause }
  assert.equal((await auto.state(data.session.id)).pause, undefined)
  await assert.rejects(auto.command(data.session.id, { action: "resume", pauseID: pause.id }), /no longer active/)
  await assert.rejects(auto.commit(data.session.id, data.session.metadata!, { revision: readPolicy(data.session).revision, fingerprint: historyHash(data.messages) }), /no live suspension/)
})

test("external source changes block resume; explicit abort cancels the gate without a user message", async (t) => {
  const { data, auto } = await setup(t)
  const waiting = auto.beforeRequest(data.messages).catch((error: Error) => error)
  await until(async () => !!(await auto.state(data.session.id)).pause)
  const pause = (await auto.state(data.session.id)).pause!
  data.messages[0].parts = []
  await assert.rejects(auto.command(data.session.id, { action: "resume", pauseID: pause.id }), /source changed/)
  await auto.command(data.session.id, { action: "abort", pauseID: pause.id })
  assert.ok(await waiting instanceof Error)
  assert.deepEqual(data.aborted, [data.session.id])
})

test("helpers are excluded and the local control API rejects unauthenticated requests", async (t) => {
  const { data, auto } = await setup(t)
  for (const message of data.messages) message.info.agent = "context-manager-summarizer"
  await auto.beforeRequest(data.messages)
  assert.equal((await auto.state(data.session.id)).pause, undefined)
  const server = await controlServer(auto)
  t.after(async () => { server.close() })
  const response = await fetch(server.address.url, { method: "POST", body: "{}" })
  assert.equal(response.status, 403)
  assert.equal((await controlClient(server.address).state(data.session.id)).strategy, "MANUAL")
  assert.throws(() => controlClient({ url: "http://example.com/", token: "irrelevant" }), /loopback/)
  assert.equal(turns(data.messages).length, 3)
})

test("control transport preserves large Unicode summaries across request chunks", async (t) => {
  const text = "🧭漢字 café ".repeat(30000)
  let received: unknown
  const server = await controlServer({
    state: async () => ({ strategy: "MANUAL" }), command: async () => ({ strategy: "MANUAL" }),
    commit: async (_id, metadata) => { received = metadata.summary },
  })
  t.after(async () => { server.close() })
  await controlClient(server.address).commit("ses_fixture", { summary: text }, { revision: 0, fingerprint: "fixture" })
  assert.equal(received, text)
})

test("exactly at threshold does not pause; unknown or stale owner state grants no maintenance", async (t) => {
  const { host, data, auto, store } = await setup(t)
  const other = new Autocompaction(host, settings({ autocompaction: { headroom: 168000 - contentTokens(data.messages) } }), store)
  await other.beforeRequest(data.messages)
  assert.equal((await other.state(data.session.id)).pause, undefined)
  const waiting = auto.beforeRequest(data.messages).catch(() => {})
  await until(async () => !!(await auto.state(data.session.id)).pause)
  data.messages[0].parts = []
  assert.equal((await auto.state(data.session.id)).pause?.phase, "invalid")
  auto.cancel(data.session.id)
  await waiting
})

test("native revert and new pruning modes cannot bypass protected-turn suspension guards", async (t) => {
  const { data, auto, maintenance } = await setup(t)
  const rule = (await maintenance.load()).pruneRule
  data.session.metadata![KEY] = append(readPolicy(data.session), operation("tool-prune", [turns(data.messages)[2]], rule))
  const waiting = auto.beforeRequest(data.messages).catch(() => {})
  await until(async () => !!(await auto.state(data.session.id)).pause)
  for (const options of [{ reasoning: true }, { reasoning: true, tools: "all" as const }, { reasoning: true, tools: "delete" as const }])
    await assert.rejects(maintenance.prune(turns(data.messages)[2].sourceIDs, options), /protected/)
  data.session.revert = { messageID: data.messages[4].info.id }
  assert.equal((await auto.state(data.session.id)).pause?.phase, "invalid")
  auto.cancel(data.session.id)
  await waiting
})

test("checked control writes reject cursor rewinds and new unprune operations", async (t) => {
  const { data, auto } = await setup(t)
  data.idle = true
  const before = append(readPolicy(data.session), operation("tool-prune", [turns(data.messages)[0]], pruneRule()))
  data.session.metadata![KEY] = before
  const expected = { revision: before.revision, fingerprint: historyHash(data.messages) }
  const rewind = { ...before, revision: before.revision + 1, cursor: before.cursor - 1 }
  await assert.rejects(auto.commit(data.session.id, { ...data.session.metadata, [KEY]: rewind }, expected), /must append/)
  const unprune = append(before, { ...before.operations[0], id: "legacy_unprune", mode: "unprune" })
  await assert.rejects(auto.commit(data.session.id, { ...data.session.metadata, [KEY]: unprune }, expected), /final/)
  assert.deepEqual(readPolicy(data.session), before)
})

test("cancelling an AUTO request rejects late output, cleans its helper, and never applies it", async (t) => {
  const { data, host, auto } = await setup(t, "AUTO_SESSION")
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const generate = host.generate
  host.generate = async (...args) => { await barrier; return generate(...args) }
  const waiting = auto.beforeRequest(data.messages).catch(() => {})
  await until(() => data.jobs === 1)
  auto.cancel(data.session.id)
  await waiting
  release()
  await until(() => data.removed.length === 1)
  assert.equal(readPolicy(data.session).cursor, 0)
  assert.equal((await auto.state(data.session.id)).pause, undefined)
})

test("failed AUTO requests stay paused in the manual inspector without applying a candidate", async (t) => {
  const { data, host, auto } = await setup(t, "AUTO_SESSION")
  host.generate = async () => { throw new Error("Synthetic provider failure") }
  const waiting = auto.beforeRequest(data.messages).catch(() => {})
  await until(async () => (await auto.state(data.session.id)).pause?.message === "Synthetic provider failure")
  assert.equal((await auto.state(data.session.id)).pause?.phase, "manual")
  assert.equal(readPolicy(data.session).cursor, 0)
  auto.cancel(data.session.id)
  await waiting
})
