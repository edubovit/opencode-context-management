/** @jsxImportSource @opentui/solid */
import type { InspectorUI } from "./ui.ts"
import { COMPACTION_MODES, selectedModes, type Compaction } from "./compaction.ts"

export function CompactionMenu(props: { api: InspectorUI; value: Compaction; index: number; toggle: (index: number) => void }) {
  return <box id="cm-compaction-config" flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
    <text height={1} flexShrink={0} fg={props.api.theme.text.base}>Compaction configuration</text>
    <select id="cm-compaction-modes" options={COMPACTION_MODES.map((mode, index) => ({
      name: `${(index === 7 || index === 8) && props.value.kind !== "summary" ? "[-]" : selectedModes(props.value).includes(index) ? "[+]" : "[ ]"} ${mode.name}`, description: mode.description,
    }))} selectedIndex={props.index} onSelect={(index) => props.toggle(index)} showDescription={false} showScrollIndicator flexGrow={1} minHeight={0} />
    <text height={3} flexShrink={0} overflow="hidden" fg={props.api.theme.text.muted}>{(props.index === 7 || props.index === 8) && props.value.kind !== "summary" ? "Disabled: select detailed or brief summarization first." : COMPACTION_MODES[props.index].description}</text>
    <text height={2} flexShrink={0} overflow="hidden">{props.value.kind === "split" || props.value.kind === "merge" ? "No model call. Changes grouping, not stored history." : props.value.kind === "delete" ? "No model call. Stored history stays intact; Ctrl+E restores." : props.value.kind === "prune" ? "No model call. Ctrl+E restores the last pruning layer." : "Selected ranges run in parallel and autoapply together."}</text>
  </box>
}

export function SplitCount(props: { api: InspectorUI; value: string; change: (value: string) => void; focused: boolean; minimum: number; sourceMinimum: number }) {
  return <box id="cm-split-count" flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden" gap={1}>
    <text height={1} flexShrink={0} fg={props.api.theme.text.base}>Split into subturns</text>
    <text flexShrink={0} fg={props.api.theme.text.muted}>Desired count (whole number, at least 2)</text>
    <input id="cm-split-input" value={props.value} onInput={props.change} placeholder="e.g. 2" focused={props.focused} maxLength={16} />
    <text fg={props.api.theme.text.muted}>{`At split time: source ≥${props.sourceMinimum.toLocaleString()} tokens; each part ≥${props.minimum.toLocaleString()}. Count may be reduced to fit tool boundaries. No model call.`}</text>
  </box>
}
