/** @jsxImportSource @opentui/solid */
import type { InspectorUI } from "./ui.ts"
import { For } from "solid-js"

export type HotkeyLine = (string | { key: string; label: string })[]

export function Hotkeys(props: { api: InspectorUI; lines: HotkeyLine[] }) {
  return <box id="cm-hotkeys" flexDirection="column" height={props.lines.length + 1} flexShrink={0} paddingTop={1} overflow="hidden">
    <For each={props.lines}>{(line) => <text height={1} width="100%" wrapMode="none" truncate fg={props.api.theme.current.textMuted ?? "#8daecc"}>
      <For each={line}>{(hint, index) => <>
        {index() > 0 ? " · " : ""}
        {typeof hint === "string" ? hint : <><span style={{ fg: props.api.theme.current.primary }}>{hint.key}</span>{` ${hint.label}`}</>}
      </>}</For>
    </text>}</For>
  </box>
}
