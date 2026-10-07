import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"

export type InspectorUI = {
  app: { version: string }
  theme: { current: { primary: string | RGBA; text?: string | RGBA; textMuted: string | RGBA; background?: string | RGBA; backgroundElement?: string | RGBA } }
  mode: { push(name: string): () => void }
  ui: { toast(input: { message: string; variant: "warning" | "success" | "error" | "info" }): void; dialog: { readonly open: boolean; clear(): void } }
  route: { readonly current: { name: string; params?: Record<string, unknown> }; navigate(name: string, params: { sessionID: string }): void }
  event: { on(handler: (event: { id: string; metadata: Record<string, unknown> }) => void): () => void }
}

export function inspectorUI(ctx: Context): InspectorUI {
  return {
    app: ctx.app,
    theme: { get current() { return { primary: ctx.theme.hue.accent[500], text: ctx.theme.text.base, textMuted: ctx.theme.text.muted, background: ctx.theme.background.base, backgroundElement: ctx.theme.background.raised.base } } },
    mode: { push: (name) => ctx.keymap.mode.push(name) },
    ui: {
      toast: (input) => ctx.ui.toast.show(input),
      dialog: { get open() { return !["base", "context-manager"].includes(ctx.keymap.mode.current()) }, clear: () => ctx.ui.dialog.clear() },
    },
    route: {
      get current() {
        const route = ctx.ui.router.current()
        return route.type === "session" ? { name: "session", params: { sessionID: route.sessionID } } : route.type === "plugin" ? { name: route.name, params: route.data } : { name: "home" }
      },
      navigate: (name, params) => ctx.ui.router.navigate(name === "session" ? { type: "session", sessionID: params.sessionID } : { type: "plugin", name, data: params }),
    },
    event: { on: (handler) => ctx.data.on("session.metadata.updated", (event) => handler({ id: event.data.sessionID, metadata: event.data.metadata })) },
  }
}
