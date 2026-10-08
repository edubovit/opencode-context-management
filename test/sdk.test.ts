import { test } from "node:test"
import assert from "node:assert/strict"
import { pluginHost } from "../src/host.ts"
import { mockContext } from "./host-mock.ts"
import { AGENT, EDIT_AGENT, KEY } from "../src/config.ts"
import { AUTO_KEY } from "../src/auto-state.ts"
import { emptyPolicy, readPolicy } from "../src/context.ts"
import { nativeSession } from "./native-fixtures.ts"

test("V2 host creates owned deny-all helpers and separates admission, completion and text extraction", async () => {
  const mock = mockContext()
  const adapter = pluginHost(mock.context)
  const id = await adapter.host.createJob("summary", "ses_native")
  assert.equal(mock.state.created[0].agent, AGENT)
  assert.deepEqual(mock.state.created[0].permissions, [{ action: "*", resource: "*", effect: "deny" }])
  assert.equal(mock.state.created[0].parentID, "ses_native")
  assert.deepEqual(mock.state.created[0].metadata, { context_manager_job: true, context_manager_edit: false })
  assert.equal(await adapter.host.generate(id, { providerID: "fixture", modelID: "model", variant: "high" }, "Synthetic prompt"), "Answer only")
  assert.equal(mock.sessions.get(id)?.model?.variant, "high")
  assert.equal(adapter.owns(id, "ses_native"), true)
  assert.equal(adapter.owns(id, "ses_other"), false)
  await adapter.host.remove(id)
  await assert.rejects(adapter.host.remove("ses_native"), /Only owned/)
  await adapter.close()
})

test("V2 helpers reject provider failures and output truncation rather than applying partial text", async () => {
  const mock = mockContext()
  const adapter = pluginHost(mock.context)
  const id = await adapter.host.createJob("edit", "ses_native")
  assert.equal(mock.state.created[0].agent, EDIT_AGENT)
  mock.state.failure = true
  await assert.rejects(adapter.host.generate(id, { providerID: "fixture", modelID: "model" }, "Synthetic", "edit"), /rate-limit: Slow down/)
  mock.state.failure = false; mock.state.finish = "length"
  await assert.rejects(adapter.host.generate(id, { providerID: "fixture", modelID: "model" }, "Synthetic", "edit"), /output limit/)
  await assert.rejects(adapter.host.generate(id, { providerID: "fixture", modelID: "model" }, "Synthetic", "summary"), /not owned/)
  await adapter.close()
  assert.deepEqual(mock.state.removed, [id])
})

test("V2 cancellation during model selection cannot admit a late helper prompt", async () => {
  const mock = mockContext()
  const adapter = pluginHost(mock.context)
  const id = await adapter.host.createJob("summary", "ses_native")
  let release!: () => void
  mock.state.switchWait = new Promise<void>((resolve) => { release = resolve })
  const generation = adapter.host.generate(id, { providerID: "fixture", modelID: "model" }, "Must not be sent")
  await Promise.resolve()
  await adapter.host.abort(id)
  release()
  await assert.rejects(generation, /cancelled/)
  assert.equal(mock.state.prompts.length, 0)
  await adapter.close()
})

test("V2 host rejects moved sessions and exposes normalized model variants", async () => {
  const mock = mockContext()
  const adapter = pluginHost(mock.context)
  const models = await adapter.host.models()
  assert.equal(models[0].api.id, "api-model")
  assert.deepEqual(models[0].variants, { high: {} })
  mock.sessions.get("ses_native")!.location.directory = "/moved"
  await assert.rejects(adapter.host.session("ses_native"), /location changed/)
  await adapter.close()
  await assert.rejects(adapter.host.session("ses_native"), /unloaded/)
})

test("ordinary children and nested children isolate ancestor ledgers, strategy and pause metadata", async () => {
  const mock = mockContext()
  const parent = mock.sessions.get("ses_native")!
  parent.metadata = JSON.parse(JSON.stringify({ unrelated: "keep", [KEY]: emptyPolicy(parent.id), [AUTO_KEY]: { strategy: "MANUAL", pause: { id: "stale" } } }))
  const original = structuredClone(parent)
  mock.sessions.set("ses_child", { ...nativeSession("ses_child"), parentID: parent.id, metadata: structuredClone(parent.metadata) })
  mock.sessions.set("ses_nested", { ...nativeSession("ses_nested"), parentID: "ses_child", metadata: structuredClone(parent.metadata) })
  const adapter = pluginHost(mock.context)
  const children = await Promise.all([adapter.host.session("ses_child"), adapter.host.session("ses_child"), adapter.host.session("ses_nested")])
  for (const child of children) {
    assert.equal(readPolicy(child).sessionID, child.id)
    assert.equal(readPolicy(child).cursor, 0)
    assert.equal(child.metadata!.unrelated, "keep")
    assert.deepEqual(child.metadata![AUTO_KEY], { strategy: "AUTO_PER_TURN" })
    assert.ok(child.parentID)
  }
  assert.deepEqual(mock.sessions.get(parent.id), original)
  await adapter.close()
})

test("child initialization refuses unrelated/corrupt ledgers and never resets forks or own ledgers", async () => {
  const mock = mockContext()
  const adapter = pluginHost(mock.context)
  const metadata = (id: string) => JSON.parse(JSON.stringify({ [KEY]: emptyPolicy(id) }))
  mock.sessions.set("ses_child", { ...nativeSession("ses_child"), parentID: "ses_native", metadata: metadata("ses_unrelated") })
  await assert.rejects(adapter.host.session("ses_child"), /ancestors/)
  mock.sessions.get("ses_child")!.metadata = { [KEY]: { broken: true } }
  await assert.rejects(adapter.host.session("ses_child"), /Invalid inherited/)
  mock.sessions.set("ses_fork", { ...nativeSession("ses_fork"), fork: { sessionID: "ses_native", boundary: { type: "before", messageID: "msg_boundary" } }, metadata: metadata("ses_native") })
  assert.throws(() => readPolicy({ id: "ses_fork", nativeVersion: 2, metadata: mock.sessions.get("ses_fork")!.metadata }), /inherited/)
  await adapter.host.session("ses_fork")
  assert.deepEqual(mock.sessions.get("ses_fork")!.metadata, metadata("ses_native"))
  mock.sessions.get("ses_child")!.metadata = metadata("ses_child")
  assert.deepEqual((await adapter.host.session("ses_child")).metadata, metadata("ses_child"))
  await adapter.close()
})
