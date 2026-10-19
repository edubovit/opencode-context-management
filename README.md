# OpenCode Context Manager

Choose what stays in your coding session's context. Prune reasoning or tool results, summarize or delete selected ranges, and restore them later—without deleting the stored conversation.

**Plugin 4.4.5 · OpenCode V2**.

## Features

- **Range-based editing:** select disjoint ranges, then choose reasoning removal, large/all tool-result pruning, whole-call deletion, detailed/brief summaries, or whole-range deletion.
- **Parallel summaries:** each range receives the same frozen effective background. Only a complete successful batch applies; retry just failed ranges.
- **Isolated summaries:** optionally send only the selected range, or the selected range plus preceding effective history, without later/runtime background.
- **Forks preserve reductions:** fully copied summaries, pruning and deleted ranges stay applied and remain independently reversible in the fork.
- **Native Revert support:** crossing summaries open to the retained turns; earlier reductions remain reversible. Redo restores the original view before you submit.
- **Reversible reductions:** expand summaries, restore deleted ranges, or restore the latest tool/reasoning pruning layer on selected turns. Earlier layers and unrelated ranges stay intact; no global Undo/Redo.
- **Fullscreen readers:** read turns and saved summaries. Edit summaries manually or with a model; model edits stay proposals until explicitly applied.
- **Local statistics:** token estimates, tool status, selected-range totals, and effective-context exports. Counting needs no model call.
- **Near-limit protection:** suspend before a model request and resume the same request after reduction. AUTO_PER_TURN is the default; subagents never require manual recovery. Last resort can summarize an unfinished-turn prefix while retaining the newest 20,000 estimated tokens.

Initial summaries apply automatically; inspect/edit/expand them afterward. Summarization uses your provider and can cost money. By default, each parallel range sends the full effective background; isolation can narrow it. Token counts are estimates, summaries are lossy, and exports can contain sensitive content.

## Install

This is a **source-based, private package**, not a published npm plugin. Requires a compatible local OpenCode **V2 (2.0.27 or newer)** installation and npm.

Version 4.4.3 rejects summary output if any assistant response to the current helper prompt was truncated, even when OpenCode continues and finishes successfully. It does not accept a continuation tail as a complete summary or assemble truncated chunks. Earlier saved summaries are not automatically repaired: restore affected ranges and regenerate them, keeping the normal budget guard enabled. See [validation details](CONTRIBUTING.md#version-443-validation).

Version 4.4.4 lets reasoning pruning proceed across failed/interrupted attempts by retaining their ambiguous reasoning and pruning safe responses. It uses the ordinary pruning status without extra warnings. See [current validation](CONTRIBUTING.md#version-444-validation).

Version 4.4.5 makes **Ctrl+E** apply one-layer restoration immediately, without a preview or confirmation. It still checks the selected source and session state before writing. See [validation details](CONTRIBUTING.md#version-445-validation).

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

3. Open a session and run **`/context-manager`**, or choose **Context manager** from the palette. V2 watches plugin/config changes.

The plugin does **not** rewrite host configuration. Explicit `compaction.auto: false` is required: native compaction runs before the context hook. While loaded, the plugin rejects native compaction requests; use its range actions instead of native `/compact`.

See [V2 plugin configuration](https://opencode.ai/v2/docs/plugins) and [development checks](CONTRIBUTING.md). Full remote installation/artifact delivery is not supported end to end: RPC is remote-aware, but source entrypoints must be available to the terminal and exports/spills stay on the server.

## Controls and modes

The inspector opens with a compact overview: aligned turn sizes, local/selected totals, a request-budget meter, and a small text breakdown. Selecting ranges switches the breakdown to selected text. Full counts, model/tokenizer identity, accounting details and warnings are under **v → Details**; they are not removed.

The meter is labeled **Last request guard** when historical and **Live guard** only during a pause. It compares estimated tokens with the cleanup threshold, not the model's full context window. Missing samples or changed models do not get an invented percentage. Below 80 columns, **Tab** switches between full-width panes.

Use **Space → move → Space** to close a range; repeat for more ranges. Press **c** to configure compaction: arrows navigate, Space toggles a mode, Enter runs, **m/t** selects model/effort, and Esc cancels. The initial mode is detailed summarization; choices last for that inspector.

| Mode | Effect |
| --- | --- |
| Prune reasoning | Remove safe reasoning parts; retain failed/interrupted attempts, prompts, calls and visible assistant text. |
| Prune tools (large) | Token-budgeted head + omission notice + tail. Preserve inputs and attachments. |
| Prune tools (all) | Replace completed/error results with `[Tool output pruned]`, including result attachments. Keep calls and inputs. |
| Prune tools (delete) | Remove entire calls and results. Requires reasoning removal. |
| Summarize (detailed) | Detailed replacement with at most one soft-size-review follow-up. |
| Summarize (brief) | Shorter, single-pass replacement. |
| Delete | Remove the entire selected range from effective context. Keep one zero-content **DELETED** row per range for restoration. No model call. |

Reasoning removal combines with one tool mode. Summary modes and **Delete** are standalone choices. Pruning, deletion and restoration make no model calls and never change past tool execution or disable future tools.

### Isolated summarization

In **c**, select detailed or brief summarization, then toggle one optional isolation setting with **Space**:

| Option | Helper receives |
| --- | --- |
| Both off (default) | Selected range plus full effective history and captured runtime background, as before. |
| Isolated summarization (head included) | Selected range plus preceding effective history. No later history or captured runtime background. |
| Isolated summarization (total) | Only the selected range. No preceding/later history or captured runtime background. |

The options are mutually exclusive and disabled for pruning/Delete. Toggling the selected option turns isolation off. Switching detailed/brief keeps the selected isolation; choosing another action clears it. These are local inspector choices, not global configuration fields. The helper still receives its summarization instructions, but no tools.

Each batch range uses its own boundary against the same frozen snapshot; retries/refinements keep that scope, without sibling-summary leakage. Total isolation is useful after expansion makes the full session too large for a helper. The selected range must still fit the provider, and head-included can still be large. Isolating the helper does not remove unselected history from the main session or bypass its Resume guard.

### Other controls

- **Enter:** read a turn or summary. Readers exclude tool activity/reasoning and label unfinished answers.
- **Ctrl+E:** immediately restore one layer for each selected item, with no preview or confirmation. A summary expands to its pre-summary view. A **DELETED** range restores its pre-deletion turns, summaries and pruning. A pruned ordinary turn restores its latest effective pruning action. Combined tool/reasoning pruning restores together, including deleted calls/results; separate actions restore one at a time. Expand a summary or deleted range before restoring layers hidden inside it. Restoration makes no model call and can increase context size; the normal Resume budget guard still applies.
- **e/r** inside a summary: manual edit / model request. **Ctrl+S** saves, sends, or applies according to the current editor mode.
- **a:** save autocompaction strategy. **g:** retry failed batch jobs, or explicitly run AUTO while paused.
- **v:** cycle Overview → Details → Content → Runtime. **n:** local token/character counts; the guard stays in tokens. **Tab:** switch panes. **f:** reload. **o:** export. **?:** help.
- **m/t:** choose summary model/effort from the main view or compaction menu.
- **Esc:** cancel an open range/editor or go back. A paused exit offers Stay, Resume only if within budget, or Abort.

Rows show USER/SUMMARY/DELETED with compact, right-aligned sizes; filled circles and R labels mark selected ranges. Host checkpoint context is labeled separately and is read-only. Tool statistics distinguish large-output eligibility, pruning, removed tools/reasoning, and unfinished/protected turns. Exact numbers remain in Details and exports.

To delete: select a range with **Space → move → Space**, press **c**, choose **Delete**, toggle it with **Space**, then press **Enter**. Multiple selected ranges apply together. A DELETED row contributes no messages or placeholder to model context, no local content tokens, and no hidden text to summary helpers. It remains selectable but indivisible until expanded. Deleting an already-deleted range alone does nothing and reports an error. Deleting a wider range can contain earlier deletions; expansion restores one layer at a time. Stored history and prior operations remain intact.

Restoration affects only selected turns, even when an earlier prune covered a wider range. It preserves earlier pruning layers and survives restart. The preview shows how much estimated text context will return. Restoring during a manual pause can put the request over budget again; Resume stays blocked until it fits. Restoration does not recover data already removed by the host or expand an ingestion-time spill preview into its full output file.

## Options

Configure the plugin through the `options` object on its entry in **`opencode.json` or `opencode.jsonc`**. Use your project configuration for project-specific settings, or the global OpenCode configuration for shared defaults. Keep one plugin registration pointing to the `src` directory; the server and inspector use the same options. These options do not belong in `cli.json`.

- **Project:** `opencode.json` or `opencode.jsonc` in your project directory.
- **Global:** normally `~/.config/opencode/opencode.json` or `opencode.jsonc`. On Windows this is usually under `%USERPROFILE%\.config\opencode\`; `XDG_CONFIG_HOME` can change the configuration root.

### Complete configuration example

This example includes **every configurable plugin parameter**. The numeric settings and `fallbackEncoding` use their defaults. The summary model and tokenizer override are illustrative: replace `my-provider` / `my-model` with IDs available in your OpenCode installation. Remove the `summarizer` object to inherit the main session's model and effort, and use `"overrides": {}` unless you need an encoding override.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // OpenCode setting, not a plugin option. Required for this plugin.
  "compaction": { "auto": false },

  "plugins": [
    {
      "package": "file:///absolute/path/opencode-context-management/src",
      "options": {
        "ui": {
          "maxLinesPerTurn": 4
        },
        "autocompaction": {
          "headroom": 20000,
          "estimateMultiplier": 1.3,
          "lastResortKeepTokens": 20000
        },
        "spill": {
          "maxLines": 2000,
          "maxBytes": 51200,
          "headShare": 0.5
        },
        "prune": {
          "threshold": 3000,
          "head": 1000,
          "tail": 500
        },
        "tokenizer": {
          "fallbackEncoding": "o200k_base",
          "overrides": {
            "my-provider/my-model": "o200k_base"
          }
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

Merge this into your existing configuration rather than replacing unrelated providers, permissions or plugins. Replace the package path with your checkout's directory URL; see [Install](#install) for generating it, including on Windows. The example uses JSONC comments for explanation; remove those comment lines if you need strict JSON.

### Defaults and validation

- **Every plugin option is optional.** `"options": {}` uses all built-in defaults. You can supply only the groups or individual fields you want to change.
- Omitted fields keep their defaults; they are not automatically adjusted to fit other values you changed. For example, lowering `prune.threshold` to `1500` requires lowering `head` and/or `tail`, because their default sum is already `1500`.
- Use JSON numbers for numeric settings. Limits expressed as integers must be whole numbers within the ranges below. Model/provider/variant values must be nonempty strings.
- Unknown keys are rejected, including keys nested inside an option group. Invalid settings fail visibly rather than being silently ignored. There is no `prune.unit`, `outputReserve`, plugin output-token cap, or general `enabled` option.
- The cleanup **strategy** is a per-session choice made with **a** in the inspector, not an `options.autocompaction.strategy` field. Its default is AUTO_PER_TURN. OpenCode's required `compaction.auto: false` disables native compaction, **not this plugin's automatic cleanup**.

### Inspector layout: `ui`

| Parameter | Default | Allowed values and effect |
| --- | --- | --- |
| `ui.maxLinesPerTurn` | `4` | Integer ≥ `3`. Maximum height of a conversation-list row, including its heading, status and preview. Short entries use less space. |

Increase this for longer previews, or use `3` to fit more rows on screen. This affects only the inspector layout: it does not truncate conversation data or change what the model receives. **Enter** opens the full turn or summary reader.

### Cleanup budgets: `autocompaction`

| Parameter | Default | Allowed values and effect |
| --- | --- | --- |
| `autocompaction.headroom` | `20000` | Integer ≥ `0`, in estimated input tokens. Subtracted from the active model's input capacity to determine when cleanup starts. Must be smaller than that capacity. |
| `autocompaction.estimateMultiplier` | `1.3` | Finite number ≥ `1`. Conservative multiplier for missing-usage estimates and the minimum multiplier on newly added content. Used by main-request guards and automatic helpers, not to veto manual summaries or edits. |
| `autocompaction.lastResortKeepTokens` | `20000` | Integer ≥ `0`, in estimated local tokens. Amount of newest conversation to retain unchanged during last-resort cleanup. Whole messages/tool pairs and existing summaries remain intact, so the actual retained tail can be larger. |

The main cleanup threshold is **input capacity − headroom**. The plugin uses a positive explicit model input limit when available; otherwise it derives input capacity from **context limit − output limit**. For example, input capacity `922000` and headroom `20000` give a cleanup threshold of `902000`. An estimate equal to the threshold fits; an estimate above it triggers the selected cleanup strategy. Headroom does not change the host/provider output cap.

A larger headroom starts cleanup earlier. A larger multiplier is more cautious when local counts miss provider overhead, but can also trigger cleanup sooner. The multiplier is **not** blindly added to every reported token count: provider-anchored accounting treats already measured context and new content separately. An observed provider/local ratio can exceed the configured multiplier; setting it to `1` does not disable the guard.

`lastResortKeepTokens` applies only after ordinary automatic attempts fail to make the request fit. Lowering it leaves more of the conversation eligible for an emergency summary, at the cost of retaining less recent detail verbatim. `0` requests no retained tail; normal source, checkpoint and unsettled-tool safeguards still apply. It does not change which ranges a manually requested summary includes.

### New tool-output previews: `spill`

Spilling handles **new successful tool results as they arrive**, before they become oversized context. If their combined text exceeds either limit, the plugin saves the full captured text to a server-local `output-*.txt` file and returns a shorter preview with that file's path. Non-text attachments are preserved.

| Parameter | Default | Allowed values and effect |
| --- | --- | --- |
| `spill.maxLines` | `2000` | Integer ≥ `2`. Maximum retained text-line budget across the preview's beginning and end. Also triggers spilling when the incoming text has more lines than this. |
| `spill.maxBytes` | `51200` | Integer ≥ `8`, in UTF-8 bytes (`51200` = 50 KiB). Byte budget across the retained beginning and end; exceeding it also triggers spilling, even for a single long line. |
| `spill.headShare` | `0.5` | Number from `0` through `1`. Fraction of both budgets assigned to the beginning; the remainder goes to the end. `0.5` splits evenly, `1` keeps only the beginning, and `0` keeps only the end. |

Each retained section must fit both its line and byte budgets. Omission notices and the full-output path are added afterward, so the complete preview can be larger than the configured retained-text budget. UTF-8 characters are not split mid-character.

Lower these limits to keep future tool output smaller; raise them when long results are useful in full. They do not retroactively shorten existing history. Spilling is different from reversible pruning: restoring a later prune restores the stored preview, not the full external file. Spill files older than seven days are cleaned during plugin startup for that working directory, so they are not permanent archives.

### Existing tool-result pruning: `prune`

These limits control **Prune tools (large)** on selected existing history. They do not automatically run when you change configuration, and do not apply to **Prune tools (all)** or **Prune tools (delete)**.

| Parameter | Default | Allowed values and effect |
| --- | --- | --- |
| `prune.threshold` | `3000` | Integer ≥ `1`, in locally estimated tokens per tool result. Only results **strictly larger** than this value are eligible. |
| `prune.head` | `1000` | Integer ≥ `0`. Maximum tokens retained from the beginning of an eligible result. `0` keeps no beginning text. |
| `prune.tail` | `500` | Integer ≥ `0`. Maximum tokens retained from the end of an eligible result. `0` keeps no ending text. |

**`head + tail` must be strictly less than `threshold`.** With the defaults, a result above 3,000 tokens is reduced to up to 1,000 beginning tokens plus 500 ending tokens, with an omission notice and any full-output path added. These notices are extra; if the resulting text would not be smaller, the operation is skipped.

Use more tail budget when final errors or conclusions matter most, or more head budget when headers and initial context matter most. Inputs and attachments stay intact in large-output mode. Each saved pruning operation pins its rule and tokenizer, so changing these defaults later does not reinterpret earlier cuts. **Ctrl+E** restores an applied pruning layer; it does not restore an external spill file's full contents into the conversation.

### Local token estimates: `tokenizer`

| Parameter | Default | Allowed values and effect |
| --- | --- | --- |
| `tokenizer.fallbackEncoding` | `"o200k_base"` | `"o200k_base"` or `"cl100k_base"`. Used when neither an explicit override nor a built-in model-name mapping selects an encoding. |
| `tokenizer.overrides` | `{}` | Map of exact `"providerID/modelID"` keys to either supported encoding, for example `{ "my-provider/my-model": "cl100k_base" }`. Overrides take priority over built-in mappings. |

The encoding determines how text is split into tokens for local estimates and pruning. An override is useful for custom model IDs or aliases whose encoding the plugin cannot identify. Use the model ID selected in OpenCode, not a display name. A summary helper can use a different encoding from the main session; pruning rules use the consuming main-session model's basis.

Changing an encoding does not change a model's real context limit or make the provider use that tokenizer. Counts remain estimates, especially for unknown models, media and provider-specific framing. The inspector labels the chosen encoding and whether it came from a mapping, override or fallback. **n** changes the displayed local unit only; guards and pruning still use tokens.

### Summary model and effort: `summarizer`

| Parameter | Default | Allowed values and effect |
| --- | --- | --- |
| `summarizer.providerID` | Omitted: inherit the main session's provider. | Nonempty provider ID available in OpenCode. Must be supplied together with `modelID`. |
| `summarizer.modelID` | Omitted: inherit the main session's model. | Nonempty model ID under that provider. Must be supplied together with `providerID`. |
| `summarizer.variant` | Inherit effort when inheriting the main model; otherwise use the selected helper model's default. | `"default"` or a variant supported by the selected model. Variant names are model-specific; not every model offers `"low"`, `"high"`, etc. |

- Omit the entire `summarizer` group, or set it to `{}`, to follow the main session's model and effort.
- Set **both** `providerID` and `modelID` to choose a dedicated helper model for summarization and model-assisted summary editing. This does not switch the main session's model.
- If you choose a dedicated helper model but omit `variant`, the main model's effort is **not** copied to it; the helper uses its own default.
- You can set only `variant` to override effort while still inheriting the main model. `"variant": "default"` explicitly selects the model's default rather than inheriting the main session's effort.
- Inspector **m/t** selections override these defaults for that inspector. They do not rewrite configuration or switch the main session's model.

Choose a model with enough input capacity for the **selected helper scope**. With isolation off, this includes the full effective background, not just the selected range. Each initial batch helper uses the same frozen snapshot and its own isolation boundary. A cheaper helper may reduce cost, but a smaller context window can reject the request. Content is omitted only when you explicitly choose an isolation option; models are never silently switched.

These IDs select an existing OpenCode provider/model; they do not configure a provider or supply credentials. Provider setup and model context/output limits belong in OpenCode's provider configuration, not this plugin's options.

**Manual compaction lets the provider decide whether the input fits.** User-started summaries, batch ranges, refinements and saved-summary edits have no plugin token-size preflight, safety multiplier or usage-based veto. This also applies in AUTO sessions and during manual cleanup pauses. Without isolation, splitting ranges does not reduce each request's full frozen background. Host/provider limits and errors still apply, and failed or incomplete results are never applied. Automatic cleanup—including Run from a pause—and main-request Resume keep their budget guards.

### Autocompaction

The safety guard is **provider-aware**, not the inspector's local content total. It uses the latest compatible reported input (including cached input once) and output/reasoning, plus estimated growth since that response. A high reported count can trigger cleanup even when the local tokenizer is below the threshold. The check runs before the next main request, including tool continuations—not in the middle of the response that supplies the usage.

Requests are paired with their reports using model/agent/configuration identity and native history fingerprints. After pruning, summaries or expansion, the guard recounts against that fixed baseline. New content is charged with at least the configured multiplier or the observed input/local ratio; removed content receives only its unscaled local estimate as credit. Unexplained provider overhead is retained, not silently declared freed. The same count governs pause, automatic candidates and resume.

The inspector shows **Live guard** while paused or **Last request guard** otherwise, separately from local categories and historical usage. This meter is not the manual summarizer's input count. `provider-matched` means a captured request/report pair; `provider-unpaired` is a conservative reconstruction for an existing session without a sample. Known later ledger edits are excluded from that historical reconstruction. `local-fallback` means no compatible report is available and uses the configured uplift. Automatic helpers have independent accounting and fail before dispatch when their estimated capacity would be exceeded. Manual helpers skip that guard. Neither kind recursively compacts or changes the parent's usage baseline.

Accounting survives restart. Model, variant, agent, configured route, provider/model compatibility options or tokenizer changes invalidate incompatible measurements; a changed model/provider configuration also prevents resuming a stale live pause. The files contain hashes/counts, not request text or credentials.

Images and PDFs in typed tool-result content use the same rough media allowances as direct attachments, not the text-token cost of their base64 bytes. Text parts are counted separately and the image/file payload stays unchanged. Genuine text, JSON and error payloads remain text-counted; arbitrary base64-looking strings are not silently ignored.

**This is still a forecast, not an exact provider count or a hard limit guarantee.** Reports describe earlier requests; changed text, later hooks, media and opaque state can differ. Image/PDF allowances are rough estimates. Unpaired reconstruction assumes normal operation timestamps/history ordering. Unknown residual overhead can prevent release after substantial cleanup; AUTO fails rather than forcing an oversized request through. Keep headroom, and increase `estimateMultiplier` if your unmeasured additions are consistently underestimated.

- **MANUAL:** pause for cleanup; resume only when the estimate fits. Available for top-level sessions only.
- **AUTO_PER_TURN** (default): compact earlier USER turns oldest first, then try the earlier prefix once if necessary.
- **AUTO_SESSION:** compact the earlier prefix once.

Saving a strategy does not start work. Ordinary cleanup protects the whole active execution turn, including steered inputs. If normal AUTO attempts cannot free enough space, **last resort** summarizes the largest safe prefix before the exempt tail, even within that unfinished turn. This is a plugin summary, not native OpenCode or provider-native compaction. Live system instructions/tool definitions and the exempt tail are unchanged. Original history remains stored; the saved checkpoint can be read, edited or expanded later when idle.

Last resort uses independent helpers and bounded chunk/merge passes when the selected prefix cannot fit one helper request. Only selected effective content is summarized; previous pruning stays in effect and unfinished work must not be presented as complete. Up to four rounds and 64 helper requests are allowed, so this can incur additional provider costs. It applies only a complete result that makes the guard fit. If the tail leaves no eligible prefix, the helper fails, or the result still does not fit, **AUTO ends with an error—never a manual recovery pause or silent oversized dispatch**. Use smaller tasks, a larger model, or a smaller retained tail where appropriate.

Subagents, including nested/background children, have separate ledgers and usage accounting. Fresh child sessions discard only verified ancestor-owned ledger copies; parent history and unrelated metadata are untouched. A child inheriting or selecting MANUAL uses AUTO_PER_TURN instead. Existing top-level MANUAL choices stay MANUAL. Hidden summarizer/editor helpers remain separate and do not recursively compact; only automatically triggered helpers enforce the plugin's capacity estimate.

Queued inputs are not silently discarded. Oversized synthetic-only context without a USER turn is refused. Pause authority is in memory; after reload/restart an old saved pause notice cannot resume the old request. Stop/reload cancels last-resort work and prevents late application.

## Forking sessions

Use OpenCode's normal **/fork**. The fork keeps every fully copied effective summary, pruning layer and deleted range. **Ctrl+E** restores those layers in the fork only; the original session is unchanged. Nested summaries, prior pruning and last-resort split boundaries stay reversible, including after restart or deleting the original session once fork initialization has finished.

Native cutoff rules still apply: forking at a user message copies history **before** that message and places its prompt in the input box as a draft. A summary or deleted range crossing the cutoff is opened to its retained earlier content; fully retained inner layers stay applied. For example, with summaries 1–10 and 11–20, forking at 19 keeps summary 1–10 and turns 11–18, with turn 19 as a draft—not turns 20–21.

The plugin initializes a separate fork-owned ledger from verified copied history. It does not rewrite original messages or the original ledger. Copied parent usage is excluded until the fork measures its own requests; the first request uses the normal conservative local estimate. If opening a boundary-crossing summary makes the fork too large, normal budget protection still applies; isolated summaries can help reduce it.

Fork initialization needs the source history to remain available and unchanged while it verifies the copy. Missing source/boundaries or mismatched payloads fail visibly rather than guessing. There is no separate repair/migration command for old broken forks. Once initialized, the fork no longer needs its source session.

## Reverting a session

Use OpenCode's **Revert** message action or **/undo**. The selected user message returns to the input box; only history before it remains in the effective context. For example:

```text
Before:  summary 1–10, turn 11
Revert:  turn 8
After:   turns 1–7, with turn 8 in the input box
```

A summary or deleted range crossing the cutoff opens to its retained earlier content. Fully retained earlier summaries, pruning and deletions stay applied and can still be expanded one layer at a time. This also works in initialized forks and across plugin-created last-resort checkpoints. Revert does not run a summarizer.

Before submitting, **/redo** restores the original conversation/reductions. The inspector can show the staged prefix, but context edits remain blocked while native undo is staged. Submitting the edited prompt commits the cutoff; the plugin rebuilds its ledger for the verified retained history before the next model request. **/redo cannot undo that committed cutoff.** Native file rollback is controlled by OpenCode's [snapshots](https://opencode.ai/v2/docs/snapshots), not by this plugin.

Opening a crossing summary can enlarge the context. The normal main-request budget guard still applies. After rebuilding a ledger, historical usage is excluded until the session measures its new request; no oversized-dispatch bypass is granted.

**Upgrade safety:** open `/context-manager` on an intact older session before reverting it, so its source identities and timestamps can be recorded. Earlier format-13 records without timestamps are accepted and backfilled only from matching intact history. The plugin cannot automatically repair history already truncated before this provenance was saved. Missing/changed retained content, interior holes, unfamiliar older replacement history and changed native-checkpoint windows are refused, not guessed at. Do not clear metadata or disable the plugin as a repair.

## Limits and storage

Malformed or unrelated ledgers are preserved and refused, never silently reset. Verified new forks inherit independent reversible reductions; ordinary fresh child sessions get an empty own ledger.

Native checkpoints are read-only; edit later USER turns. Historical tools still marked running/streaming must be settled by the host before editing. Opaque provider-executed results cannot be safely pruned; use a summary or whole-call deletion with reasoning instead. Reasoning pruning skips failed/interrupted assistant attempts, whose reasoning may have become ordinary text, while pruning safe reasoning in the same turn or range. Tool pruning still applies. These turns use the normal **reasoning pruned** status, with no blocked or partial-pruning marker. Retained content remains included in local counts, summaries and exports; restoration returns the prior effective layer. Signed/opaque reasoning, encrypted checkpoints and stateful provider transports are not universally validated.

Version 4.4.4 writes ledger format **13** and exports schema **7**; accounting cache remains **2**. Existing ordinary-session V2 ledgers **7–12** retain their operations and fingerprints. An intact ledger gains a source manifest on checked server access without changing its reductions; no original message text is copied into that manifest. Normal edits append operations. A committed native revert instead rebuilds the retained reversible layers and removes obsolete source references. Do not downgrade after a format-13 write. Fork/revert turn boundaries and source provenance cannot be rewritten by ordinary context maintenance. Restoration never bypasses the Resume budget check.

Captures, spill files and exports live in `~/.local/state/opencode-context-manager/<project-hash>/` on the server. The ledger and strategy live in OpenCode session metadata. Control uses authenticated native RPC, with no separate control port or credential file.

Pruning is not secure erasure. Original history/spills remain, and disabling the plugin exposes original context again. Exports include the audit ledger, which can contain older summary revisions. No crash recovery for orphaned helper sessions, exact provider billing counts, or transactional protection against arbitrary external metadata writers is promised.
