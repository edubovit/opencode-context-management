/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js"
import type { InspectorUI } from "./ui.ts"
import type { distribution } from "./metrics.ts"
import { breakdown, compactCount, meter, type budgetView } from "./inspector-view.ts"

export function ContextOverview(props: {
  api: InspectorUI
  budget: ReturnType<typeof budgetView>
  counts: ReturnType<typeof distribution>
  width: number
  selected: boolean
}) {
  const theme = () => props.api.theme
  const ratio = () => props.budget.tokens !== undefined && props.budget.threshold !== undefined ? props.budget.tokens / props.budget.threshold : undefined
  const color = () => (ratio() ?? 0) > 1 ? theme().text.feedback.error.base : (ratio() ?? 0) >= 0.85 ? theme().text.feedback.warning.base : theme().text.feedback.info.base
  return <box id="cm-overview" flexDirection="column" flexShrink={0}>
    <text height={1} fg={theme().text.muted}>{props.budget.label}</text>
    <Show when={props.budget.tokens !== undefined} fallback={<text height={2} fg={theme().text.muted}>No request estimate yet</text>}>
      <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
        <text id="cm-guard-count" fg={color()}>{`≈${compactCount(props.budget.tokens!)}${props.budget.threshold !== undefined ? ` / ${compactCount(props.budget.threshold)}` : ""} tokens`}</text>
        <Show when={ratio() !== undefined}><text fg={color()}>{`${Math.round(ratio()! * 100)}%`}</text></Show>
      </box>
      <Show when={ratio() !== undefined}>
        <text id="cm-budget-meter" height={1} fg={color()}>{meter(props.budget.tokens!, props.budget.threshold!, Math.max(1, props.width - 2))}</text>
      </Show>
      <text height={1} wrapMode="none" truncate fg={theme().text.muted}>{props.budget.threshold !== undefined ? props.budget.label === "Live guard" ? "Cleanup threshold" : "Current cleanup threshold" : props.budget.note}</text>
      <text height={1} wrapMode="none" truncate fg={theme().text.muted}>{props.budget.source}</text>
    </Show>
    <text height={1} marginTop={1} fg={theme().text.muted}>{props.selected ? "Selected text" : "Text breakdown"}</text>
    <For each={breakdown(props.counts)}>{(row) => <box height={1} flexShrink={0} flexDirection="row" gap={1}>
      <text width={12} wrapMode="none" truncate fg={theme().text.base}>{row.label}</text>
      <text flexGrow={1} minWidth={0} wrapMode="none" truncate fg={theme().text.muted}>{meter(row.value, Math.max(1, props.counts.total), Math.max(1, props.width - 22))}</text>
      <text width={7} fg={theme().text.base}>{compactCount(row.value).padStart(7)}</text>
    </box>}</For>
    <Show when={!props.counts.total}><text height={1} fg={theme().text.muted}>No text yet</text></Show>
    <text height={1} marginTop={1} wrapMode="none" truncate fg={theme().text.muted}>{props.selected ? "No session overhead" : props.counts.unavailableCategories.length ? "Overhead incomplete" : "Media not counted"}</text>
  </box>
}
