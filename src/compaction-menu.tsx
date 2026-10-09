/** @jsxImportSource @opentui/solid */
import type { InspectorUI } from "./ui.ts"
import { COMPACTION_MODES, selectedModes, type Compaction } from "./compaction.ts"

export function CompactionMenu(props: { api: InspectorUI; value: Compaction; index: number; toggle: (index: number) => void }) {
  return <box id="cm-compaction-config" flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
    <text height={1} flexShrink={0} fg={props.api.theme.text.base}>Compaction configuration</text>
    <select id="cm-compaction-modes" options={COMPACTION_MODES.map((mode, index) => ({
      name: `${selectedModes(props.value).includes(index) ? "[+]" : "[ ]"} ${mode.name}`, description: mode.description,
    }))} selectedIndex={props.index} onSelect={(index) => props.toggle(index)} showDescription={false} showScrollIndicator flexGrow={1} minHeight={0} />
    <text height={3} flexShrink={0} overflow="hidden" fg={props.api.theme.text.muted}>{COMPACTION_MODES[props.index].description}</text>
    <text height={2} flexShrink={0} overflow="hidden">{props.value.kind === "prune" ? "Pruning is final in effective context. No model call." : "Selected ranges run in parallel and autoapply together."}</text>
  </box>
}
