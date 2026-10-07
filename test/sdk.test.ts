import { test } from "node:test"
import assert from "node:assert/strict"
import { pluginHost } from "../src/host.ts"
import { mockContext } from "./host-mock.ts"
import { AGENT, EDIT_AGENT } from "../src/config.ts"

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
