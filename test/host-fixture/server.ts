import { Plugin } from "@opencode/plugin"
import { syntheticImage } from "../media-fixture.ts"

export default Plugin.define({
  id: "context-manager-test-tools",
  async setup(ctx) {
    await ctx.tool.transform((tools) => tools.add({
      name: "fixture_tool", description: "Return synthetic output", input: { type: "object", properties: { small: { type: "boolean" }, image: { type: "boolean" } } }, options: { codemode: false },
      execute: async (input) => input && typeof input === "object" && "image" in input && input.image === true
        ? { content: [{ type: "text", text: "Synthetic screenshot attached." }, syntheticImage] }
        : { content: `HEAD_FIXTURE\n${"Synthetic tool line 0123456789\n".repeat(input && typeof input === "object" && "small" in input && input.small === true ? 100 : 4000)}TAIL_FIXTURE` },
    }))
  },
})
