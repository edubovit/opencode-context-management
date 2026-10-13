import { Plugin } from "@opencode/plugin"
import { writeFile } from "node:fs/promises"
import path from "node:path"

export default Plugin.define({
  id: "context-manager-revert-test-tools",
  async setup(ctx) {
    await ctx.tool.transform((tools) => tools.add({
      name: "revert_fixture_write", description: "Write the isolated snapshot fixture", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, options: { codemode: false },
      execute: async (input) => {
        await writeFile(path.join(ctx.location.directory, "revert-state.txt"), (input as { text: string }).text)
        return { content: "Isolated file written" }
      },
    }))
  },
})
