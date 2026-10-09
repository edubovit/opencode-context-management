# OpenCode Context Manager

Choose what stays in your coding session's context. Prune reasoning or tool results, summarize selected turns, and expand summaries later—without deleting the stored conversation.

**Plugin 4.0.0 · OpenCode V2**.

## Features

- **Range-based editing:** select disjoint ranges, then choose reasoning removal, large/all tool-result pruning, whole-call deletion, or detailed/brief summaries.
- **Parallel summaries:** each range receives the same frozen effective background. Only a complete successful batch applies; retry just failed ranges.
- **Expandable summaries:** restore one pre-summary layer, retaining earlier pruning and nested summaries. No Undo, Redo or Unprune.
- **Fullscreen readers:** read turns and saved summaries. Edit summaries manually or with a model; model edits stay proposals until explicitly applied.
- **Local statistics:** token estimates, tool status, selected-range totals, and effective-context exports. Counting needs no model call.
- **Near-limit protection:** suspend before a model request and resume the same request after reduction. AUTO_PER_TURN is the default; subagents never require manual recovery. Last resort can summarize an unfinished-turn prefix while retaining the newest 20,000 estimated tokens.

Initial summaries apply automatically; inspect/edit/expand them afterward. Summarization uses your provider and can cost money. Each parallel range sends the full effective background. Token counts are estimates, summaries are lossy, and exports can contain sensitive content.

## Install

This is a **source-based, private package**, not a published npm plugin. Requires a compatible local OpenCode **V2 (2.0.24 or newer)** installation and npm. Dependency packages are pinned to **2.0.26** for reproducibility, independently of the host. Startup does not enforce an exact host version. Host API changes may require updates; a different patch or minor version alone does not block loading.

Validated against OpenCode **2.0.24, 2.0.25 and 2.0.26**, including the actual Windows terminal inspector, provider-usage accounting and subagents. See [validation details](CONTRIBUTING.md#version-400-validation).

Development checks run on Node.js 22+; renderer tests use the bundled Bun runtime. OpenTUI's Node-backend engine warning on Node 22 does not apply to the bundled Bun renderer. Using its Node backend directly requires Node 26.4+.

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

See [V2 plugin configuration](https://opencode.ai/v2/docs/plugins) and [development checks](CONTRIBUTING.md). Full remote installation/artifact delivery is not supported end to end: RPC is remote-aware, but source entrypoints must be available to the terminal and exports/spills stay on the server.

## Controls and modes

The inspector opens with a compact overview: aligned turn sizes, local/selected totals, a request-budget meter, and a small text breakdown. Selecting ranges switches the breakdown to selected text. Full counts, model/tokenizer identity, accounting details and warnings are under **v → Details**; they are not removed.

The meter is labeled **Last request guard** when historical and **Live guard** only during a pause. It compares estimated tokens with the cleanup threshold, not the model's full context window. Missing samples or changed models do not get an invented percentage. Below 80 columns, **Tab** switches between full-width panes.

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
- **v:** cycle Overview → Details → Content → Runtime. **n:** local token/character counts; the guard stays in tokens. **Tab:** switch panes. **f:** reload. **o:** export. **?:** help.
- **m/t:** choose summary model/effort from the main view or compaction menu.
- **Esc:** cancel an open range/editor or go back. A paused exit offers Stay, Resume only if within budget, or Abort.

Rows show USER/SUMMARY with compact, right-aligned sizes; filled circles and R labels mark selected ranges. Host checkpoint context is labeled separately and is read-only. Tool statistics distinguish large-output eligibility, pruning, removed tools/reasoning, and unfinished/protected turns. Exact numbers remain in Details and exports.

## Options

Options belong on the single server plugin entry. Unknown options are rejected. Defaults:

```jsonc
{
  "plugins": [{
    "package": "file:///absolute/path/opencode-context-management/src",
    "options": {
      "ui": { "maxLinesPerTurn": 4 },
      "autocompaction": { "headroom": 20000, "estimateMultiplier": 1.3, "lastResortKeepTokens": 20000 },
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
| `autocompaction.estimateMultiplier` | Conservative uplift for unmeasured text: default `1.3`, finite number ≥1. Used for missing-usage fallback and as the minimum multiplier on new content. |
| `autocompaction.lastResortKeepTokens` | Newest conversation content exempt from last-resort compaction; nonnegative integer, default `20000`. Whole messages/tool pairs and existing summaries stay intact, so the actual retained tail can be larger. `0` permits summarizing the entire effective conversation. |
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

The safety guard is **provider-aware**, not the inspector's local content total. It uses the latest compatible reported input (including cached input once) and output/reasoning, plus estimated growth since that response. A high reported count can trigger cleanup even when the local tokenizer is below the threshold. The check runs before the next main request, including tool continuations—not in the middle of the response that supplies the usage.

Requests are paired with their reports using model/agent/configuration identity and native history fingerprints. After pruning, summaries or expansion, the guard recounts against that fixed baseline. New content is charged with at least the configured multiplier or the observed input/local ratio; removed content receives only its unscaled local estimate as credit. Unexplained provider overhead is retained, not silently declared freed. The same count governs pause, automatic candidates and resume.

The inspector shows **Live guard** while paused or **Last request guard** otherwise, separately from local categories and historical usage. `provider-matched` means a captured request/report pair; `provider-unpaired` is a conservative reconstruction for an existing session without a sample. Known later ledger edits are excluded from that historical reconstruction. `local-fallback` means no compatible report is available and uses the configured uplift. Helpers have independent accounting and fail before dispatch when their own capacity would be exceeded; they do not compact or pollute the parent's usage baseline.

Accounting survives restart. Model, variant, agent, configured route or tokenizer changes invalidate incompatible measurements; a changed model/provider configuration also prevents resuming a stale live pause. The files contain hashes/counts, not request text or credentials.

**This is still a forecast, not an exact provider count or a hard limit guarantee.** Reports describe earlier requests; changed text, later hooks, media and opaque state can differ. Image/PDF allowances are rough estimates. Unpaired reconstruction assumes normal operation timestamps/history ordering. Unknown residual overhead can prevent release after substantial cleanup; AUTO fails rather than forcing an oversized request through. Keep headroom, and increase `estimateMultiplier` if your unmeasured additions are consistently underestimated.

- **MANUAL:** pause for cleanup; resume only when the estimate fits. Available for top-level sessions only.
- **AUTO_PER_TURN** (default): compact earlier USER turns oldest first, then try the earlier prefix once if necessary.
- **AUTO_SESSION:** compact the earlier prefix once.

Saving a strategy does not start work. Ordinary cleanup protects the whole active execution turn, including steered inputs. If normal AUTO attempts cannot free enough space, **last resort** summarizes the largest safe prefix before the exempt tail, even within that unfinished turn. This is a plugin summary, not native OpenCode or provider-native compaction. Live system instructions/tool definitions and the exempt tail are unchanged. Original history remains stored; the saved checkpoint can be read, edited or expanded later when idle.

Last resort uses independent helpers and bounded chunk/merge passes when the selected prefix cannot fit one helper request. Only selected effective content is summarized; previous pruning stays in effect and unfinished work must not be presented as complete. Up to four rounds and 64 helper requests are allowed, so this can incur additional provider costs. It applies only a complete result that makes the guard fit. If the tail leaves no eligible prefix, the helper fails, or the result still does not fit, **AUTO ends with an error—never a manual recovery pause or silent oversized dispatch**. Use smaller tasks, a larger model, or a smaller retained tail where appropriate.

Subagents, including nested/background children, have separate ledgers and usage accounting. Fresh child sessions discard only verified ancestor-owned ledger copies; parent history and unrelated metadata are untouched. A child inheriting or selecting MANUAL uses AUTO_PER_TURN instead. Existing top-level MANUAL choices stay MANUAL. Hidden summarizer/editor helpers remain separate: they enforce their own capacity and do not recursively compact.

Queued inputs are not silently discarded. Oversized synthetic-only context without a USER turn is refused. Pause authority is in memory; after reload/restart an old saved pause notice cannot resume the old request. Stop/reload cancels last-resort work and prevents late application.

## Upgrading and limits

**Version 4 is V2-native.** Existing V2 ledgers in formats **7 and 8** remain readable, including nested summaries, revisions, pruning and partial-turn checkpoints. Reading does not rewrite stored metadata. The next ledger write upgrades to append-only **format 9**, without changing existing operations or their fingerprints. Exports use schema 4. Older plugin versions cannot read format 9: back up before upgrading and do not downgrade a modified session.

Formats 1–6, malformed ledgers and copied-history fork ledgers are preserved and refused, never silently reset. There is no V1 reader, character-pruning mode, Undo/Redo ledger cursor or Unprune implementation. Fresh child sessions are distinct from forks and get their own ledger.

Native checkpoints are read-only; edit later USER turns. Historical tools still marked running/streaming must be settled by the host before editing. Opaque provider-executed results cannot be safely pruned; use a summary or whole-call deletion with reasoning instead. Errored or interrupted reasoning that the host converted to visible text is also refused rather than guessed at. Signed/opaque reasoning, encrypted checkpoints and stateful provider transports are not universally validated.

Captures, spill files and exports live in `~/.local/state/opencode-context-manager/<project-hash>/` on the server. The ledger and strategy live in OpenCode session metadata. Control uses authenticated native RPC, with no separate control port or credential file.

Pruning is not secure erasure. Original history/spills remain, and disabling the plugin exposes original context again. Exports include the audit ledger, which can contain older summary revisions. No crash recovery for orphaned helper sessions, exact provider billing counts, or transactional protection against arbitrary external metadata writers is promised.
