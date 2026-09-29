import type { Plugin } from "@opencode-ai/plugin"
import { writeFile } from "node:fs/promises"

const server: Plugin = async () => ({
  config: async (config) => {
    config.mcp = {}
  },
  "chat.params": async (input, output) => {
    if (input.agent !== "context-manager-summarizer") return
    const destination = process.env.CONTEXT_MANAGER_LIVE_OBSERVATION
    if (!destination) throw new Error("Live fixture observation path not configured")
    if (input.model.providerID === "openai" && output.maxOutputTokens !== undefined)
      throw new Error("Regression: OpenAI output cap was reintroduced after provider handling")
    await writeFile(destination, JSON.stringify({ providerID: input.model.providerID, outputCapOmitted: output.maxOutputTokens === undefined }), { mode: 0o600 })
  },
})

export default { id: "context-manager-live-test-safety", server }
