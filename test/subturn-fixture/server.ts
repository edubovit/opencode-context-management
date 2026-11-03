import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "context-manager-subturn-test-tools",
  async setup(ctx) {
    await ctx.tool.transform(tools => tools.add({
      name: "subturn_fixture", description: "Return bounded synthetic subturn padding", options: { codemode: false },
      input: {
        type: "object", properties: { marker: { type: "string" }, padding: { type: "integer", minimum: 0, maximum: 25000 } },
        required: ["marker", "padding"], additionalProperties: false,
      },
      execute: async input => {
        if (!input || typeof input !== "object" || !("marker" in input) || typeof input.marker !== "string" ||
            !("padding" in input) || typeof input.padding !== "number" || !Number.isInteger(input.padding) || input.padding < 0 || input.padding > 25000)
          throw new Error("Invalid synthetic subturn input")
        return { content: input.marker + " x".repeat(input.padding) }
      },
    }))
  },
})
