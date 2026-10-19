/** @jsxImportSource @opentui/solid */
import { inputBlocked, type InspectorUI } from "./ui.ts"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, Index, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { RangeRow } from "./range-rows.ts"

export function RangeList(props: {
  api: InspectorUI; rows: RangeRow[]; maxLines: number; selectedIndex: number; focused: boolean; onChange: (index: number) => void
}) {
  let scroll: ScrollBoxRenderable | undefined
  let reveal = true
  createEffect(() => { props.selectedIndex; props.rows; props.focused; props.maxLines; reveal = true; scroll?.requestRender() })
  const revealCursor = () => {
    if (!reveal || !scroll || !props.rows.length) return
    reveal = false
    const row = scroll.getRenderable(`cm-range-${props.selectedIndex}`)
    if (!row) return
    const top = row.y - scroll.content.y
    const height = scroll.viewport.height
    if (top < scroll.scrollTop || height < row.height) scroll.scrollTo(top)
    else if (top + row.height > scroll.scrollTop + height) scroll.scrollTo(top + row.height - height)
  }
  const pageIndex = (direction: -1 | 1) => {
    const row = scroll?.getRenderable(`cm-range-${props.selectedIndex}`)
    if (!row || !scroll) return props.selectedIndex + direction
    const target = row.y + direction * scroll.viewport.height
    let index = props.selectedIndex
    while (index + direction >= 0 && index + direction < props.rows.length) {
      index += direction
      const next = scroll.getRenderable(`cm-range-${index}`)
      if (!next || (direction > 0 ? next.y >= target : next.y <= target)) break
    }
    return index
  }
  useKeyboard((key) => {
    if (key.defaultPrevented || !props.focused || inputBlocked(props.api) || key.ctrl || key.meta || !props.rows.length) return
    const step = key.shift ? 5 : 1
    const next = key.name === "up" || key.name === "k" ? props.selectedIndex - step
      : key.name === "down" || key.name === "j" ? props.selectedIndex + step
      : key.name === "pageup" ? pageIndex(-1)
      : key.name === "pagedown" ? pageIndex(1)
      : key.name === "home" ? 0 : key.name === "end" ? props.rows.length - 1 : undefined
    if (next === undefined) return
    key.preventDefault()
    props.onChange(Math.max(0, Math.min(props.rows.length - 1, next)))
  })
  return <scrollbox id="cm-ranges" flexGrow={1} minHeight={0} focused={props.focused}
    ref={(value) => { scroll = value }} renderBefore={revealCursor} onSizeChange={() => { reveal = true }}
    contentOptions={{ flexDirection: "column", paddingRight: 1 }}>
    <Show when={!props.rows.length}><text fg={props.api.theme.text.muted}>No turns to show.</text></Show>
    <Index each={props.rows}>{(row, index) =>
      <box id={`cm-range-${index}`} maxHeight={props.maxLines} flexShrink={0} flexDirection="column" overflow="hidden"
        backgroundColor={props.selectedIndex === index ? props.api.theme.background.formfield.selected : undefined}
        onMouseUp={() => { if (props.focused && !inputBlocked(props.api)) props.onChange(index) }}>
        <box height={1} flexShrink={0} flexDirection="row" gap={1}>
          <text id={`cm-range-title-${index}`} flexGrow={1} minWidth={0} wrapMode="none" truncate
            fg={props.api.theme.text.formfield.state({ focused: props.focused && props.selectedIndex === index })}>{row().title}</text>
          <text id={`cm-range-size-${index}`} flexShrink={0} fg={props.api.theme.text.muted}>{row().size}</text>
        </box>
        <Show when={row().stats}>{(stats) => <text id={`cm-range-stats-${index}`} height={1} flexShrink={0} wrapMode="none" truncate fg={props.api.theme.text.muted}>{stats()}</text>}</Show>
        <box id={`cm-range-preview-${index}`} maxHeight={props.maxLines - (row().stats ? 2 : 1)} flexShrink={0} overflow="hidden">
          <text id={`cm-range-preview-text-${index}`} flexShrink={0} wrapMode="word" fg={props.api.theme.text.muted}>{row().preview}</text>
        </box>
      </box>
    }</Index>
  </scrollbox>
}
