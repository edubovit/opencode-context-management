import { test } from "node:test"
import assert from "node:assert/strict"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { sdkHost } from "../src/sdk-host.ts"
import { AGENT, EDIT_AGENT } from "../src/config.ts"
import { messages, model, session } from "./fixtures.ts"

test("SDK adapter sends metadata, deny-all helper permissions, model and variant through actual generated client", async () => {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = []
  const client = createOpencodeClient({ baseUrl: "http://fixture", fetch: async (input) => {
    const request = input instanceof Request ? input : new Request(input)
    const url = new URL(request.url)
    const body = request.method !== "GET" && request.method !== "DELETE" ? await request.json() as Record<string, unknown> : undefined
    calls.push({ path: url.pathname + url.search, method: request.method, body })
    let value: unknown = session()
    if (url.pathname === "/session/status") value = {}
    if (url.pathname === "/config") value = { agent: { [AGENT]: {} } }
    if (url.pathname === "/provider") value = { all: [{ id: "test", models: { model: model() } }, { id: "disconnected", models: { model: { ...model(), providerID: "disconnected" } } }], connected: ["test"] }
    if (url.pathname.endsWith("/message")) value = request.method === "GET" ? messages() : { info: messages()[1].info, parts: [{ type: "text", text: "Summary" }] }
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
  } })
  const host = sdkHost(client)
  await host.messages("ses_test")
  assert.ok(calls.at(-1)!.path.includes("limit=0"))
  await host.update("ses_test", { plugin: "state" })
  assert.deepEqual(calls.at(-1)!.body, { metadata: { plugin: "state" } })
  assert.equal(await host.idle("ses_test"), true)
  assert.equal(await host.configured(), true)
  assert.deepEqual((await host.models()).map((item) => item.providerID), ["test"])
  await host.createJob()
  assert.deepEqual(calls.at(-1)!.body?.permission, [{ permission: "*", pattern: "*", action: "deny" }])
  assert.equal(await host.generate("ses_test", { providerID: "test", modelID: "model", variant: "high" }, "input"), "Summary")
  assert.equal(calls.at(-1)!.body?.variant, "high")
  assert.equal(calls.at(-1)!.body?.agent, AGENT)
  await host.createJob("edit")
  assert.equal(calls.at(-1)!.body?.agent, EDIT_AGENT)
  assert.deepEqual(calls.at(-1)!.body?.metadata, { context_manager_job: true, context_manager_edit: true })
  await host.generate("ses_test", { providerID: "test", modelID: "model" }, "Only the applied summary", "edit")
  assert.equal(calls.at(-1)!.body?.agent, EDIT_AGENT)
})

test("summarizer errors omit response headers, cookies and raw provider metadata", async () => {
  const client = createOpencodeClient({ baseUrl: "http://fixture", fetch: async () => new Response(JSON.stringify({
    info: { ...messages()[1].info, error: {
      name: "APIError", data: {
        message: "Unsupported parameter: max_output_tokens", statusCode: 400, isRetryable: false,
        responseHeaders: { "set-cookie": "fixture-sensitive-cookie", authorization: "fixture-sensitive-header" },
        responseBody: "fixture-raw-body", metadata: { internal: "fixture-private-metadata" },
      },
    } },
    parts: [],
  }), { headers: { "content-type": "application/json" } }) })
  await assert.rejects(sdkHost(client).generate("ses_test", { providerID: "test", modelID: "model" }, "fixture"), (error: Error) => {
    assert.match(error.message, /APIError/)
    assert.match(error.message, /400/)
    assert.match(error.message, /Unsupported parameter: max_output_tokens/)
    assert.doesNotMatch(error.message, /fixture-sensitive|fixture-raw-body|fixture-private-metadata|set-cookie|responseHeaders/)
    return true
  })
})

test("provider-truncated output is rejected without recommending the removed reserve option", async () => {
  const client = createOpencodeClient({ baseUrl: "http://fixture", fetch: async () => new Response(JSON.stringify({
    info: { ...messages()[1].info, finish: "length" }, parts: [{ type: "text", text: "Truncated draft" }],
  }), { headers: { "content-type": "application/json" } }) })
  await assert.rejects(sdkHost(client).generate("ses_test", { providerID: "test", modelID: "model" }, "fixture"), (error: Error) => {
    assert.match(error.message, /host\/provider output limit/)
    assert.doesNotMatch(error.message, /outputReserve/)
    return true
  })
})
