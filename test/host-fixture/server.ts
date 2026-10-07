import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "context-manager-test-tools",
  async setup(ctx) {
    await ctx.tool.transform((tools) => tools.add({
      name: "fixture_tool", description: "Return synthetic large output", input: { type: "object", properties: {} }, options: { codemode: false },
      execute: async () => ({ content: `HEAD_FIXTURE\n${"Synthetic tool line 0123456789\n".repeat(4000)}TAIL_FIXTURE` }),
    }))
  },
})
