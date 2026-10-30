/** @jsxImportSource @opentui/solid */
import type { InspectorUI } from "./ui.ts"
import { For } from "solid-js"

export type HotkeyLine = (string | { key: string; label: string })[]

export function Hotkeys(props: { api: InspectorUI; lines: HotkeyLine[] }) {
  return <box id="cm-hotkeys" flexDirection="column" height={props.lines.length + 1} flexShrink={0} paddingTop={1} overflow="hidden">
    <For each={props.lines}>{(line) => <text height={1} width="100%" wrapMode="none" truncate fg={props.api.theme.text.muted}>
      <For each={line}>{(hint, index) => <>
        {index() > 0 ? " · " : ""}
        {typeof hint === "string" ? hint : <><span style={{ fg: props.api.theme.text.action.primary.base }}>{hint.key}</span>{` ${hint.label}`}</>}
      </>}</For>
    </text>}</For>
  </box>
}

export const helpText = `RANGE MENU HOTKEYS

SELECT & REDUCE
Space starts/finishes a range; inside a closed range, removes it.
Arrows move the cursor. Esc cancels an open range, then returns.
c configures actions for selected ranges.
In configuration: arrows choose, Space toggles, Enter runs.
m/t selects the summary model/effort, also from the main view.
Reasoning combines with one tool mode. Tool deletion requires reasoning removal.
Reasoning pruning leaves failed/interrupted attempts untouched and prunes safe reasoning.
Summaries and Delete are standalone modes. Parallel summaries apply together.
Summary options: Isolated (head included) sends preceding context + selection;
Isolated (total) sends selection only. Both omit runtime/later background.
Isolation defaults off; toggle one option with Space after choosing a summary mode.
Delete removes each selected range entirely, leaving a zero-content DELETED row.
No model call for deletion/pruning. Stored history is unchanged.

READ & EXPAND
Enter reads the hovered USER or SUMMARY fullscreen.
Ctrl+E immediately restores one layer for each selected item; no confirmation.
Summaries expand first, retaining their prior pruning. Pruned turns restore
their latest pruning action; earlier layers stay applied. Combined tool/reasoning
pruning restores together. This also restores deleted calls and results.
DELETED ranges restore their prior turns, summaries and pruning in one step.
Restoration makes no model call and can increase context; resume stays budget-checked.
Readers: arrows move 10 lines; PageUp/PageDown: one screen.
Summary reader: e edits manually; r requests a model edit; Ctrl+S applies.
Model edits remain proposals until applied.

VIEWS & COUNTS
v cycles Overview → Details → Content → Runtime.
Details has full counts, tokenizer/model identity, usage and warnings.
n switches local token/character counts. The guard always uses tokens.
Tab switches panes; below 80 columns, shows one pane at a time.
The overview meter compares a request estimate to the cleanup threshold.
Last request is historical, not a recount. Live guard is a held request.
Local text, provider usage and guard forecasts are different measures.
Counts are estimates; media and opaque overhead are not fully known.
f refreshes. o exports effective context. Exports can contain private data.
s browses subagents in a read-only observer; /context-agents opens it from a session.
The observer refreshes automatically. Esc leaves without stopping or resuming work.

AUTOMATIC CLEANUP
a saves a strategy without running it. g runs AUTO while paused.
Paused exit: s/Esc stays; r resumes only below threshold; a aborts.
Manual edits protect the active turn. AUTO last resort may summarize its prefix,
preserving the configured recent tail. Subagents cannot use MANUAL.
Incomplete batch: g retries failed ranges; m/t changes model/effort; Esc discards.
There is no global Undo/Redo or ledger rewind.`
