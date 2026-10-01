# Contributing

This is the development guide for OpenCode Context Manager. User setup and options are in [README.md](README.md). Keep development documentation here rather than adding incident logs, private research, or machine-specific instructions to the public tree.

## Contents

- [Setup and checks](#setup-and-checks)
- [Architecture](#architecture)
- [Behavior and invariants](#behavior-and-invariants)
- [OpenCode integration](#opencode-integration)
- [Terminal UI](#terminal-ui)
- [Testing](#testing)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Changes and releases](#changes-and-releases)

## Setup and checks

Use Node.js 22+ and npm. The package targets OpenCode 1.18.x's **ordinary session engine**. Version 2.0.0's host integration was tested on 1.18.34; earlier releases used 1.18.32–1.18.33. Plugin/SDK declarations are pinned to 1.18.32, OpenTUI to 0.4.5, Solid to 1.9.12, and the local renderer-test runtime to Bun 1.3.14. Matching declarations alone do not prove runtime compatibility.

From the repository root:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:tui
# All three checks:
npm run check
```

On Windows, use `npm.cmd` and `opencode.cmd` if PowerShell blocks their `.ps1` shims. Do not change execution policy just to run these commands.

There is no build step. OpenCode loads `src/server.ts` and `src/tui.tsx` directly. Follow the README to register both in a disposable development setup; fully restart the host after changing loaded modules or configuration.

`script/test-tui.mjs` locates the installed platform-specific Bun binary directly, so a global Bun installation and npm postinstall scripts are unnecessary. Do not omit optional dependencies: Bun and OpenTUI need their platform packages. If that package is unavailable for your platform, report the platform/architecture rather than silently skipping UI tests.

The default suite uses synthetic data and makes no live model calls. Package installation can still access the package registry. Keep local config, design notes, logs, fixture results and any private transcripts under ignored `.local/`; no development task should require that directory's contents.

## Architecture

### Modules

| Area | Files | Responsibility |
| --- | --- | --- |
| Host entrypoints | `src/server.ts`, `src/tui.tsx` | Server hooks, settings publication, UI routes and commands. |
| Configuration | `src/config.ts` | Validated server options, plugin version, agent/state namespaces. |
| Projection | `src/context.ts` | Turn grouping, canonical fingerprints, versioned ledger replay, summary replacement and restoration. |
| Workflow | `src/controller.ts`, `src/batch.ts` | Complete-history loading, guarded changes, helpers, frozen parallel batches and one-write application. |
| Model prompts | `src/summarize.ts`, `src/summary-editor.ts` | Range scoping, size review, summary-only editing dialogues. |
| Host adapters | `src/sdk-host.ts`, `src/legacy-host.ts` | SDK calls, model catalog, provider errors, helper lifecycle. |
| Autocompaction | `src/auto-state.ts`, `src/autocompaction.ts`, `src/control.ts` | Input budgets, live suspension gates, per-session strategies and authenticated loopback control. |
| Text and metrics | `src/text.ts`, `src/tokens.ts`, `src/metrics.ts`, `src/status.ts` | Spill/prune rules, local tokenization, distributions and operation labels. |
| Storage/export | `src/storage.ts`, `src/snapshot.ts` | Local captures, output files, runtime discovery and effective snapshots. |
| Selection/list | `src/ranges.ts`, `src/range-rows.ts`, `src/range-list.tsx` | Inclusive ranges, previews, measured variable-height rows. |
| Compaction configuration | `src/compaction.ts`, `src/compaction-menu.tsx` | Mode combinations, mandatory reasoning removal for tool deletion, selection menu. |
| Readers/help | `src/turn-view.ts`, `src/turn-reader.tsx`, `src/summary-reader.tsx`, `src/tui-help.tsx` | Read-only turn extraction, summary editing UI and reserved hotkey footers. |

### Data flow

1. The server validates options, publishes settings/version/control discovery, registers tool-denied helpers, and disables native automatic compaction/pruning in the loaded configuration.
2. The inspector fetches complete session history through the SDK. It does not use the TUI cache as the source of truth.
3. Host-active messages become turns. The operation ledger produces effective blocks, including summaries and pruning/restoration provenance.
4. A requested change captures source identity and policy revision. Before persistence, the controller checks eligibility and replay again, preserving unrelated metadata.
5. Before each main model request, the server's messages-transform hook checks the autocompaction gate, then mutates the supplied array **in place** with the latest effective messages.
6. The host performs its own message conversion and provider processing afterward. Our projection and captures are not the final wire request.

Distinguish four things: stored transcript, effective projection, hook-stage runtime capture, and actual provider request. Never describe one as another.

### Persistence and compatibility

The ordered ledger lives in session metadata under `opencode_context_manager`. It contains source IDs/fingerprints, rules or summary text, an operation cursor, and a revision. Autocompaction strategy/status has a separate namespace and is not undone with context operations.

Policy format **6** is independent of package version **2.0.0**. Readers support formats 1–6; new edits write 6. New modes are `prune-reason`, `tool-prune-all`, and `tool-delete`; `tool-prune` retains the existing large-output rules. Combined pruning uses one operation per range, with `pruneReason: true` on a tool operation; this flag is mandatory for deletion. Unsupported versions/combinations fail validation.

Undo/Redo and Unprune are removed from the UI, controller and checked control writes. Old saved cursors and `unprune` operations still replay exactly, without rewriting on inspection. New operations append to the active prefix and discard inactive legacy redo entries. Keep this compatibility code; removing recovery actions is not permission to reinterpret saved history. No transcript parts are erased from OpenCode storage. Older plugin builds cannot read new policies; require a full restart of both entrypoints and no mixed-version writers.

Older character-based pruning keeps its original units, wording and dependent fingerprints. Token operations pin budgets, encoding and tokenizer library version. Unsupported saved tokenizer builds fail closed instead of reinterpreting history. Do not confuse removing an obsolete config field with removing saved-state compatibility.

Summary blocks carry projection-only provenance (`summaryID`, `previous` blocks, pruning signatures and flags). It is reconstructed through replay, not inserted into provider metadata. Effective exports and model input exclude the hidden expansion layers. `reasonPruned`, `toolsDeleted` and `allToolsPruned` describe the visible USER projection and survive summary expansion; they are not inferred from marker text. Internally, `turn`/`compact`/`brief` still distinguish prompt and replay semantics; the UI displays only USER/SUMMARY.

Forked sessions cannot reuse policies bound to another session's message IDs. Native revert or changed source invalidates pending work. Metadata writes have source/revision checks, but the host API is not compare-and-swap: simultaneous external writers are unsupported.

## Behavior and invariants

### Selection, pruning and expansion

- A turn starts at a user message and includes following assistant messages/tool steps up to the next user message. It can be unfinished or user-only.
- Selection is inclusive, with disjoint closed ranges. Adjacent ranges stay distinct; overlaps are rejected. Existing summaries are indivisible blocks.
- Reading/selecting while busy is allowed. Changes require idle status **or live, server-verified suspended maintenance**. A persisted pause flag is never sufficient.
- Original stored messages/parts are not rewritten. Operations change the effective request view.
- Large-output pruning edits only result text. Preserve inputs, attachments, tool identity/status and provider metadata. A rule reapplied to its own output must not repeatedly shorten it.
- Reasoning pruning removes complete `reasoning` parts, including their opaque metadata. Leave user parts, tool calls and all visible assistant text untouched; do not remove commentary by guessing whether it is reasoning.
- All-output pruning replaces completed/error results with `[Tool output pruned]`, including empty or tiny results without a savings check. Remove tool-result attachments; retain inputs, call identity, status and call-provider metadata. Handle interrupted `metadata.output` and ordinary error text, without retaining the original error alongside a pruned interruption output. Pending/running calls have no saved result to prune and remain pending; native-cleared results can still use the host's cleared-content placeholder.
- Whole-tool deletion removes complete `tool` parts, including pending calls and both call/result data. It requires reasoning removal. OpenCode's inspected converter drops assistant messages containing only step markers; do not manufacture replacement prose or mutate visible assistant text to fill them.
- Pruning is final in effective context, with no recovery action. It does not reach inside a summary, erase stored transcript/spill files, disable future tool execution or remove the current tool catalog. Expand restores one exact pre-summary layer, preserving earlier pruning and nested summaries.
- Expansion has a before/after preview and explicit confirmation, makes no model call, and rejects no-ops. Multi-range changes use one checked metadata write, leaving gaps intact. Combined pruning is one operation per affected range; it never sends a partial pruning combination.
- Summary edits append `revise` operations targeting stable visible summary IDs; they do not rewrite old operations or create a new expansion layer.
- No Undo/Redo, including saved summary edits. A bad source fingerprint fails visibly rather than silently resetting policy or resurrecting pruned content. Historical cursors remain read-only replay data, not a recovery API.
- User-only summary replacements need a distinct deterministic assistant message ID and valid host fields. Never reuse a user ID for an assistant or invent a completed outcome.

### Compaction batches

`SummaryBatch` freezes effective history, runtime capture, source fingerprint, policy revision and the consuming tokenizer once. Each range starts its own tool-denied helper concurrently. Every initial helper receives the **same full pre-batch effective context**, with its own range marked; no sibling result may enter another initial request.

The selected range is the only summary source. Before/after blocks and runtime captures are reference-only background. Validate contiguous source membership and label unfinished snapshots. Preserve useful detailed-summary facts; never import later outcomes or unrelated tasks from outside the range. Binary attachments are descriptors, not decoded content.

For `compact`, count the selected content and the **complete replacement**, including its introduction/wrapper, using the main session's pinned tokenizer. The 2×–20× reduction band is a soft review guide, not a size target:

- Less than 2× reduction: ask once for tighter wording.
- More than 20× reduction: ask once for more useful selected-range detail.
- Exactly 2× or 20×: no follow-up.
- At most one automatic follow-up total, in the same helper. Include source count, replacement count, ratio and tokenizer basis. Do not duplicate the full first prompt.
- Accept the second completed, nonempty result regardless of size. No padding or invention to satisfy a quota; sparse source may legitimately compress much further.

`brief` is single-pass. Empty, failed, cancelled or output-truncated responses are never valid results. Manual compaction does not require net savings; automatic near-limit candidates do.

Once all ranges are ready, the batch **automatically applies** in one checked metadata update. No initial approval stage exists. A failed range leaves successful results pending; retry only unresolved jobs against the original frozen snapshot. A changed session invalidates the batch. Cancellation before persistence prevents late application; a write already in flight may finish and is not promised to roll back.

Each helper is owned and deleted on apply/discard/close. Handle cancellation during helper creation, input preflight and generation. Cleanup failure after a successful write is a separate warning, not a reason to apply twice. Crash recovery for orphaned helpers is not implemented.

### Saved-summary editing

Manual editing explicitly saves a revision. A model edit starts a **new** tool-denied editor session containing only the last applied summary and the change request—never the original range, whole session, runtime capture or deleted compaction dialogue.

Further requests continue that edit dialogue, supplying the latest proposal as authoritative. Model/effort changes preserve the dialogue. Proposals remain unapplied until explicit confirmation; failures retain the previous proposal. Applying or leaving the reader deletes the helper; closing just the request editor does not. A later edit starts fresh from the then-applied summary. No compact-size retry runs for edits.

### Token and output handling

`gpt-tokenizer@4.0.0` provides local `o200k_base` and `cl100k_base` tokenization. Explicit provider/model overrides take priority; otherwise use known model/API-alias mappings, then the configured fallback. Show provenance honestly: unknown models are not verified matches. Keep count/merge caches bounded and treat special-token-looking log strings as literal text.

Display, pruning and compact-size review use the **main model's** tokenizer. Helper input preflight uses the **selected helper model's** tokenizer and the entire accumulated helper dialogue plus system instruction and a 2,048-token framing margin. Compare estimated input to advertised input capacity, falling back to context capacity. Do not silently drop background or switch models.

No plugin output reservation or output cap is applied. Preserve host/provider parameters, including deliberately omitted `maxOutputTokens`. Input preflight does not guarantee response room in a shared input/output window.

Large-mode token-budgeted head/tail extraction keeps exact original substrings at valid Unicode boundaries, recounts retained pieces, includes notice/link overhead in net savings, and skips non-saving edits. All-output removal intentionally ignores these limits, even if a marker is larger than an empty result. Fresh spill limits use lines/UTF-8 bytes, separately from historical token pruning. Existing native spills may already have been created before our tool hook; validate their real paths before reading. Preserve native and MCP result shapes and non-text attachments during ingestion/large-mode pruning.

Metrics count known content, not inspector IDs/labels. Loaded skill bodies must not be double-counted as ordinary tool output; runtime overhead is session-wide, not allocated to selected turns. Provider usage is historical evidence, not a recount after edits. Media, hidden reasoning, provider framing and unavailable inventories remain unknown—not zero.

### Autocompaction and same-loop resume

Check before **every main-session provider request**, including after new input and after saved tool results. Prefer a positive advertised `limit.input`; otherwise derive `limit.context - limit.output`. Pause when estimated effective context **exceeds** that budget minus configured headroom. Equality fits. Invalid/nonpositive budgets fail visibly; headroom is not an output cap or an exact-wire overflow guarantee.

The gate waits in the messages-transform hook, not in `tool.execute.after`, which runs before ordinary tool-result persistence. The host may already have allocated an empty assistant record. Releasing the gate resumes the existing loop with updated projection and **no added user/continue message**. Do not fake resume through public `session.prompt()`, which creates a user message even with `noReply`.

The entire active last USER turn is protected during suspension. No manual pruning mode, summarization or expansion may alter it. Protect the whole turn because resumption appends within it. Recheck source identity, native revert, policy and live ownership before maintenance and release.

Strategies are per-session preferences:

- `MANUAL`: show pause/budget/excess/protected-turn details. Exit offers Stay, Resume only if within threshold, or Abort. No over-budget override.
- `AUTO_PER_TURN`: try each earlier ordinary USER oldest first, once per pause. Discard non-saving candidates; recount successful reductions. If needed, try the whole earlier prefix once, including summaries.
- `AUTO_SESSION`: try that earlier prefix once.

AUTO candidates use compact's normal size review but apply only net-saving replacements. Successful summaries remain expandable if later work fails. Resume only when the recount fits; otherwise remain suspended for maintenance. If the protected turn alone exceeds the threshold, earlier reductions cannot solve it. No endless retry loop.

Saving a strategy does not execute it. Running an AUTO strategy while already paused requires an explicit action. Helper sessions are excluded from this gate and use their own input checks.

`autocompaction.ts` owns the in-memory authority; `control.ts` exposes authenticated **127.0.0.1-only** commands and checked commits. Serialize per-session maintenance, status publication, run/resume/abort; an old owner must not overwrite a new owner's status. Preserve complete UTF-8 bodies across network chunks. Cancellation revokes ownership; late results cannot apply or resume. A host restart ends the live suspension, even if old status metadata remains.

## OpenCode integration

Use official [plugin documentation](https://opencode.ai/docs/plugins/), [configuration documentation](https://opencode.ai/docs/config/), the [server schema](https://opencode.ai/config.json), [TUI schema](https://opencode.ai/tui.json), and the [OpenCode source](https://github.com/anomalyco/opencode). Check the installed executable version and the matching declarations/implementation before changing host-facing code. Online development docs may describe a different release.

Relevant paths in the inspected host source layout:

| Path | What to verify |
| --- | --- |
| `packages/plugin/src/index.ts` | Server hook declarations. |
| `packages/opencode/src/plugin/index.ts` | Loading, registration and hook ordering. |
| `packages/opencode/src/session/prompt.ts` | Ordinary session loop, helper prompts and transform placement. |
| `packages/opencode/src/session/message-v2.ts` | Message conversion and provider-metadata forwarding. |
| `packages/opencode/src/plugin/openai/codex.ts` | Auth/provider-specific output-parameter handling. |
| `packages/opencode/specs/tui-plugins.md` | TUI plugin contract and target separation. |
| `packages/tui/src/app.tsx` | Host keyboard modes and route interaction. |

The SDK import `@opencode-ai/sdk/v2` does not mean the newer host session engine is in use. The server plugin receives a legacy SDK shape; isolate compatibility casts/adaptation in the host adapters. Do not import private host modules into the distributable plugin.

Integration rules worth testing explicitly:

- Mutate the hook's message array in place; replacing a local reference is insufficient.
- Provider metadata is not scratch space. Namespace values may be forwarded to AI SDK provider options and must keep their expected shapes. Sidecar bookkeeping must never leak there.
- Built-in provider hooks can deliberately omit output caps. Do not restore them afterward.
- `steps: 1` is not a safe one-response limiter: the host can append an unrelated work-recap instruction. Use deny-all tool permissions for helpers instead.
- `default` is a valid model-variant sentinel even if absent from `model.variants`. Filter selectable models to connected providers.
- Tool definitions may expose framework schemas, not JSON Schema. Captured catalogs are model-filtered/default-agent observations, not a complete final permission-filtered/MCP inventory.
- Canonicalize object-key order for fingerprints across API serialization; raw `JSON.stringify` order is insufficient.
- Reject native compaction while active plugin operations would make it unsafe. Do not mark plugin replacements as native compaction checkpoints.

## Terminal UI

Keep UI actions deterministic and out of ordinary prompt text. Register separate routes/modes and yield to native dialogs. Do not let reader navigation, text entry or host model shortcuts trigger actions behind the active view.

### Controls to preserve

| View | Keys |
| --- | --- |
| Range list | Arrows/j/k; Shift+Up/Down by five; PageUp/Down by viewport; Home/End. Space opens/closes a range or removes the closed range under the cursor. Esc cancels an open range first. |
| Main actions | `c` opens compaction configuration for closed ranges; `Ctrl+E` previews summary expansion; `Ctrl+S` confirms expansion. No p/b shortcuts, Undo/Redo or Unprune. |
| Compaction configuration | Arrows/j/k, Home/End navigate six modes; Space toggles; Enter runs; Esc cancels; `m/t` chooses model/effort. |
| Inspection | Enter opens hovered turn/summary; `v` cycles detail views; `n` switches token/character diagnostics; Tab switches pane focus; `f` reloads and clears selection; `o` exports; `?` shows help. |
| Automation/batch | `a` saves strategy; `g` retries a pending failed batch, otherwise runs AUTO while paused. Failed batches keep `m/t` model/effort selection. |
| Readers | Arrows scroll 10 display lines; PageUp/Down one viewport; Home/End; Esc returns with selection/cursor preserved. |
| Summary editing | `e` manual edit; `r` model request; Ctrl+S saves/sends/applies according to active mode; Esc cancels the current editor or leaves the reader. `m/t` picks model/effort; Ctrl+O/T works inside the request editor. |
| Paused exit | `s`/Esc stays; `r` requests checked resume; `a` aborts and exits. |

Rows are content-sized up to `ui.maxLinesPerTurn` (default 4, minimum 3), with no padding. USER rows show header, sparse tool stats and user preview; summary rows omit tool stats and show the applied summary, including revisions. Skip blank lines only in menu previews. Keep stable original turn spans and `R1`, `R2`, `Rn*` labels. Use measured geometry for cursor reveal and paging after resize or reader return.

Compaction configuration defaults to detailed summarization and retains choices for that inspector only. Reasoning may combine with one tool mode. Selecting a summary clears all pruning; selecting pruning clears a summary; tool modes replace each other. Deleting tools selects and locks reasoning removal until deletion is deselected. Enter with no mode selected fails without a write. Opening/cancelling configuration is read-only. Keep whole-context and selected-range totals visible, and prevent model-picker keys from also toggling or running compaction behind it.

USER stats always show `tools` including zero, except all-output-pruned rows replace it with `pruned`. `large` replaces the former `eligible` label and still means the current large-output rule would change the result. Add `no tools` after deletion and `no reason` last after reasoning removal. Keep file previews, pending and native-cleared counts distinct. Aggregate removal flags are shown only when all visible USER blocks have that flag; do not claim a mixed selection has no tools/reasoning.

Keep whole-context and combined-selection totals pinned while category details scroll. Fixed footer space prevents hotkey/content overlap. Key names use theme primary; labels/separators/notes use muted color. Fullscreen readers have fixed header/footer rules outside their scrollbox. Ordinary readers exclude reasoning/tool activity/intermediate commentary and label missing/unfinished final answers honestly.

OpenTUI details for the pinned version:

- Select has a one-line description; item spacing does not make a multiline row. Use composed scrollbox rows for rich previews.
- Fixed-height text widgets can consume wheel events and scroll internally. Use clipped containers around auto-height preview text so list scrolling never hides the preview's beginning.
- Read textarea text from its renderable ref's `.plainText`; callback declarations alone are not reliable evidence of runtime arguments.
- Inline span color uses `style={{ fg: ... }}`. Inspect child-rendered color chunks with `textNode.toChunks()` in renderer tests.
- Size pickers for name/description rows plus decorations, cap to terminal height, and preserve selection across resize.
- Await standalone Escape parsing in tests before sending another Escape. Send encoded terminal keys, not literal key-name strings.

## Testing

### Unit, adapter and renderer tests

`npm test` runs `test/*.test.ts` through Node/tsx. `npm run test:tui` runs the actual OpenTUI renderer via the pinned Bun launcher with browser conditions and the Solid preload. `npm run check` runs typecheck and both suites.

Add a regression that fails before a bug fix when practical. Test the exact failing transition, not just a nearby happy path. In particular, a history edit must be followed by the next **same-model main request before another compaction hides the edited parts**.

Coverage should include:

- Threshold equality, Unicode/UTF-8, long lines, literal special-token-like text, net savings and unchanged inputs/metadata/attachments.
- Saved-policy replay, legacy fingerprints/cursors/unprune entries, nested expansion/revisions, retained pruning flags, forks and stale sources. New controller/control writes must reject Unprune and cursor rewind.
- All pruning combinations, small/empty/error/interrupted results, result attachments, opaque reasoning parts, whole-call removal and unchanged visible text. No-op pruning must not add entries; summary expansion must never restore content pruned before that summary.
- Both soft-size review directions and exact boundaries, at most one retry, truncated/empty failure, full helper history and unchanged provider caps.
- True parallel workers with identical frozen background, failed sibling retry, one metadata write, cancellation during creation/preflight and cleanup after successful persistence.
- Fresh summary-only editing and continued proposals without original-history leakage.
- Live-gate ownership, protected turn, strategy-save versus run, budget derivation, no-savings skip, abort and restart-stale status.
- Fullscreen reading, focus/dialog guards, variable-height rows, resize, long previews, preserved selections, footer bounds at 80×24 and short-terminal picker behavior.

### Installed-host fake-provider smoke test

This exercises the installed executable, not just mocked SDK calls. From the repository root, replace placeholders with an **absolute native executable path** and an **unused absolute temporary directory**:

```sh
npx --no-install tsx script/host-smoke.ts "<absolute-opencode-executable>" "<fresh-absolute-temporary-root>"
```

The runner expects a directly spawnable executable (on Windows, the actual `.exe`, not a PowerShell shim). Confirm port **41973** is free. Do not stop another process to claim it. Do not point the root at a real project or reuse a normal OpenCode data directory.

The fixture redirects home and XDG/config/storage, uses synthetic sessions and a loopback fake provider, and disables default plugins/external skills. It can still bootstrap host/provider dependencies from the package registry. Its provider uses an ephemeral port; the host uses 41973. It writes a host log and `result.json` under the chosen root and stops its owned child in cleanup.

It covers loading/settings, spill/large-result pruning, valid immediate same-model requests after reasoning removal, all-output removal and whole-call deletion, compaction/revision/expansion, a barrier proving parallel arrival before either response completes, saved-summary editing, user-only turns, exports, and MANUAL/AUTO same-loop pause/resume/abort. Inspect the result, process exit and released port; a PASS line alone is insufficient if cleanup failed. The generic fake provider does not validate every provider's signed-reasoning dependencies.

When launching from a Windows automation tool that cannot wait safely, use a detached supervisor with closed inherited handles and ordinary stdout/stderr files. Record owned PIDs, poll completion, and verify executable/command line before terminating anything. Never use a broad process-name kill or terminate the user's TUI. A foreground terminal invocation is simpler when available.

Fake-provider tests prove protocol/flow, not semantic summary quality or arbitrary provider compatibility. Prompt changes may need a separately authorized bounded live test and human review.

### Optional live-provider check

**Not part of `npm run check`. Uses configured credentials and can incur cost.** Obtain explicit permission for the provider/model and request bound first. Never send an existing conversation as test input.

```sh
npx --no-install tsx script/live-summary-smoke.ts --allow-live "<absolute-opencode-executable>" "<fresh-absolute-temporary-root>" "<providerID>" "<modelID>" "default" "brief-scope"
```

Port **41974** must be free. Unlike the fake-host test, this script intentionally loads installed global configuration/authentication, so the current server plugin must be registered there. It creates a fresh session database, disables project config and MCP, and sends only synthetic text. Other globally configured plugins can still load: this is not a clean configuration sandbox.

`compact` (default scenario) sends one direct synthetic summarizer request; it does not exercise the controller's entire size-review loop. `brief-scope` sends at most two scope fixtures. Helpers are deleted and the owned host is stopped on normal cleanup. Verify both `passed` and `cleaned` in its local result.

The safety plugin has an OpenAI-specific assertion expecting an omitted output cap, designed for that adapter/auth path. It is not a universal contract for every OpenAI API configuration. Adapt the fixture deliberately when testing another path; never alter production provider caps just to satisfy the fixture. Result files can include model output and local identifiers; keep them private.

## Privacy and security

Runtime storage is `~/.local/state/opencode-context-manager/<hash-of-project-directory>/`, independent of the repository's ignored `.local/` scratch folder. It holds `runtime.json`, captures, spill outputs and explicit exports. Plugin outputs older than seven days are cleaned on startup; captures/exports remain until removed. Native spill retention belongs to OpenCode.

`runtime.json` contains a local control capability. Do not print it, include it in model prompts/exports, attach it to an issue, or commit it. Bind control to IPv4 loopback, authenticate commands, and reject non-loopback destinations. Files use restrictive creation modes where supported; Unix permission modes are not a substitute for reviewing Windows ACLs or local-machine trust.

Effective snapshot schema **2** includes effective content, policy, token/character distributions, tokenizer provenance, historical usage and latest runtime observations. It excludes hidden original expansion layers, not every potentially sensitive string. Prompts, code and tool output may already contain secrets; there is no general redaction guarantee. Capture absence/staleness and unknown inventory/media costs must stay visible.

Provider errors should show name, HTTP status and useful message, not raw headers, cookies or response metadata. Treat user-supplied logs and model error text as potentially sensitive even when the formatter removes known fields.

Before sharing a bug report, reduce it to synthetic input and include host/plugin versions, OS/terminal, sanitized options, reproduction steps and expected/actual behavior. Never attach auth files, session databases, raw captures or a full working-directory archive.

The ignore rules are a safety net, not a secret scanner: already-tracked files stay tracked, and forced additions bypass ignores. Review staged paths, diffs and commit identities. Do not upload `.local/`, `.git/`, dependencies or backup bundles. Use a Git checkout/archive of reviewed public refs when preparing a source archive.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Command missing / server runtime unavailable | Both entrypoints in the correct config files, same checkout/version, full restart; initialize a normal session. |
| Unknown setting | Use the README's schema. `unit` and `outputReserve` are not accepted. Options belong on the server entrypoint. |
| Message schema error after pruning | Reproduce the immediate next main request; inspect provider-metadata shapes and call/result pairing. Do not use metadata for internal hashes. |
| Unsupported output parameter | Inspect upstream provider hooks. Confirm the plugin leaves both numeric and omitted caps unchanged. |
| Summary recaps unrelated work | Verify selected/background boundaries and helper system prompt; check for injected host step-limit instructions. Synthetic transport success does not establish semantic fidelity. |
| Stale source/revision | Reload and select again; restore the original host source when replay itself fails. Do not bypass fingerprints or reset policy. Finish native revert/undo first. |
| Pause cannot resume | Check threshold and protected active turn. Only the live owning server can release the loop. Abort if the active turn alone is too large or ownership/source is invalid. |
| Headless session appears stuck | MANUAL near-limit mode waits for a controlling client or abort; it does not create its own continuation prompt. |
| Correct tests, broken terminal focus/layout | Check native dialog guards, host mode, measured layout after resize, textarea refs and encoded keyboard events. |
| Missing Bun/OpenTUI binary | Reinstall lockfile dependencies including optional packages for the platform; do not rely on the skipped-postinstall Bun shim. |

Known boundaries: no remote artifact transport, no durable suspended-loop recovery, no transactional multiwriter state, no universal signed-reasoning/multimodal/provider guarantee, and no claim of semantic losslessness or exact billing counts. Keep these visible rather than working around failures by silently dropping input.

## Changes and releases

Keep pure rules separate from host, storage and UI adaptation. Prefer readable, small changes over new abstractions. Reuse the synthetic fixtures; keep machine-specific paths, personal model settings and private investigation notes out of public files.

For a pull request:

1. State the behavior change, unchanged invariants, and failure/cancellation behavior.
2. Add focused regressions and update this guide or the README when the contract changes.
3. Run `npm run check` and `git diff --check`.
4. Run the installed-host fixture for hook, projection, provider-shape, persistence or suspension changes. Label UI-only/type-only coverage honestly when no host test was needed.
5. Report exact validation and remaining limits. Never imply fake-provider tests establish real-model quality.
6. Inspect staged files for private content; do not include generated logs/results or local config.

For a release:

- Update `package.json`, both root package version entries in `package-lock.json`, `src/config.ts`, and the README together. Runtime version checking requires both entrypoints to agree.
- Change policy or dump versions only for their own format changes; preserve replay compatibility or provide an explicit migration plan.
- Revalidate host compatibility, clean dependency installation, complete checks and the relevant installed-host flow. Review production dependency audit findings without blindly force-upgrading the lockfile.
- Verify a clean public checkout works without `.local/`. Review public refs/history, commit identity and archive contents—not only the working-tree diff.
- Keep `private: true` until npm publication and packaging are explicitly planned. Do not document a nonexistent registry package or release URL.
- This repository currently has **no license**. Do not present it as permissively licensed; licensing must be decided explicitly before granting reuse rights.
- State supported/tested versions and require a full restart after updating. A version number is not evidence of compatibility with every host/provider.
