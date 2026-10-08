# Contributing

User installation/options are in [README.md](README.md). This package targets **OpenCode 2.0.24**, not V1. Keep private research, captures and logs under ignored `.local/`; public code and checks must work without it.

## Setup and checks

```sh
npm ci --ignore-scripts
npm run check
npm run test:host -- /absolute/path/to/opencode
# Linux + Python 3: exercise the actual inspector in an 80×24 terminal
npm run test:host -- /absolute/path/to/opencode --tui
npm run test:usage -- /absolute/path/to/opencode
npm run test:subagents -- /absolute/path/to/opencode
git diff --check
```

`check` runs typecheck, Node/tsx unit/adapter tests, and actual OpenTUI renderer tests. `script/test-tui.mjs` launches the optional platform-specific **Bun 1.4.2** binary directly; global Bun and installation scripts are unnecessary. Do not omit optional dependencies. Linux musl and Windows use their corresponding binaries. Python is needed only for the optional Linux PTY smoke.

V2 packages are pinned to **2.0.24**, OpenTUI to **0.5.14**, and Solid to **1.9.15**, matching the inspected host. Published OpenTUI has an older exact Solid peer; the explicit npm override matches the host rather than using `--force`. Seroval is overridden to patched **1.6.8**. Revalidate these overrides before changing versions. Remaining low-severity Babel-chain audit findings are not fixed by blindly jumping to Babel 8.

Node 22 works for the pure checks; renderer execution uses Bun. OpenTUI's Node-backend engine requirement is Node **26.4+**, so npm can warn on Node 22. Use the provided Bun launcher, not direct Node JSX execution.

No bundler/build is required for installation. Configure the **`src/` directory**; V2 resolves `server.ts` and `tui.tsx`. Native source/config reload releases scoped registrations. Dependency updates require a service restart and TUI reconnect, which interrupts active work.

### Installed-host verification

`script/host-smoke.ts` uses the actual production entrypoints and RPC/controller workflows. `script/host-fixture.ts` starts a private foreground server and a loopback fake provider on ephemeral ports. It uses fresh HOME/config/data/cache/state directories and an explicit environment—not real credentials, MCP servers, or the shared service.

The runner prints its temporary root, normally `/tmp/opencode/context-manager-full-*`. Inspect `result.json`, `host.log`, `stdout.log`, and `requests.json`. Both the scenario result and `cleaned` must succeed. Only owned processes are stopped. A supplied destination must not already exist.

The optional PTY driver connects explicitly to that private server. It exercises actual slash-command loading, range editing, native dialog focus, readers, summarization, model-edit proposals/application, expansion, and resize. Its text snapshots decode terminal cursor updates; concatenated ANSI output is not a reliable screen representation.

The earlier low-level V2 contract fixture is also available:

```sh
npm ci --prefix test/v2-host --ignore-scripts
npm run test:v2-host -- /absolute/path/to/opencode --tui
```

That isolated fixture is excluded from default typecheck and typechecked by its command. It is **not** the installed context-manager plugin; the production smoke must pass too.

All default tests use synthetic content. Fake-provider success proves protocol/flow, not semantic summary quality or arbitrary signed-reasoning/provider compatibility. Live tests require explicit permission for provider/model and request bounds; no live-provider runner is enabled by default.

## Architecture

| Area | Files |
| --- | --- |
| V2 lifecycle, hooks, agents, RPC registration | `src/server.ts` |
| Public in-process session/model/helper adapter | `src/host.ts` |
| Shared RPC schemas / remote inspector adapter | `src/rpc.ts`, `src/control.ts` |
| Stable internal DTOs / native normalization | `src/model.ts`, `src/v2/normalize.ts` |
| Ledger replay, turn grouping, summaries, expansion | `src/context.ts` |
| Canonical request patching / native validation | `src/v2/projection.ts`, `src/v2/request.ts` |
| Public idle observation / history utilities | `src/v2/activity.ts`, `src/v2/history.ts` |
| Provider-anchored guard and request observations | `src/v2/budget.ts` |
| Controller, parallel batch and saved-summary editor | `src/controller.ts`, `src/batch.ts`, `src/summary-editor.ts` |
| Budget gate and strategy/ownership state | `src/autocompaction.ts`, `src/auto-state.ts` |
| Exempt-tail selection and bounded emergency summaries | `src/last-resort.ts` |
| Token rules, metrics and display status | `src/text.ts`, `src/tokens.ts`, `src/metrics.ts`, `src/status.ts` |
| Server-local files and effective export | `src/storage.ts`, `src/snapshot.ts` |
| Inspector/view adapter and components | `src/tui.tsx`, `src/ui.ts`, list/menu/reader/help TSX modules |

### Data flow

1. Server setup validates options, registers hidden deny-all helpers, hooks, and native RPC. It does not mutate configuration files or expose a second HTTP server.
2. The inspector reads server snapshots through RPC. It never uses the TUI message cache as editing authority.
3. Native active transcript is normalized into the small domain DTOs used by established replay/workflow logic. Native source hashes pin fields that normalization does not render.
4. Replay generates effective blocks; operations carry source identity and expected revision. Server-side checked commits replay again and merge only the policy into current metadata.
5. The host has **already lowered** history to canonical `@opencode/ai` messages before `context` hooks. We patch owned message/call/result entries, not cast envelopes into that array or rebuild the private host converter.
6. Summary replacements use anchored entries. Expansion restores their exact pre-summary entries, including earlier pruning, while chronological system/effort/location context remains in place.
7. Before each main request, the live gate recounts the actual canonical projection plus available system/tool text. Release continues the same request with updated policy and no new prompt.

Stored transcript, normalized effective projection, hook capture, and final provider request are distinct. Exports/counters must not claim wire accuracy.

### Persistence and migration

The ledger remains in session metadata under `opencode_context_manager`; strategy/status uses a separate namespace. Ordinary format-7 writes remain supported. A checkpoint upgrades to **format 8**; subsequent writes retain8. The `checkpoint: true` compact operation splits a USER block after its final source message before replay, so later assistant/tool continuations cannot move that saved boundary. Package version and export schema version are independent.

Formats 1–6 still have offline regression readers, preserving old fingerprints/cursors/unprune behavior. Native adapters reject old/forked ledgers. Ordinary fresh child sessions (parentID, no fork) receive an empty own ledger only after validating any copied ledger belongs to an ancestor; unrelated metadata is retained, inherited live-pause notices removed. Own ledgers and unrelated/corrupt copies are never silently reset. Initialization is coalesced per session and pending writes drain on unload.

Expansion provenance is replay-only. It must not enter provider metadata, helper input, or effective exports. New revisions target stable summary IDs without creating another expansion layer. New writes cannot rewind cursors or add Unprune.

Native `session.context` exposes the active window, not arbitrary pre-checkpoint history. Host checkpoints are read-only. Later turns can be edited without discarding a checkpoint or restoring history behind it. The public-client history utility supports cursor pagination when a complete timeline is required; limit 0 is not valid in V2.

## Invariants

### Editing and request projection

- A USER row starts at a user message; following synthetic/skill/shell context belongs to that effective range. Host control/system/idle records are not editable USER text. Unfinished/user-only snapshots must be labeled honestly.
- Ranges are inclusive and disjoint; adjacent ranges remain separate. Existing summaries are indivisible until expanded.
- Never rewrite transcript messages/parts. Operations alter the request projection only; spills are ingestion-time previews with full captured text saved separately.
- Reasoning removal removes whole reasoning parts, including opaque part metadata, but does not guess that commentary/visible text is reasoning.
- Large tool pruning changes model-visible result text only, preserves inputs and attachments, keeps Unicode boundaries, pins tokenizer/rule identity, and skips non-saving or duplicate rule applications.
- All-output pruning replaces every terminal result, including empty/error results and attachments. It must not leave original interruption output in the error/content fields.
- Whole-tool deletion removes both calls and results, including hosted pairs, and requires reasoning removal. Empty wrappers disappear without invented assistant prose.
- Leave unselected messages, typed tool output, and provider call state alone. Never put plugin provenance in `providerMetadata`.
- Operate on the **current canonical result**, not an earlier unredacted stored result. Reject unknown shapes/ownership rather than guessing.
- Native checkpoints, unsettled historical tool calls, ambiguous failed reasoning, and opaque provider-result pruning have explicit pre-write guards. Summary/whole-call deletion is available where it can safely replace the whole selected material.
- Pending work must be invalidated by source/revision changes, native revert, location changes, or cancellation. Metadata writes are not host-wide CAS; concurrent arbitrary external writers remain unsupported.

### Summaries and edits

- Freeze effective history, runtime background, source fingerprint, policy revision, and consuming tokenizer once per batch.
- Each initial helper sees the **same full pre-batch effective context** with only its own selected range marked. Never include sibling results in another initial request.
- The selected range is the only source to summarize; before/after/runtime regions are background. Preserve unfinished state and describe binary attachments without inventing their contents.
- Detailed mode uses a soft 2×–20× review band on the complete wrapped replacement; exact boundaries need no retry. At most one follow-up; accept the second completed nonempty response regardless of size. Brief mode is single-pass.
- Empty, truncated, failed, or cancelled responses are invalid. Manual summaries need not save tokens; automatic near-limit candidates must.
- Apply the complete successful batch in one checked write. Failed siblings block partial application; retry only unresolved jobs against the frozen source. Cancellation prevents late application, except a write already in flight is not promised to roll back.
- Saved-summary editing starts a new deny-all helper containing only the applied summary and edit request. Further edits continue that dialogue; proposals require explicit apply. No original-range/background leakage and no size-review retry.
- Helpers are tracked by server generation and parent session, with client-side cleanup tracking. Close/discard/apply/abort/reload removes owned helpers. Crash recovery of abandoned helpers is not implemented.

### Autocompaction and cancellation

- Require explicit `compaction.auto: false`; native auto/overflow compaction runs before the context hook. Reject native compaction while the plugin owns this workflow.
- Check every main request, including tool-driven continuations. Use positive `limit.input`, else `context - output`, minus configured headroom. Equality fits. Invalid budgets fail visibly. Never change host/provider output caps.
- The guard uses normalized per-response input+cached read/write and visible output+reasoning exactly once, never session-wide accumulated spend. Pair the report with its captured outgoing request using an unchanged native prefix and exact model/agent/configuration/tokenizer scope; helpers are independently scoped. Ignore failed/missing/malformed measurements.
- Save hashed count units and a policy hash, not prompts/credentials. Pair only the immediately following assistant: interrupted attempts/new input cannot be mistaken for the sampled request. Drain pending accounting writes on unload. Never use transient generation to overwrite primary observations.
- Recount edits against the same frozen anchor. Charge added units separately from removed units, with growth multiplier at least `max(estimateMultiplier, reportedInput / sampledLocalInput)`; removal credit is unscaled local count. Do not use a permanently unchanged old reported floor, scale removal credit as exact savings, or recalibrate the baseline from each candidate.
- Bootstrap without a captured request is explicitly unpaired. Reconstruct a historical policy prefix excluding operations created after the response began or selecting that response/future messages. This is not proof of historical request identity; timestamps/configuration can be uncertain. New matched observations supersede it.
- Native checkpoint/raw-prefix changes and model/provider/variant/agent/tokenizer/route changes invalidate incompatible anchors. Do not immediately bootstrap from the very historical reports just invalidated by a scope change. Live gate validation checks current route/model configuration and capacity before maintenance/resume.
- Missing usage falls back to a visible configurable local uplift (default 1.3). Unknown overhead remains uncertain; no universal media/opaque-state/provider bound is claimed. Keep local content totals, historical reported usage and the actual guard forecast clearly separate in the UI/export.
- If oversized context has no USER turn, fail before dispatch instead of skipping the budget guard or inventing a protectable turn.
- Protect the entire V2 execution span since the last idle boundary for normal edits. Only the live server AUTO owner may create a last-resort checkpoint across that boundary; arbitrary RPC/idle commits cannot grant themselves this exception. Recheck source/revision/configuration and the exact unchanged exempt tail before committing. Queued inputs must be delivered exactly once.
- A stored pause notice is not authority. Only the current in-memory owner can maintain/resume; source and protected-span fingerprints must still match.
- `session.wait` supplies positive process-local idle evidence without starting work. Timeouts mean busy/unknown; pending observations are coalesced. It is not a lock against independent admission.
- Check idle again immediately before acquiring the gate: Promise hooks do not receive cancellation signals, so Stop during async preparation must not create an orphaned suspension.
- AUTO_PER_TURN is the default. Children map inherited/selected MANUAL to AUTO_PER_TURN. Top-level MANUAL requires cleanup and explicit release. AUTO_PER_TURN tries earlier USER rows once then the prefix once; AUTO_SESSION tries the prefix once. Both then attempt the largest safe prefix before `lastResortKeepTokens` (default20000), retaining whole native messages/tool pairs and whole summaries. Tail counts use local content plus rough image/PDF allowances, not exact provider tokens.
- Last resort may split an unfinished turn at a settled message boundary. Prefix-only helpers are independent conversations; split serialization without dropping Unicode content, then merge ordered partial summaries, bounded to four rounds/64 requests. Preserve host output caps and validate completed nonempty responses. Commit only a complete fitting candidate, otherwise terminate AUTO without manual recovery. Original transcript, exempt tail, system/tools, provider-budget anchor and helper isolation must remain intact.
- Resume by releasing the original hook wait. Never fake continuation using `prompt`, `synthetic`, or interrupt-and-reprompt.
- Stop, move, delete, reload and unload revoke ownership. Event-stream loss fails closed. Old finalizers cannot overwrite a newer owner's state; late helper results cannot apply or resume it.

### UI

Preserve range controls, keyboard navigation, reader selection/cursor state, visible totals, separate model/effort choices, explicit summary application, and paused exit choices. No ordinary prompt-text commands behind the inspector.

The view adapter maps public V2 theme tokens and routes. Input guards use public keymap modes: `base`, our `context-manager` mode, and native modal ownership. There is no private `dialog.open` cast. Native dialogs/model pickers must never trigger actions underneath them.

Keep content-sized rows capped by `maxLinesPerTurn`, measured cursor reveal/paging, fixed headers/footers, and 80×24/short-terminal coverage. Textarea data comes from `.plainText`. Send text and Return separately in real-terminal tests so autocomplete can update.

## Evidence and change workflow

Use official [V2 plugin](https://opencode.ai/v2/docs/build/plugins), [migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1), [RPC](https://opencode.ai/v2/docs/build/plugins/rpc), and [CLI plugin](https://opencode.ai/v2/docs/build/plugins/cli) docs. Confirm exact release declarations and runtime behavior; search indexes and current docs have shown incompatible examples.

Important pinned-source locations: `packages/plugin/src/promise/*`, `packages/plugin/src/tui/*`, `packages/core/src/session/model-request.ts`, `session/runner/to-llm-message.ts`, `session/runner/llm.ts`, `session/compaction.ts`, `plugin/host.ts`, and generated `packages/client/src/promise/generated/*`.

Do not import Core/private host modules. V1 SDK `/v2` was not the V2 client. Promise APIs have per-method result shapes; not every result has `.data`. Pinned RPC requires explicit `events`, `input`, `output`; output must be JSON without undefined fields. Declare expected RPC errors to avoid hiding them behind `rpc.internal`.

For changes:

1. Add a regression for the exact failing transition. For history edits, inspect the **next same-model main request** before another summary can hide it.
2. Keep pure replay/rules separate from host and UI adaptation. Do not rewrite stable workflows merely to mirror host DTOs.
3. Run all checks and production smoke for hook/projection/persistence/suspension changes. Label renderer-only or fake-provider coverage honestly.
4. Update README/development docs. Keep package/lockfile/version constants coordinated; change policy/export versions only when their formats change.
5. Verify a clean public tree works without `.local/`. Review all staged paths, diffs, identities, and audit results. No forced dependency upgrades.

## Privacy and limits

Server artifacts are under `~/.local/state/opencode-context-manager/<project-hash>/`. Spill files older than seven days are cleaned on startup; captures/exports remain. Files use restrictive creation modes where supported; review local ACLs separately.

V3 creates no control credential file or custom listener. Native RPC uses host authentication. Historical V1 `runtime.json` artifacts can still contain old credentials; do not commit or share them.

`budget-<session-hash>.json` is a versioned accounting cache of scope/history/content hashes and counts. It is independent of policy format 7/8 and contains no prompt text or provider credentials. Captures and budget files remain on disk; do not delete accounting state to force a paused request through. The live gate uses its own frozen estimator, and missing files require a conservative bootstrap on subsequent requests.

`script/usage-smoke.ts` emits deliberately mismatched OpenAI-style SSE usage. It verifies provider-triggered MANUAL/AUTO pauses with low local counts, cached/reasoning normalization, summary and large-prune resume, tool-result growth, restart persistence, pre-upgrade edits, model/endpoint invalidation (including a held gate), and isolated helper capacity checks. It uses the same owned private host/fake-provider isolation as the production smoke.

`script/subagent-smoke.ts` enables the real built-in subagent tool in an isolated fixture with nesting depth4. It tests foreground/background and nested children of edited MANUAL parents, independent ledgers, last-resort same-turn continuation, exact retained tool output, steering/queue delivery, summary failure, ancestor Stop, no manual gates, and persisted checkpoint restart. Fake providers prove mechanics, not semantic summary quality.

Exports exclude hidden expansion layers, not every possible secret. Original history/spills remain; pruning is not secure erasure and disabling the plugin can restore original context. Keep model/provider errors useful without dumping headers/credentials. Share only synthetic, sanitized reproductions.

Known boundaries: no automatic old-ledger migration, no remote artifact transport, no orphan-helper crash recovery, no external-writer transaction guarantee, no universal signed-reasoning/opaque-checkpoint/WebSocket/provider guarantee, and no exact token/billing or losslessness promise. Keep the package `private: true`; this repository has no license grant or published npm release.
