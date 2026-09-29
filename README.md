# OpenCode Context Manager

Choose what stays in your AI coding session's context. Trim large tool results, summarize selected turns, and restore them later—all from OpenCode's terminal UI, without deleting the original conversation.

**Version 1.0.0** · For OpenCode **1.18.x** · Tested on **1.18.32–1.18.33**

## Features

- **Range-based context editing.** Select one or more ranges, prune tool output, or replace them with detailed (`compact`) or short (`brief`) summaries.
- **Parallel compaction.** Each selected range gets its own helper with the same full pre-batch context. The complete successful batch applies automatically; a failed range blocks partial application.
- **Reversible changes.** Unprune selected results, expand summaries one layer, or undo/redo individual operations. Original messages stay in OpenCode's transcript.
- **Fullscreen readers.** Read a turn's user message and final answer, or read a saved summary and edit it manually or with a model. Model edits remain proposals until you apply them.
- **Context statistics.** See whole-session and selected-range token estimates, tool status, and an effective-context export. Counting is local; no model call is needed.
- **Near-limit protection.** Pause before a request gets too large. Choose manual cleanup, automatic turn-by-turn compaction, or automatic earlier-session compaction. The active turn stays protected; resuming adds no extra user message.

Open `/context-manager`. Use **Space → move → Space** to select a range, then repeat for more ranges. Press **p** to prune, **c/b** to compact/brief, **Enter** to read, **Ctrl+U/E** to restore, **u/r** to undo/redo, and **?** for help. **m/t** selects the compaction model/effort; **a** selects the session's autocompaction strategy.

**Know before using:** initial summaries apply without a preview. Inspect them afterward and edit or undo if needed. Summarization uses your provider and may cost money; parallel ranges each send the full effective background. Token estimates are not exact provider counts, and summaries are not lossless. Exports may contain sensitive conversation or project data.

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
| `prune.threshold` | Prune only selected tool results **strictly longer** than this token count. |
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

Local captures, exports and spill files live in `~/.local/state/opencode-context-manager/<project-hash>/`. Keep them private, especially `runtime.json`, which contains a local control credential. Original session data and the undoable operation ledger remain in OpenCode's storage.
