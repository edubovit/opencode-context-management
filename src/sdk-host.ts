import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { AGENT, EDIT_AGENT } from "./config.ts"
import type { Host } from "./controller.ts"
import type { AutoControl } from "./auto-state.ts"

export function sdkHost(client: OpencodeClient, auto?: AutoControl): Host {
  return {
    auto,
    session: async (sessionID) => (await client.session.get({ sessionID }, { throwOnError: true })).data!,
    messages: async (sessionID) => (await client.session.messages({ sessionID, limit: 0 }, { throwOnError: true })).data!,
    idle: async (sessionID) => {
      const pause = (await auto?.state(sessionID))?.pause
      if (pause) return pause.phase === "manual"
      const status = (await client.session.status({}, { throwOnError: true })).data?.[sessionID]
      return !status || status.type === "idle"
    },
    update: async (sessionID, metadata, expected) => {
      if (auto && expected) await auto.commit(sessionID, metadata, expected)
      else await client.session.update({ sessionID, metadata }, { throwOnError: true })
    },
    models: async () => {
      const result = (await client.provider.list({}, { throwOnError: true })).data!
      return result.all.filter((provider) => result.connected.includes(provider.id)).flatMap((provider) => Object.values(provider.models))
    },
    configured: async () => !!(await client.config.get({}, { throwOnError: true })).data?.agent?.[AGENT],
    createJob: async (purpose) => (await client.session.create({
      title: purpose === "edit" ? "Context manager summary edit" : "Context manager summary job",
      metadata: { context_manager_job: true, ...(purpose === "edit" ? { context_manager_edit: true } : {}) }, agent: purpose === "edit" ? EDIT_AGENT : AGENT,
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    }, { throwOnError: true })).data!.id,
    generate: async (sessionID, model, text, purpose) => {
      const result = (await client.session.prompt({
        sessionID, agent: purpose === "edit" ? EDIT_AGENT : AGENT, model: { providerID: model.providerID, modelID: model.modelID },
        variant: model.variant, parts: [{ type: "text", text }],
      }, { throwOnError: true })).data!
      if (result.info.error) {
        const { name, data } = result.info.error
        const status = "statusCode" in data && typeof data.statusCode === "number" ? `, HTTP ${data.statusCode}` : ""
        const message = "message" in data && typeof data.message === "string" ? `: ${data.message}` : ""
        throw new Error(`Summarizer failed (${name}${status})${message}`)
      }
      if (result.info.finish === "length") throw new Error("Summarizer reached the host/provider output limit. The plugin does not impose an output cap. Choose a model with more output capacity or review host/provider settings; the incomplete draft was not accepted.")
      return result.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n\n")
    },
    abort: async (sessionID) => { await client.session.abort({ sessionID }, { throwOnError: true }) },
    remove: async (sessionID) => { await client.session.delete({ sessionID }, { throwOnError: true }) },
  }
}
