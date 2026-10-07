import { Plugin } from "@opencode/plugin/tui"
import { fixtureRpc } from "./rpc.ts"

export default Plugin.define({
  id: "context-manager-v2-fixture",
  async setup(ctx) {
    const remote = ctx.client.rpc(fixtureRpc)
    const options = { location: ctx.location ?? ctx.data.location.default() }
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{ id: "context-manager-v2-fixture", title: "Context manager V2 fixture", palette: true, slash: { name: "context-manager-v2-fixture" }, run: async () => { await remote.tui({ phase: "command" }, options); ctx.ui.toast.show({ message: "V2_COMMAND_OK", variant: "success" }) } }],
    }))
    await remote.tui({ phase: "ready" }, options)
    ctx.ui.toast.show({ message: "V2_SETUP_OK", variant: "success" })
    return async () => { await remote.tui({ phase: "cleanup" }, options) }
  },
})
