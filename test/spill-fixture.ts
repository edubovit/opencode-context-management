import { tool, type Plugin } from "@opencode-ai/plugin"
const server: Plugin = async () => ({
  tool: {
    fixture_large: tool({ description: "Return a fixture-only large result", args: {}, execute: async () => "HEAD_FIXTURE" + "x".repeat(60000) + "TAIL_FIXTURE" }),
  },
})
export default { id: "context-manager-test-fixture", server }
