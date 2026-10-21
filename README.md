# OpenCode Context Manager

Control what stays in an OpenCode session's model context. Prune reasoning or tool results, summarize or delete selected ranges, and restore them later without deleting the stored conversation.

This is a source-based OpenCode V2 plugin, not a published npm package. Summarization uses your provider and can cost money. Summaries are lossy, token counts are estimates, and pruning is not secure erasure.

## Install

Requires OpenCode **>=2.0.27 <3**, Node.js **22+**, and npm.

1. In the repository, install dependencies:

   ```sh
   npm ci --ignore-scripts
   ```

   Keep optional platform dependencies. On Windows, use `npm.cmd` if PowerShell blocks npm's shim. No build step is needed.

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

   Point to the **`src` directory**, not an entrypoint file. OpenCode discovers both server and terminal plugins there; do not register the terminal plugin separately. Generate an escaped directory URL from the repository:

   ```sh
   node --input-type=module -e "import {pathToFileURL} from 'node:url'; console.log(pathToFileURL(process.cwd()+'/src').href)"
   ```

3. Open a session and run **`/context-manager`**, or choose **Context manager** from the command palette.

**`compaction.auto: false` is required.** Native compaction runs before the plugin's context hook. The plugin does not rewrite your configuration and rejects native compaction while loaded; use its range actions instead of `/compact`. This setting does not disable the plugin's own automatic cleanup.

OpenCode watches plugin/config changes. Coordinate updates with active work; dependency updates require a service restart and terminal reconnect. If you develop the plugin, keep the live installation in a separate frozen clone. See [Contributing](CONTRIBUTING.md).

RPC supports remote connections, but installation and artifact delivery are not fully remote: source entrypoints must be available to the terminal, and exports/spills remain on the server. See [OpenCode plugin configuration](https://opencode.ai/v2/docs/plugins).

## Select and reduce context

Close a range with **Space → move → Space**. Repeat to select disjoint ranges. Press **c** to choose an action: arrows navigate, Space toggles, Enter runs, and Esc cancels. The initial action is detailed summarization.

| Action | Effect |
| --- | --- |
| Prune reasoning | Remove safe reasoning parts. Retain failed/interrupted attempts and visible assistant text. |
| Prune tools (large) | Keep a token-budgeted beginning and end with an omission notice. Preserve inputs and attachments. |
| Prune tools (all) | Replace completed/error results, including attachments, with `[Tool output pruned]`. Keep calls and inputs. |
| Prune tools (delete) | Remove entire tool calls and results. Requires reasoning pruning. |
| Summarize (detailed) | Create a detailed replacement, with at most one size-review follow-up. |
| Summarize (brief) | Create a shorter, single-pass replacement. |
| Delete | Remove the selected range from effective context and keep a selectable **DELETED** row for restoration. |

Reasoning pruning combines with one tool mode. Summary modes and Delete are standalone. Pruning, deletion and restoration make no model calls, do not change past tool execution, and do not disable future tools.

Failed or interrupted assistant attempts can contain reasoning that OpenCode treats as ordinary text. The plugin retains that ambiguous content while removing safe reasoning in the same turn. These turns use the normal **reasoning pruned** status; retained content still counts and remains available to summaries and exports.

Deleted ranges contribute no messages, placeholder text or local content tokens. They remain indivisible until restored. A wider deletion can contain prior summaries, pruning or deletions; an already-deleted-only selection is rejected without a write.

## Summaries and progress

Selected ranges generate in parallel from one frozen effective-context snapshot. **Only a complete successful batch applies**, in one checked write. If a range fails, successful drafts stay pending; **g** retries only failed ranges. Initial summaries apply automatically. Inspect, edit or restore them afterward.

The batch screen shows:

- Ready ranges out of the total.
- Each agent's status and elapsed time.
- Observed output and reasoning character counts while running.
- The accepted draft's character count when ready.

Live counts cover the helper conversation, including size-review prompts, but exclude input text. They are not tokens, billing, completion percentages or ETAs. Providers can buffer output or omit reasoning. Missing updates do not prove an agent is stuck; a progress-read failure does not stop generation or authorize applying a draft.

Helpers have no tools. Empty, failed, cancelled or incomplete output is rejected. If any assistant response to a helper prompt hits its output limit, a later successful continuation does not make it acceptable: the plugin neither assembles truncated chunks nor accepts only the continuation tail.

### Choose the helper's context

In **c**, select detailed or brief summarization and optionally toggle one isolation setting:

| Setting | Helper receives |
| --- | --- |
| Both off | Selected range, full effective history and captured runtime background. |
| Isolated summarization (head included) | Selected range and preceding effective history; no later history or runtime background. |
| Isolated summarization (total) | Only the selected range; no surrounding history or runtime background. |

The options are mutually exclusive, off by default, and unavailable for pruning/Delete. Switching detailed/brief preserves isolation; switching to another action clears it. These are inspector choices, not global options. Summarization instructions are always included.

Each range uses its own boundary against the frozen snapshot. Sibling summaries never become another helper's background. Retries and refinements keep the chosen scope.

**Manual summaries let the provider decide whether input fits.** The plugin does not veto user-started summaries, refinements or edits based on a local token estimate. Host/provider limits still apply. Without isolation, splitting the selection into smaller ranges does not shrink each helper's full background. Total isolation can help, but the selected range must still fit. Isolation does not reduce unselected main-session history or bypass Resume checks.

## Read, edit and restore

| Key | Action |
| --- | --- |
| Enter | Read the focused turn or summary. Readers omit tool activity/reasoning and label unfinished answers. |
| Ctrl+E | Immediately restore one layer for each selected item, without a preview or confirmation. |
| e / r in a summary | Edit manually / request a model-assisted edit. |
| Ctrl+S in an editor | Save, send or explicitly apply, according to the editor mode. |
| m / t | Choose summary model / effort. |
| a | Save the session's cleanup strategy; does not start work. |
| g | Retry failed batch ranges, or explicitly run AUTO while paused. |
| v | Cycle Overview → Details → Content → Runtime. |
| n | Switch local token/character counts; request guards stay in tokens. |
| Tab | Switch panes. Below 80 columns, panes use the full width. |
| f / o / ? | Reload / export / help. |
| Esc | Cancel the current selection, editor or running agents; otherwise go back. A paused exit offers Stay, Resume or Abort. |

Restoration is local to the selection:

- A summary expands to its pre-summary effective state, retaining any earlier pruning.
- A DELETED range restores its pre-deletion turns, summaries and pruning.
- A pruned ordinary turn restores its latest effective pruning action. Combined reasoning/tool pruning restores together; separate actions restore one layer at a time.
- Restore a summary or deleted range before restoring layers hidden inside it. Other turns remain unchanged, even if a pruning operation originally covered a wider range.

Restoration makes no model call and can increase context size. The normal Resume guard still applies. It cannot recover content removed by OpenCode or replace a stored spill preview with the full external output file.

Model-assisted summary editing starts a separate dialogue containing only the saved summary and edit request. Proposals require explicit application; they do not receive the original range or full session background.

## Automatic cleanup and request budgets

The plugin checks every main model request, including tool continuations. When the request exceeds its cleanup threshold, it holds that request rather than sending oversized context.

| Strategy | Behavior |
| --- | --- |
| AUTO_PER_TURN — default | Summarize earlier USER turns oldest first, then try the earlier prefix once. |
| AUTO_SESSION | Try the earlier prefix once. |
| MANUAL | Pause for cleanup; explicitly resume only when the estimate fits. Top-level sessions only. |

Normal cleanup protects the whole active execution turn, including steered inputs. If ordinary AUTO attempts cannot make the request fit, **last resort** summarizes the largest safe prefix before the retained tail, even within an unfinished turn. It preserves whole messages/tool pairs, existing summaries, live system instructions and tool definitions.

Last resort uses independent prefix-only helpers, with at most **four rounds and 64 requests**. It applies only a complete result that makes the request fit. If no safe prefix exists, generation fails, or the result is still too large, AUTO ends with an error—not a manual pause or an oversized dispatch. Smaller tasks, a larger model or a smaller retained tail may help.

Child sessions have independent ledgers and accounting. Inherited/selected MANUAL becomes AUTO_PER_TURN for children. Summary/edit helpers do not recursively compact. Automatic helpers enforce estimated input capacity; manual helpers leave capacity decisions to the provider.

Resume releases the **original held request**, without a fabricated continuation prompt. Stop, move, deletion, reload and unload revoke its authority. Saved pause notices cannot resume work after restart. Queued inputs are not silently discarded.

### Understand the numbers

The overview separates local text totals from the **Last request guard** or **Live guard** during a pause. The meter compares the forecast with the cleanup threshold, not the model's full context window. Missing samples or a changed model do not get an invented percentage. Details contains full accounting/model/tokenizer information.

Input capacity is a positive explicit input limit, or otherwise **context limit − output limit**. The cleanup threshold is **input capacity − headroom**; equality fits. The plugin preserves the host/provider output cap.

The guard uses compatible provider-reported usage plus estimated changes since that request. Added content receives a conservative multiplier; removed content receives only its unscaled local estimate as credit. Unexplained provider overhead is retained. The same estimate governs cleanup candidates and Resume.

- **provider-matched:** a captured outgoing request paired with its usage report.
- **provider-unpaired:** conservative reconstruction without a captured request sample.
- **local-fallback:** no compatible report; local estimates use the configured multiplier.

Model, variant, agent, tokenizer, route and provider/model compatibility changes invalidate incompatible measurements and stale pauses. Forks and reconciled native reverts measure their own subsequent requests rather than treating inherited usage as current.

These are forecasts, not exact provider counts. Images/PDFs use rough allowances; typed tool files are not counted as base64 prose. Genuine text/JSON/error payloads remain text-counted. Keep headroom: unknown overhead can prevent Resume even after substantial cleanup.

## Options

Set `options` on the plugin entry in project or global **`opencode.json(c)`**, not `cli.json`. Global configuration normally lives under `~/.config/opencode/`; `XDG_CONFIG_HOME` can change that root. Preserve unrelated providers, permissions and plugins when merging settings.

Every option is optional. `{}` uses the defaults below. Unknown keys and invalid values are rejected. Omitted fields keep their own defaults; they are not automatically adjusted to fit other overrides. Cleanup strategy is selected per session with **a**, not a configuration option.

### Complete configuration example

This includes every configurable parameter. Numeric values and fallback encoding are defaults. Replace the illustrative model IDs, or omit `summarizer` to inherit the main model/effort. Use an empty `overrides` object unless an explicit tokenizer mapping is needed.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": { "auto": false },
  "plugins": [
    {
      "package": "file:///absolute/path/opencode-context-management/src",
      "options": {
        "ui": { "maxLinesPerTurn": 4 },
        "autocompaction": {
          "headroom": 20000,
          "estimateMultiplier": 1.3,
          "lastResortKeepTokens": 20000
        },
        "spill": { "maxLines": 2000, "maxBytes": 51200, "headShare": 0.5 },
        "prune": { "threshold": 3000, "head": 1000, "tail": 500 },
        "tokenizer": {
          "fallbackEncoding": "o200k_base",
          "overrides": { "my-provider/my-model": "o200k_base" }
        },
        "summarizer": {
          "providerID": "my-provider",
          "modelID": "my-model",
          "variant": "default"
        }
      }
    }
  ]
}
```

### Layout and cleanup

| Parameter | Default | Meaning and constraint |
| --- | --- | --- |
| `ui.maxLinesPerTurn` | `4` | Integer ≥ 3. Maximum row height, including heading, status and preview. Does not truncate context. |
| `autocompaction.headroom` | `20000` | Integer ≥ 0, in estimated input tokens; must be smaller than input capacity. Larger values start cleanup earlier. |
| `autocompaction.estimateMultiplier` | `1.3` | Finite number ≥ 1. Conservative fallback/growth multiplier for main guards and automatic helpers, not a manual-summary veto. |
| `autocompaction.lastResortKeepTokens` | `20000` | Integer ≥ 0. Newest local tokens retained during emergency cleanup. Whole-message/tool-pair boundaries can make the tail larger. |

An observed provider/local ratio can exceed the configured multiplier. Setting it to `1` does not disable the guard. A retained tail of `0` requests no exempt tail; source, checkpoint and unsettled-tool safeguards still apply.

### New tool-output previews: `spill`

When a new successful tool result exceeds either limit, the plugin saves its full captured text to a server-local file and returns a bounded preview with that path. Non-text attachments remain intact.

| Parameter | Default | Meaning and constraint |
| --- | --- | --- |
| `spill.maxLines` | `2000` | Integer ≥ 2. Trigger and retained beginning/end line budget. |
| `spill.maxBytes` | `51200` | Integer ≥ 8. Trigger and retained beginning/end UTF-8 byte budget; 51200 is 50 KiB. |
| `spill.headShare` | `0.5` | Number from 0 through 1. Share of both budgets for the beginning; the rest goes to the end. |

Each section must fit both budgets. Notices and paths add overhead beyond them. Unicode characters are not split. These settings affect new results, not existing history. Restoring a later prune restores the stored preview, not the external file. Spill files older than seven days are cleaned on startup; they are not permanent archives.

### Existing tool-result pruning: `prune`

These settings apply only to **Prune tools (large)**, not all-output or whole-call deletion. Changing them does not run pruning.

| Parameter | Default | Meaning and constraint |
| --- | --- | --- |
| `prune.threshold` | `3000` | Integer ≥ 1. Only results strictly above this local-token count are eligible. |
| `prune.head` | `1000` | Integer ≥ 0. Maximum beginning tokens retained. |
| `prune.tail` | `500` | Integer ≥ 0. Maximum ending tokens retained. |

**`head + tail < threshold` is required.** With defaults, a result above 3,000 tokens keeps up to 1,000 beginning and 500 ending tokens, plus omission/path notices. Non-saving reductions are skipped. Lowering the threshold to `1500` also requires lowering head and/or tail.

Inputs and attachments stay intact. Saved operations pin their rule and tokenizer, so configuration changes do not reinterpret applied cuts. Ctrl+E restores one pruning layer.

### Tokenizer and summary model

| Parameter | Default | Meaning and constraint |
| --- | --- | --- |
| `tokenizer.fallbackEncoding` | `"o200k_base"` | `"o200k_base"` or `"cl100k_base"`; used when no override or built-in model mapping applies. |
| `tokenizer.overrides` | `{}` | Exact `"providerID/modelID"` keys mapped to either supported encoding; overrides built-in mappings. |
| `summarizer.providerID` | Inherit main provider | Nonempty available provider ID; supply together with `modelID`. |
| `summarizer.modelID` | Inherit main model | Nonempty model ID under that provider; supply together with `providerID`. |
| `summarizer.variant` | Inherit effort with main model; otherwise helper model's default | `"default"` or a variant supported by the selected model. |

Tokenizer overrides change local estimates and pruning, not real model capacity or the provider's tokenizer. Pruning uses the consuming main model's basis; helpers may use another encoding.

Omit `summarizer` or use `{}` to follow the main model and effort. A dedicated helper model without a variant uses its own default, not the main model's effort. You may set only `variant`; `"default"` explicitly selects the model default. Inspector **m/t** choices override these settings locally without rewriting configuration or switching the main model.

Model IDs select existing OpenCode models; they do not configure providers, credentials or output limits. Choose sufficient input capacity for the selected helper scope.

## Forking sessions

Use OpenCode's **/fork**. Fully copied summaries, pruning and deleted ranges stay applied and independently reversible. Ctrl+E in the fork never changes the original session.

Forking at a user message copies history **before** it and puts that prompt in the input box. A summary/deleted range crossing the cutoff opens to its retained earlier content; complete inner layers remain. For example, forking at turn 19 from summaries 1–10 and 11–20 keeps summary 1–10 and turns 11–18, with turn 19 as a draft.

Initialization verifies the source and copied history without writing the source ledger. Source history must remain available and matching during initialization. Afterward the fork survives restart or source-session deletion. Missing boundaries or mismatched payloads are refused, not guessed. If opening a crossing summary enlarges context, normal budget protection applies.

## Reverting a session

Use OpenCode's **Revert** message action or **/undo**. The selected user message returns to the input box; only preceding history remains effective:

```text
Before:  summary 1–10, turn 11
Revert:  turn 8
After:   turns 1–7, with turn 8 in the input box
```

Crossing summaries/deletions open to retained content. Complete earlier reductions remain applied and reversible, including in initialized forks and across plugin-created last-resort boundaries. No summarizer runs.

Before submission, **/redo** restores the original view. The inspector can display the staged prefix, but editing is blocked while native undo is staged. Submitting the edited prompt commits the cutoff; the plugin reconciles the retained ledger before the next model request. **/redo cannot undo a committed cutoff.** OpenCode owns [file rollback](https://opencode.ai/v2/docs/snapshots); those file changes can remain committed even if a later provider request fails.

Open the inspector on intact history before reverting so source provenance is available. The plugin cannot repair already-truncated history lacking that provenance. Changed retained content, interior holes and unfamiliar checkpoint windows are refused. Do not clear metadata or disable the plugin as a repair. Revert/restoration never bypass budget checks.

## Storage, privacy and limits

- Ledgers and strategies live in OpenCode session metadata. Malformed or foreign state is preserved and refused, never silently reset.
- Captures, accounting caches, spills and exports live under `~/.local/state/opencode-context-manager/<directory-hash>/` on the server. The key is derived from the absolute working directory. Only expired spill files are automatically cleaned.
- Control uses authenticated native RPC, without a separate listener or credential file.
- Exports contain effective normalized context, not the final provider request. Hidden restoration layers are excluded, but the audit ledger can contain summary revisions and other sensitive text.
- Native checkpoints are read-only. Historical running/streaming tools must settle before editing. Opaque provider state has additional guards; signed reasoning, encrypted checkpoints and stateful transports are not universally supported.
- Original history and spills remain. Disabling the plugin exposes stored context again. Pruning/deletion is not secure erasure.
- There is no automatic repair of damaged summaries, orphan-helper crash recovery, exact billing count, losslessness guarantee or transaction against arbitrary external metadata writers.
- Do not downgrade to a plugin that cannot read the session's persisted formats. See [persistence rules](CONTRIBUTING.md#persistence) and [testing](CONTRIBUTING.md#testing).

Provider replay data is read from both current `native` fields and older state fields. Reversible field renames preserve saved fingerprints; content changes still fail validation. Host migrations that merge or discard previously distinct provider state cannot always preserve those fingerprints. Such histories remain refused rather than guessed or reset; keep a backup before upgrading OpenCode and do not clear the ledger to force continuation.
