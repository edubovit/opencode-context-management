/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { inputBlocked, type InspectorUI } from "./ui.ts"
import { Inspector } from "./inspector.tsx"
import { Controller } from "./controller.ts"
import { remoteHost } from "./control.ts"
import { settings, VERSION } from "./config.ts"
import { AUTO_KEY, type AutoControl, type AutoState } from "./auto-state.ts"

export default Plugin.define({
  id: "context-manager",
  setup(api) {
    const remotes = new Set<ReturnType<typeof remoteHost>>()
    const unregister = api.ui.router.register({
      name: "context-manager",
      render: ({ data: params }) => {
        const sessionID = typeof params?.sessionID === "string" ? params.sessionID : ""
        const [controller, setController] = createSignal<Controller>()
        const [error, setError] = createSignal("")
        let closed = false
        let remote: ReturnType<typeof remoteHost> | undefined
        onCleanup(() => {
          closed = true
          if (remote) {
            const current = remote
            void current.close().catch((error) => api.ui.toast.show({ message: String(error), variant: "warning" })).finally(() => remotes.delete(current))
          }
        })
        onMount(async () => {
          try {
            if (!sessionID) throw new Error("Open a session first")
            remote = remoteHost(api.client, sessionID)
            remotes.add(remote)
            const published = await remote.load()
            if (published.version !== VERSION) throw new Error("Server/TUI plugin versions differ. Reload the plugin and reconnect the terminal before changing context.")
            if (!closed) setController(new Controller(remote.host, sessionID, settings(published.settings), remote.artifacts))
          } catch (error) { if (!closed) setError(error instanceof Error ? error.message : String(error)) }
        })
        useKeyboard((key) => {
          if (!key.defaultPrevented && !inputBlocked(api) && !controller() && key.name === "escape") api.ui.router.navigate({ type: "session", sessionID })
        })
        return <Show when={controller()} keyed fallback={<text>{error() || "Loading context manager…"} · Esc back</text>}>
          {(value) => <Inspector api={api} sessionID={sessionID} controller={value} />}
        </Show>
      },
    })
    api.keymap.layer(() => ({ mode: "global", commands: [{
      id: "context-manager.open", title: "Context manager", group: "Session", palette: true, slash: { name: "context-manager" },
      run: () => {
        const current = api.ui.router.current()
        if (current.type !== "session") { api.ui.toast.show({ message: "Open a session first", variant: "warning" }); return }
        api.ui.dialog.clear()
        api.ui.router.navigate({ type: "plugin", name: "context-manager", data: { sessionID: current.sessionID } })
      },
    }] }))
    const unsubscribe = watchSuspensions(api, async (id) => remoteHost(api.client, id).host.auto)
    return async () => { unregister(); unsubscribe(); await Promise.allSettled([...remotes].map((remote) => remote.close())); remotes.clear() }
  },
})

export function watchSuspensions(api: InspectorUI, control: (sessionID: string) => Promise<AutoControl | undefined>) {
  const seen = new Map<string, string>()
  let closed = false
  const off = api.data.on("session.metadata.updated", (event) => {
    const { sessionID, metadata } = event.data
    const notice = (metadata?.[AUTO_KEY] as AutoState | undefined)?.pause
    if (!notice) { seen.delete(sessionID); return }
    if (closed || !["manual", "invalid"].includes(notice.phase) || seen.get(sessionID) === notice.id) return
    void (async () => {
      const state = await (await control(sessionID))?.state(sessionID)
      if (closed || state?.pause?.id !== notice.id || !["manual", "invalid"].includes(state.pause.phase) || seen.get(sessionID) === notice.id) return
      seen.set(sessionID, notice.id)
      const current = api.ui.router.current()
      if (current.type === "session" && current.sessionID === sessionID && !inputBlocked(api))
        api.ui.router.navigate({ type: "plugin", name: "context-manager", data: { sessionID } })
      else if (current.type !== "plugin" || current.name !== "context-manager") api.ui.toast.show({ message: `Session paused for context reduction: ${sessionID}. Open /context-manager in that session.`, variant: "warning" })
    })().catch(() => {})
  })
  return () => { closed = true; off(); seen.clear() }
}
