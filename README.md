# OpenCode Context Manager

Choose what stays in your coding session's context. Prune reasoning or tool results, summarize selected turns, and expand summaries later—without deleting the stored conversation.

**Plugin 3.0.0 · OpenCode 2.0.24**. This is the OpenCode V2 port. V1 entrypoints and configuration instructions no longer apply.

## Features

- **Range-based editing:** select disjoint ranges, then choose reasoning removal, large/all tool-result pruning, whole-call deletion, or detailed/brief summaries.
- **Parallel summaries:** each range receives the same frozen effective background. Only a complete successful batch applies; retry just failed ranges.
- **Expandable summaries:** restore one pre-summary layer, retaining earlier pruning and nested summaries. No Undo, Redo or Unprune.
- **Fullscreen readers:** read turns and saved summaries. Edit summaries manually or with a model; model edits stay proposals until explicitly applied.
- **Local statistics:** token estimates, tool status, selected-range totals, and effective-context exports. Counting needs no model call.
- **Near-limit protection:** suspend before a main model request, reduce earlier history, and resume the same request without adding a user message. Choose MANUAL, AUTO_PER_TURN, or AUTO_SESSION per session.

Initial summaries apply automatically; inspect/edit/expand them afterward. Summarization uses your provider and can cost money. Each parallel range sends the full effective background. Token counts are estimates, summaries are lossy, and exports can contain sensitive content.

## Install

This is a **source-based, private package**, not a published npm plugin. Requires the local OpenCode **2.0.24** installation and npm. Development checks run on Node.js 22+; renderer tests use the bundled Bun runtime. OpenTUI's Node-backend engine warning on Node 22 does not apply to the bundled Bun renderer. Using its Node backend directly requires Node 26.4+.

1. From this repository:

   ```sh
   npm ci --ignore-scripts
   ```

   Keep optional platform dependencies. On Windows use `npm.cmd` if PowerShell blocks npm's shim.

2. Merge this into project or global `opencode.json(c)`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "compaction": { "auto": false },
     "plugins": [
       {
         "package": "file:///absolute/path/opencode-context-management/src",
         "options": {}
       }
     ]
   }
   ```

   The path is the **`src` directory**, not `server.ts` or `tui.tsx`. V2 discovers both entrypoints there and loads the TUI automatically. Do not add a duplicate TUI registration. Print a correctly escaped directory URL with:

   ```sh
   node --input-type=module -e "import {pathToFileURL} from 'node:url'; console.log(pathToFileURL(process.cwd()+'/src').href)"
   ```

3. Open a session and run **`/context-manager`**, or choose **Context manager** from the palette. V2 watches plugin/config changes. After changing dependencies, restart the background service and reconnect the terminal:

   ```sh
   opencode service restart
   ```

   This interrupts active work: finish or stop it first. Closing only the terminal does not restart V2's shared service.

The plugin does **not** rewrite host configuration. Explicit `compaction.auto: false` is required: native compaction runs before the context hook. While loaded, the plugin rejects native compaction requests; use its range actions instead of native `/compact`.

See [V2 plugin configuration](https://opencode.ai/v2/docs/plugins/) and [development checks](CONTRIBUTING.md). Full remote installation/artifact delivery is not supported end to end: RPC is remote-aware, but source entrypoints must be available to the terminal and exports/spills stay on the server.

## Controls and modes

Use **Space → move → Space** to close a range; repeat for more ranges. Press **c** to configure compaction: arrows navigate, Space toggles a mode, Enter runs, **m/t** selects model/effort, and Esc cancels. The initial mode is detailed summarization; choices last for that inspector.

| Mode | Effect |
| --- | --- |
| Prune reasoning | Remove reasoning parts; preserve prompts, calls and visible assistant text. |
| Prune tools (large) | Token-budgeted head + omission notice + tail. Preserve inputs and attachments. |
| Prune tools (all) | Replace completed/error results with `[Tool output pruned]`, including result attachments. Keep calls and inputs. |
| Prune tools (delete) | Remove entire calls and results. Requires reasoning removal. |
| Summarize (detailed) | Detailed replacement with at most one soft-size-review follow-up. |
| Summarize (brief) | Shorter, single-pass replacement. |

Reasoning removal combines with one tool mode. Summary modes cannot combine with pruning. Pruning makes no model call and never changes past tool execution or disables future tools.

- **Enter:** read a turn or summary. Readers exclude tool activity/reasoning and label unfinished answers.
- **Ctrl+E, then Ctrl+S:** preview and confirm summary expansion.
- **e/r** inside a summary: manual edit / model request. **Ctrl+S** saves, sends, or applies according to the current editor mode.
- **a:** save autocompaction strategy. **g:** retry failed batch jobs, or explicitly run AUTO while paused.
- **v/n:** detail view / token-character estimates. **Tab:** pane focus. **f:** reload. **o:** export. **?:** help.
- **Esc:** cancel an open range/editor or go back. A paused exit offers Stay, Resume only if within budget, or Abort.

Rows show USER/SUMMARY; host checkpoint context is labeled separately and is read-only. USER statistics distinguish tools, large-output eligibility, pruning, `no reason`, and `no tools`.

## Options

Options belong on the single server plugin entry. Unknown options are rejected. Defaults:

```jsonc
{
  "plugins": [{
    "package": "file:///absolute/path/opencode-context-management/src",
    "options": {
      "ui": { "maxLinesPerTurn": 4 },
      "autocompaction": { "headroom": 20000 },
      "spill": { "maxLines": 2000, "maxBytes": 51200, "headShare": 0.5 },
      "prune": { "threshold": 5000, "head": 1000, "tail": 1000 },
      "tokenizer": { "fallbackEncoding": "o200k_base", "overrides": {} }
    }
  }]
}
```

| Option | Meaning |
| --- | --- |
| `ui.maxLinesPerTurn` | Maximum lines per list entry; integer ≥3. Short entries shrink. |
| `autocompaction.headroom` | Pause above input capacity minus this nonnegative margin. Must leave a positive threshold; never changes output caps. |
| `spill.maxLines` / `maxBytes` | Fresh output limits; minimum 2 lines / 8 UTF-8 bytes. Full captured text is saved before previewing. |
| `spill.headShare` | `0.5` half head/half tail, `1` head only, `0` tail only. Notice/path are extra. |
| `prune.threshold` | Large mode affects only results strictly larger than this token count. |
| `prune.head` / `tail` | Nonnegative retained token budgets; sum must be below threshold. Non-saving changes are skipped. |
| `tokenizer.fallbackEncoding` | `o200k_base` or `cl100k_base`; fallback estimates are labeled. |
| `tokenizer.overrides` | Encoding per `providerID/modelID`, e.g. `{ "my-provider/my-model": "cl100k_base" }`. |

Helpers inherit the main session model/effort unless these optional defaults are set:

```json
"summarizer": { "providerID": "my-provider", "modelID": "my-model", "variant": "default" }
```

Set both model fields or neither. Inspector choices override defaults for that inspector, not the main session. Use a helper model large enough for the full background; nothing is silently dropped or switched. There is no `prune.unit`, `outputReserve`, or plugin-imposed output cap.

### Autocompaction

- **MANUAL** (default): pause for cleanup; resume only when the estimate fits.
- **AUTO_PER_TURN:** compact earlier USER turns oldest first, then try the earlier prefix once if necessary.
- **AUTO_SESSION:** compact the earlier prefix once.

Saving a strategy does not start work. Automatic candidates must save tokens; otherwise the session stays paused for manual recovery. All user inputs in the active V2 execution turn—including steered inputs—are protected. Queued inputs are not silently discarded. Oversized synthetic-only context without a USER turn is refused rather than dispatched or given an unsafe pause. Pause authority is in memory; after reload/restart an old saved pause notice cannot resume the old request.

## Upgrading and limits

**Version 3 is V2-only and writes policy format 7.** V1 formats 1–6 and inherited/forked ledgers are not automatically rebound to V2's changed transcript IDs/shapes. They are preserved and refused rather than reset. Keep your V1 backup/checkout for export in an isolated V1 setup; continue in a fresh V2 session with a reviewed handoff if needed. Do not mix V1/V2 writers or point V1 at V2-only configuration.

Native checkpoints are read-only; edit later USER turns. Historical tools still marked running/streaming must be settled by the host before editing. Opaque provider-executed results cannot be safely pruned; use a summary or whole-call deletion with reasoning instead. Errored reasoning that the host converted to visible text is also refused rather than guessed at. Signed/opaque reasoning, encrypted checkpoints and stateful provider transports are not universally validated.

Captures, spill files and exports live in `~/.local/state/opencode-context-manager/<project-hash>/` on the server. The ledger and strategy live in OpenCode session metadata. Control uses authenticated native RPC; V3 creates no local control port or `runtime.json` credential. Old V1 artifacts may remain.

Pruning is not secure erasure. Original history/spills remain, and disabling the plugin exposes original context again. Exports include the audit ledger, which can contain older summary revisions. No crash recovery for orphaned helper sessions, exact provider billing counts, or transactional protection against arbitrary external metadata writers is promised.
