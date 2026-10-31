import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "context-manager-idle-test",
  setup(ctx) {
    const injected = new Set<string>()
    ctx.session.hook("experimental.idle", async ({ sessionID }) => {
      if (injected.has(sessionID)) return
      const session = await ctx.session.get({ sessionID })
      if (!session.metadata?.fixture_idle_input) return
      injected.add(sessionID)
      await ctx.session.synthetic({ sessionID, text: "UNRELATED_IDLE_HOOK_INPUT" })
    })
  },
})
