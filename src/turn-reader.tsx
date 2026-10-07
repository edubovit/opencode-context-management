/** @jsxImportSource @opentui/solid */
import type { InspectorUI } from "./ui.ts"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import type { Block } from "./context.ts"
import { turnView } from "./turn-view.ts"
import { Hotkeys } from "./tui-help.tsx"

export function TurnReader(props: { api: InspectorUI; block: Block; label: string; close: () => void }) {
  const content = turnView(props.block)
  const color = () => props.api.theme.current.textMuted ?? "#8daecc"
  let scroll: ScrollBoxRenderable | undefined
  useKeyboard((key) => {
    if (key.defaultPrevented || props.api.ui?.dialog?.open) return
    if (key.name === "escape") { key.preventDefault(); props.close(); return }
    if (!["up", "down", "left", "right", "pageup", "pagedown", "home", "end"].includes(key.name)) return
    key.preventDefault()
    if (key.name === "home") scroll?.scrollTo(0)
    else if (key.name === "end") scroll?.scrollTo(scroll.scrollHeight)
    else if (key.name === "pageup" || key.name === "pagedown") scroll?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport")
    else scroll?.scrollBy(key.name === "up" || key.name === "left" ? -10 : 10)
  })
  return <box width="100%" height="100%" flexDirection="column" overflow="hidden" padding={1}>
    <text height={1} wrapMode="none" truncate fg={props.api.theme.current.primary}>Turn reader · {props.label} · READ-ONLY</text>
    <text height={1} wrapMode="none" truncate>Snapshot: user message and final response only. Reasoning and tool activity hidden.</text>
    <box id="cm-turn-header-rule" width="100%" height={1} flexShrink={0} border={["top"]} borderStyle="single" borderColor={color()} />
    <scrollbox id="cm-turn-scroll" flexGrow={1} minHeight={0} ref={(value) => { scroll = value }} focused={!props.api.ui?.dialog?.open} contentOptions={{ flexDirection: "column" }}>
      <text height={1} flexShrink={0} fg={props.api.theme.current.primary}>USER</text>
      <text id="cm-turn-user" flexShrink={0} selectable wrapMode="word">{content.user}</text>
      <box id="cm-turn-message-rule" width="100%" height={1} flexShrink={0} border={["top"]} borderStyle="single" borderColor={color()} />
      <text height={1} flexShrink={0} fg={props.api.theme.current.primary}>ASSISTANT — FINAL RESPONSE</text>
      <text id="cm-turn-assistant" flexShrink={0} selectable wrapMode="word">{content.assistant}</text>
    </scrollbox>
    <box id="cm-turn-footer-rule" width="100%" height={1} flexShrink={0} border={["top"]} borderStyle="single" borderColor={color()} />
    <Hotkeys api={props.api} lines={[
      [{ key: "Arrows", label: "10 lines" }, { key: "PgUp/PgDn", label: "page" }, { key: "Home/End", label: "start/end" }, { key: "Esc", label: "back" }],
    ]} />
  </box>
}
