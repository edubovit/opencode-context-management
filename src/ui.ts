import type { Context } from "@opencode/plugin/tui/context"

export type InspectorUI = Pick<Context, "app" | "theme" | "keymap" | "ui" | "data">

export function inputBlocked(api: InspectorUI) {
  return !["base", "context-manager"].includes(api.keymap.mode.current())
}
