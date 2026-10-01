# OpenCode Context Manager

Choose what stays in your AI coding session's context. Remove reasoning or tool results, summarize selected turns, and expand summaries later—all from OpenCode's terminal UI, without deleting the original stored conversation.

**Version 2.0.0** · For OpenCode **1.18.x** · Tested on **1.18.34** (earlier releases: **1.18.32–1.18.33**)

## Features

- **Range-based context editing.** Select one or more ranges, choose reasoning/tool pruning or detailed/brief summarization, then run.
- **Parallel compaction.** Each selected range gets its own helper with the same full pre-batch context. The complete successful batch applies automatically; a failed range blocks partial application.
- **Expandable summaries.** Expand a summary one layer to its pre-summary effective context, including any earlier pruning. Pruning is final in this plugin: no Undo, Redo or Unprune.
- **Fullscreen readers.** Read a turn's user message and final answer, or read a saved summary and edit it manually or with a model. Model edits remain proposals until you apply them.
- **Context statistics.** See whole-session and selected-range token estimates, tool status, and an effective-context export. Counting is local; no model call is needed.
- **Near-limit protection.** Pause before a request gets too large. Choose manual cleanup, automatic turn-by-turn compaction, or automatic earlier-session compaction. The active turn stays protected; resuming adds no extra user message.

Open `/context-manager`. Use **Space → move → Space** to select a range, then repeat for more ranges. Press **c** to open compaction configuration: **arrows** navigate, **Space** toggles a mode, **Enter** runs, **m/t** picks model/effort, and **Esc** cancels. Choices stay within the open inspector. The initial choice is detailed summarization.

| Mode | Effect |
| --- | --- |
| Prune reasoning | Remove reasoning parts; preserve prompts, tool calls and visible assistant text. |
| Prune tools (large) | Existing token-threshold pruning: head + omission notice + tail. Inputs and attachments stay intact. |
| Prune tools (all) | Replace every completed/error result, including tool-produced attachments, with `[Tool output pruned]`; keep calls and inputs. Pending calls have no saved result to prune. |
| Prune tools (delete) | Remove entire tool calls, inputs and results, including pending calls. Automatically enables reasoning removal. |
| Summarize (detailed) | Detailed model-written replacement, with the existing soft size review. |
| Summarize (brief) | Shorter, single-pass model-written replacement. |

Reasoning removal can combine with one tool mode. Summary modes cannot combine with pruning. Selecting an incompatible mode clears the old choice; reasoning stays selected while tool deletion is selected. Pruning makes no model call. All modes affect only selected effective context, not stored history or tool execution already performed.

Rows are **USER** or **SUMMARY**, regardless of summary length or pruning. USER stats show `tools` (including zero), `large` (eligible under current rules), and `pruned`. All-output pruning replaces `tools` with `pruned`; deletion shows `tools:0 · no tools`. Reasoning removal adds `no reason` at the end. Other stats remain separate.

In the range menu, **Enter** reads a turn/summary, **Ctrl+E** previews summary expansion, **Ctrl+S** confirms it, **a** selects the autocompaction strategy, and **?** shows help. Saved summaries still support manual/model editing with explicit application.

**Know before using:** initial summaries apply without a preview. Inspect them afterward and edit or expand if needed. Summarization uses your provider and may cost money; parallel ranges each send the full effective background. Token estimates are not exact provider counts, and summaries are not lossless. Exports may contain sensitive data. Reasoning replay is provider-specific; the plugin does not promise compatibility with every signed/opaque-reasoning protocol.

**Upgrading from 1.x:** Undo, Redo, Unprune and the separate p/b action keys are removed. Old saved operations still replay; new changes write policy format 6. Fully restart both entrypoints. Do not mix older builds with sessions changed by this version.

## Install

Requires **Node.js 22+**, npm, and a compatible local OpenCode installation. This is a source-based install, not a published npm package. Experimental host hooks can change; recheck compatibility before upgrading OpenCode.

1. Clone or download this repository. From its root, install dependencies:

   ```sh
   npm ci --ignore-scripts
   ```

   On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

2. Add the **server** entrypoint to your project or global `opencode.json` / `opencode.jsonc`:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["file:///absolute/path/opencode-context-manager/src/server.ts"]
   }
   ```

3. Add the **TUI** entrypoint to `tui.json`:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["file:///absolute/path/opencode-context-manager/src/tui.tsx"]
   }
   ```

   Replace the example URLs with your checkout's paths. To print correctly escaped URLs on any platform, run this from the repository root:

   ```sh
   node --input-type=module -e "import {pathToFileURL} from 'node:url'; for (const p of ['src/server.ts','src/tui.tsx']) console.log(pathToFileURL(process.cwd()+'/'+p).href)"
   ```

   Merge these entries into your existing configuration—do not replace it. Both entrypoints are required, in their respective files. See OpenCode's [configuration docs](https://opencode.ai/docs/config/) for file locations.

4. Fully quit and restart OpenCode. Open a session and run **`/context-manager`**, or choose **Context manager** in the command palette. If the server runtime is not available yet, send a normal message to initialize it.

While enabled, the plugin overrides native automatic compaction and historical pruning to **off** in the loaded configuration. It does not rewrite config files. Use its range actions instead of native `/compact` when plugin operations are active. Removing the plugin exposes the original, potentially much larger context again.

For development and verification, see [CONTRIBUTING.md](CONTRIBUTING.md). Remote-attach deployments are not supported end to end; both entrypoints need the same local runtime files.

## Configuration

Options go on the **server entrypoint only**. The TUI reads them from the server. Everything below is optional and shows the defaults:

```json
{
  "plugin": [
    ["file:///absolute/path/opencode-context-manager/src/server.ts", {
      "ui": { "maxLinesPerTurn": 4 },
      "autocompaction": { "headroom": 20000 },
      "spill": { "maxLines": 2000, "maxBytes": 51200, "headShare": 0.5 },
      "prune": { "threshold": 5000, "head": 1000, "tail": 1000 },
      "tokenizer": { "fallbackEncoding": "o200k_base", "overrides": {} }
    }]
  ]
}
```

| Option | Meaning |
| --- | --- |
| `ui.maxLinesPerTurn` | Maximum lines per list entry, including header and tool stats. Integer ≥3; short entries shrink to fit. |
| `autocompaction.headroom` | Pause when estimated context exceeds the input budget minus this many tokens. Nonnegative integer; must leave a positive threshold. Does not change output limits. |
| `spill.maxLines` / `maxBytes` | Fresh tool-output limits. Exceeding either saves full text to a file and keeps a preview. Minimum 2 lines / 8 bytes; bytes are UTF-8. |
| `spill.headShare` | Preview allocation: `0.5` keeps half head/half tail, `1` head only, `0` tail only. Notice and file path are extra. |
| `prune.threshold` | In **large** mode, prune only selected tool results **strictly longer** than this token count. |
| `prune.head` / `tail` | Maximum tokens retained at each end. Nonnegative integers whose sum must be below `threshold`. The notice/link is extra; changes that save no tokens are skipped. |
| `tokenizer.fallbackEncoding` | Encoding for unknown models: `o200k_base` or `cl100k_base`. The UI labels fallback estimates. |
| `tokenizer.overrides` | Explicit encoding per `providerID/modelID`, e.g. `{ "my-provider/my-model": "cl100k_base" }`. |

By default, compaction inherits the session model and effort. To set persistent defaults, add this to the same options object, using a model and variant available in your OpenCode installation:

```json
"summarizer": {
  "providerID": "my-provider",
  "modelID": "my-model",
  "variant": "default"
}
```

Set both model fields or neither; `variant` is optional. Menu choices override these defaults for the open inspector, not the main session. Unknown options are rejected. There is no `prune.unit` or `outputReserve` option. Restart OpenCode after changing settings or updating either entrypoint.

Autocompaction strategy is **per session**, chosen with **a**, not a config option:

- **MANUAL** (default): pause for you to reduce earlier context. On exit, explicitly resume if it fits, or abort the run.
- **AUTO_PER_TURN**: compact earlier USER turns oldest first, then try the whole earlier prefix once if needed.
- **AUTO_SESSION**: compact the earlier prefix once.

Saving a strategy does not start work. If already paused, press **g** to run the chosen automatic strategy. Automatic modes resume only when the estimate fits; otherwise they leave the run paused for manual recovery. The active turn cannot be changed while paused. Pauses do not survive a host restart; the strategy does.

Local captures, exports and spill files live in `~/.local/state/opencode-context-manager/<project-hash>/`. Keep them private, especially `runtime.json`, which contains a local control credential. Original session data and the operation ledger remain in OpenCode's storage. Final pruning is not secure erasure: disabling the plugin can expose the original history again.
