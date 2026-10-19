# Contributing

User installation/options are in [README.md](README.md). This package targets **OpenCode V2**, with **2.0.28** as its dependency baseline. Keep private research, captures and logs under ignored `.local/`; public code and checks must work without it. Treat the OpenCode source checkout as read-only research: implementation must use public APIs, without a host patch or fork.

## Setup and checks

```sh
npm ci --ignore-scripts
npm run check
npm run test:host -- /absolute/path/to/opencode
# Exercise the actual inspector in an 80×24 terminal, including Windows ConPTY
npm run test:host -- /absolute/path/to/opencode --tui
npm run test:usage -- /absolute/path/to/opencode
npm run test:subagents -- /absolute/path/to/opencode
node --import tsx script/fork-smoke.ts /absolute/path/to/opencode --tui
npm run test:revert -- /absolute/path/to/opencode --tui
npm audit
git diff --check
```

`check` runs typecheck, Node/tsx unit/adapter tests, and actual OpenTUI renderer tests. `script/test-tui.mjs` launches the optional platform-specific **Bun 1.4.2** binary directly; global Bun and installation scripts are unnecessary. Do not omit optional dependencies. The PTY smoke uses prebuilt `@lydell/node-pty` and `@xterm/headless`; it does not require Python or WSL. PTY support is limited to the platforms supported by those prebuilt binaries.

V2 packages are pinned to **2.0.28**, resolving Effect **4.0.1**; OpenTUI remains **0.5.17**, and Solid **1.9.17**. Published OpenTUI still has an older exact Solid peer; the explicit npm override keeps one tested Solid runtime instead of using `--force`. Seroval is overridden to **1.6.9**. Zod, TypeScript and tsx are also pinned. Revalidate overrides and audit the complete lockfile after updates; do not force dependency upgrades to silence an audit.

The declared host range is **>=2.0.27 <3**, not an exact release. Server setup does not gate on the host version string. Keep dependency pins separate from host compatibility; run the installed-host checks after upgrades because V2 API compatibility is not guaranteed by the version number. OpenCode 2.0.27 moved from prerelease Effect to stable 4.0.1: old dependencies importing `effect/unstable/http` fail before plugin setup because the host owns the Effect runtime. Upgrade the OpenCode packages together; do not bypass the runtime guard. Smoke runners accept V2 hosts and record the actual version in `result.json`. Server and TUI *plugin* versions must match because they share an RPC and ledger contract; that is not an OpenCode-version check.

Node 22 works for the pure checks; renderer execution uses Bun. OpenTUI's Node-backend engine requirement is Node **26.4+**, so npm can warn on Node 22. Use the provided Bun launcher, not direct Node JSX execution.

No bundler/build is required for installation. Configure the **`src/` directory**; V2 resolves `server.ts` and `tui.tsx`. Native source/config reload releases scoped registrations. Dependency updates require a service restart and TUI reconnect, which interrupts active work.

Work on `master` in the canonical development checkout. Do not create or push feature branches or extra development worktrees unless explicitly requested. Keep the live OpenCode instance pointed at a separate frozen deployment clone; make source and dependency changes only in the development checkout.

The frozen clone receives updates only after development is complete, verified, committed and pushed. Treat pulling it as a deployment step, not part of ordinary development; do not update it or restart/reload the shared service without authorization. Persisted-state compatibility still matters across deployments. Use isolated synthetic-provider hosts for testing and keep imported development source unchanged during final suites: those private hosts still watch their plugin files.

Never include machine-specific local paths or workstation configuration in tracked files. Use generic placeholders in public documentation and examples; keep exact local setup details in ignored notes.

### Installed-host verification

`script/host-smoke.ts` uses the actual production entrypoints and RPC/controller workflows. `script/host-fixture.ts` starts a private foreground server and a loopback fake provider on ephemeral ports. It uses fresh HOME/config/data/cache/state directories and an explicit environment—not real credentials, MCP servers, or the shared service.

The runner prints its temporary root under the OS temporary directory's `opencode/` folder. Inspect `result.json`, `host.log`, `stdout.log`, and `requests.json`. Both the scenario result and `cleaned` must succeed. Only owned processes are stopped. A supplied destination must not already exist. On Windows pass the actual `opencode.exe`, not an npm `.cmd` wrapper.

The optional PTY driver connects explicitly to that private server. It exercises actual slash-command loading, range editing, native dialog focus, readers, summarization, model-edit proposals/application, expansion, and resize. Xterm decodes cursor updates into the screen buffer; concatenated ANSI output is not a reliable screen representation. The terminal log and last screen are saved on exit, including failures.

To verify a real upgrade, unpack an archived 3.2.0 or 4.0.0 source snapshot under ignored `.local/`, install its dependencies, and run:

```sh
npm run test:upgrade -- /absolute/path/to/opencode /absolute/path/to/baseline/src
```

This optional test creates genuine format-7/8 or format-9 operations under the old plugin, restarts only its private host with the new source, and verifies the next same-model requests, summary expansion, restoration of old pruning, format-13 writes and another restart. It needs no new development branch/worktree. Default checks need no old source snapshot. Tests exercise production projection code, not a duplicate converter.

The upgrade runner uses one host executable for both plugins. Unmodified archives with 2.0.26 dependencies cannot load on 2.0.27, and this release no longer targets the older host. It therefore does not cover that host/runtime transition; use the frozen persistence regressions and current-host smoke tests without claiming a real cross-host archive upgrade.

All default tests use synthetic content. Fake-provider success proves protocol/flow, not semantic summary quality or arbitrary signed-reasoning/provider compatibility. Live tests require explicit permission for provider/model and request bounds; no live-provider runner is enabled by default.

### Version 4.0.0 validation

- Typecheck and **197 unit/adapter tests** on Node **22.23.3** and **24.21.0**.
- **29 OpenTUI renderer tests** on bundled Bun **1.4.2**, including native modal ownership, dark/light semantic colors and short terminals.
- Replay stress test: **200 deterministic ledgers × 16 operations**, with immutable source, JSON round trips and exact nested expansion.
- OpenCode **2.0.24, 2.0.25 and 2.0.26**: production server/Windows ConPTY inspector (**27 checks**), provider usage (**10 checks**) and subagents (**11 checks**) on each release.
- Real plugin **3.2.0 → 4.0.0** upgrade using saved format-7/8 ledgers and private server restarts (**4 checks**).
- Fresh public-tree copy without `.local/`: `npm ci --ignore-scripts`, full checks and installed-host/TUI smoke.
- Lockfile audit: **0 known vulnerabilities**; `git diff --check` clean.

This matrix is Windows validation with fake providers. It does not claim Linux/macOS PTY validation, live-provider summary quality or universal signed-reasoning/stateful-transport compatibility. The live OpenCode service and host source were not changed.

### Version 4.1.0 validation

- Typecheck and **220 unit/adapter tests** on Node 22/24; **36 renderer tests** on bundled Bun.
- Production server/Windows ConPTY smoke: **33 checks** on OpenCode **2.0.24, 2.0.25 and 2.0.26**, including each pruning mode followed by restoration and an immediate same-model request.
- Provider-usage smoke: **11 checks** on 2.0.26, including restoring a held request above its threshold, refusing Resume, then pruning again and continuing the same request. Subagent smoke: **11 checks**.
- Real upgrades from archived **3.2.0** (formats 7/8; 4 checks) and **4.0.0** (format 9; 3 checks), restoring old pruning and verifying the restored wire context after another private restart.
- Frozen source/request hashes, 200 mixed-operation replay sequences, upstream-redaction preservation, error/file restoration, checkpoint-tail scoping, stale/foreign/overlapping targets and hidden-provenance exclusion are covered.
- A fresh public-file installation passed the full checks without ignored research artifacts. Current dependency audit: **0 known vulnerabilities**; version/lockfile consistency and whitespace checks passed.

These checks use synthetic providers and owned private servers. No shared-service restart or host-source modification is needed. Archive dependencies intentionally reproduce the older release; audit the current package separately rather than force-upgrading compatibility fixtures.

### Version 4.1.1 validation

- Typecheck, **224 unit/adapter tests** and **36 renderer tests** passed.
- Extended provider-usage suite: **14 checks** on each of OpenCode **2.0.24, 2.0.25 and 2.0.26**. Manual batches exceed advertised helper capacity without a plugin veto; manual follow-ups ignore oversized usage forecasts; actual provider input rejection preserves history. Automatic helper follow-ups still fail before dispatch when their guard exceeds capacity.
- Production server/Windows ConPTY smoke: **33 checks** on 2.0.26; subagents/automatic recovery: **11 checks**. All private hosts stopped cleanly. Synthetic providers only; no live-provider capacity guarantee.
- Version/lockfile agreement and whitespace checks passed. No dependency, RPC-schema or ledger-format change.

### Version 4.1.2 validation

- Typecheck, **230 unit/adapter tests** and **36 renderer tests** passed.
- Provider-budget suite: **17 checks** on each of OpenCode **2.0.24, 2.0.25 and 2.0.26**, including large decoded tool images reaching the next request intact, no false compaction under fallback/matched accounting, and format-1 cache migration across restart.
- Production server/Windows ConPTY: **33 checks** on 2.0.26; subagents/automatic recovery: **11 checks**. Successful private fixtures all stopped cleanly.
- Synthetic tests cover image/PDF allowances, text/JSON/error distinctions, identity hashes, conservative removal credit, cache exclusions and fresh matching. No exact vision-token or live-provider capacity guarantee. Dependencies and operation fingerprints are unchanged; only the accounting cache advances to format 2.

### Version 4.1.3 validation

- Reproduced the 2.0.27 startup failure with the old 2.0.26 packages, both through the production smoke suites and a minimal public-package import. Updating the OpenCode packages together replaces Effect 4.0.0-rc.112 with 4.0.1 and removes the obsolete `effect/unstable/http` import.
- Typecheck, **230 unit/adapter tests** on Node **22.22.1**, and **36 renderer tests** on bundled Bun **1.4.2** passed.
- OpenCode **2.0.27, Linux x64**: production server/actual 80×24 PTY inspector **33 checks**, provider-budget suite **17 checks**, subagent/automatic recovery **11 checks**. All private hosts stopped cleanly; synthetic providers only.
- A fresh public-tree copy passed `npm ci --ignore-scripts`, the full local checks and production server/PTY inspector smoke without ignored artifacts or forced dependency resolution.
- Frozen source/request fingerprints, ledger-format compatibility and accounting-cache migration remain covered. Ledger **10**, accounting cache **2**, export schema **4**, tokenizer and UI runtime pins are unchanged. No cross-host archive upgrade or current Windows/macOS validation is claimed.
- Dependency audit: **0 known vulnerabilities**. Only OpenCode/Effect package versions changed; unrelated dependency versions were retained, and packages no longer required by Effect were removed. No forced peer resolution, private host import, runtime alias or host patch.

### Version 4.2.0 validation

- Typecheck, **242 unit/adapter tests** on Node **24.21.0**, and **38 renderer tests** on bundled Bun **1.4.2** passed, including Delete and Ctrl+E cancellation/confirmation at 80 and 60 columns.
- OpenCode **2.0.27, Windows x64**: production server/actual ConPTY inspector **35 checks**, provider-budget suite **18 checks**, subagent/automatic recovery **11 checks**. All successful private hosts stopped cleanly; synthetic providers only.
- Deletion/expansion checks cover immediate same-model requests, complete tool pairs, saved summaries and pruning, nested/mixed layers, zero-content totals, helpers/exports, current-hook redactions, deleted-range restart persistence, protected turns and restoring a held request above its budget. The 200 deterministic mixed-ledger sequences now include deletion.
- Ledger **11** reads V2 formats **7–10** without rewriting old records on read; frozen source/request fingerprints remain unchanged. Explicit format-10 pruning-restoration compatibility and rejection of deletion in older envelopes are covered. Export schema is **5**, accounting cache remains **2**. Package/source/lockfile versions agree and dependency entries are unchanged.
- PTY startup waits for the plugin's actual slash-command autocomplete entry rather than assuming the session title means plugin setup completed. Failure screenshots are captured before exit resets the alternate screen.
- No current Linux/macOS validation, fresh-install run, new dependency audit or real archived-plugin upgrade was performed for this change. No shared-service restart, host-source patch or live-provider call.

### Version 4.3.0 validation

- Typecheck and **263 unit/adapter tests** on Node **24.21.0**, plus **42 renderer tests** on bundled Bun **1.4.2**, passed in the canonical checkout and a fresh public-file installation. The clean installation used `npm ci --ignore-scripts`, with no ignored research inputs or forced dependency resolution. Dependency audit: **0 known vulnerabilities**; dependency versions are unchanged.
- OpenCode **2.0.27, Windows x64**: production server/ConPTY inspector **35 checks**, provider-usage accounting **19 checks**, and subagents/automatic recovery **11 checks**. All owned fixtures stopped cleanly.
- Dedicated `script/fork-smoke.ts --tui`: **7 check groups / 14 recorded observations**, covering full/partial/empty forks, nested/revised summaries, independent pruning/deletion restoration, automatic/checkpoint reductions, real `/fork` and Ctrl+E, restart, and parent removal. Synthetic providers only; no shared-service restart or host patch.
- Large fixture: **2,000,137 raw local tokens → 500,254 effective tokens**. The fork retained that effective context and continued, then independently expanded to 2M. A full-context helper was rejected by the synthetic provider; isolated helpers fit and reduced the fork to **500,300** tokens. The original session remained unchanged, and both continued after restart. Counts are local estimates, not real-provider billing/capacity or summary-quality guarantees.
- Boundary regressions cover crossing summaries/deleted ranges, all-output and whole-call pruning across a partial cutoff, per-turn restoration, checkpoint tails, metadata/payload drift and coalesced initialization. Isolation checks cover both summary modes, both options at 80/60 columns, retries/refinements, disjoint-range scope and sibling-result exclusion. Copied provider reports are excluded until the fork matches its own usage.
- Ledger **12**, export schema **6**, accounting cache **2**. Ordinary-session formats **7–11** retain their existing operations/fingerprints; no old-fork repair/migration command is included. No current Linux/macOS or real archived-plugin upgrade run.

### Version 4.4.0 validation

- Typecheck, **284 unit/adapter tests** on Node **24.21.0**, and **44 renderer tests** on bundled Bun **1.4.2** passed. Renderer coverage includes staged-prefix display and redo at 80/60 columns.
- OpenCode **2.0.27 / Windows x64**: **30** dedicated revert/ConPTY scenarios, **35** production host/ConPTY checks, **19** provider-usage checks and **11** subagent/automatic-recovery checks passed. Every owned fixture's successful result and cleanup were verified after the final frozen-source run.
- The real terminal case creates summary 1–10, reverts to turn 8, checks seven retained turns and the restored editor prompt, submits edited turn 8 successfully and opens the inspector afterward. API cases cover before/inside/after cutoffs, detailed/brief/nested/revised/restored summaries, all pruning modes, deletion, fork boundaries, redo, one-layer restoration and staged/committed restart. Next-provider-request checks exclude removed raw history and preserve retained effective text.
- Positive edge scenarios cover native Git-backed file rollback/redo and `files:false`, changing the staged boundary, explicit commit plus cold-start reconciliation without its event, format-12 provenance backfill, stale helpers, busy-session refusal, last-resort checkpoints and local-fallback → provider-matched usage after revert.
- Fork/isolation regression suite: **7 check groups / 14 observations**, including real ConPTY `/fork`, source-parent integrity, restart/removal, and the **2,000,137 raw → 500,254 effective** case. Independent expansion and isolated recompression to **500,300** passed again. Synthetic-provider/local-token evidence only, not summary quality or real-provider billing/capacity.
- Revert regressions cover all retained message cutoffs through nested/revised summaries, deletion, pruning and last-resort splits; one-layer restoration; immutable redo state; retained native checkpoints; changed payloads/interior holes/older replacement history; coalesced writes; a staged-read/commit race; metadata/location/history changes and unload before commit.
- Earlier timestamp-less format-13 records decode safely and backfill only from verified intact history. Invalid supplied timestamps and missing-history migration remain refused. Frozen older operation/request fingerprints were not regenerated.
- Ledger **13**, export **7**, accounting cache **2**; dependencies and global options unchanged. No dependency reinstall, fresh-install/audit, archived-host upgrade, current Linux/macOS run or live-provider call for this change. Native signed/opaque checkpoint compatibility is not universal; the retained native-checkpoint shape is covered by unit fixtures, while installed-host checkpoint coverage uses plugin-created last-resort summaries.

### Version 4.4.1 validation

- The unchanged 4.4.0 plugin with 2.0.27 dependencies passed **35 production server/ConPTY checks** on OpenCode **2.0.28** before this update. No immediate loading failure was found.
- Public OpenCode dependencies were updated together to **2.0.28**, still using Effect **4.0.1**. Other dependency versions, host minimum **>=2.0.27 <3**, global options, ledger **13**, export **7** and accounting cache **2** are unchanged. Frozen persisted-operation/request fingerprints were not regenerated.
- Typecheck, **287 unit/adapter tests** on Node **24.21.0**, and **44 renderer tests** on bundled Bun **1.4.2** passed in both the development checkout and a fresh public-file installation. Fresh `npm ci --ignore-scripts` and audit passed with **0 known vulnerabilities**, without ignored research inputs or forced dependency resolution.
- OpenCode **2.0.28 / Windows x64**: **35** production server/ConPTY checks, **21** provider-usage checks, **30** native-Revert/ConPTY scenarios and **11** subagent/automatic-recovery checks passed. Each private fixture's successful result and cleanup were verified.
- Fork/isolation: **7 check groups / 14 observations**, including actual ConPTY fork/restoration, partial/empty/nested forks, parent independence, restart and the **2,000,137 raw → 500,254 effective** round trip. Independent expansion and isolated recompression to **500,300** passed.
- Two new adapter regressions first reproduced unchanged budget scopes after provider/model `compatibility` changes. The fix includes those fields in the scope; old reports are excluded, new reports match, and held requests become invalid. Installed-host cases also verify the changed reasoning field on the actual next provider request, no stale dispatch, and fresh usage matching.
- The fresh installation also passed **35 production server/ConPTY checks on each of 2.0.27 and 2.0.28**, retaining the supported minimum without an exact-version gate.
- Synthetic HTTP providers only. No shared-service restart, frozen-deployment update, current Linux/macOS validation, real archived/cross-host upgrade, or live-provider calls. New transports/compression and arbitrary signed/opaque checkpoints are not exhaustively validated.

### Version 4.4.2 validation

- Typecheck, **293 unit/adapter tests** on Node **24.21.0**, and **46 renderer tests** on bundled Bun **1.4.2** passed. Regressions cover single/multiple offending turns, disjoint operations, duplicate failures, unchanged source numbering after summary/deletion/split boundaries, atomic RPC rejection and tools-only success.
- The range list marks failed/interrupted reasoning before selection. Native inspection supplies blocked message IDs separately from normalized history, using the same predicate as the safety guard. No added transcript fields, persisted fingerprints, ledger/export/cache formats, global options or dependencies. Markers remain after tools-only pruning, disappear under deletion and return on restoration; renderer coverage includes 80 and 60 columns.
- OpenCode **2.0.29 / Windows x64**: a private synthetic-provider/ConPTY scenario interrupted a reasoning-bearing tool call, verified the warning and numbered rejection, and confirmed unchanged metadata/history and no model call from the rejected action. Owned terminal/server cleanup passed.
- The broader 2.0.29 production smoke did **not** pass completely: a length-limited helper continued to a `stop` reply and was accepted. The initial attribution to an outdated test expectation was incorrect: validating only the final assistant message can silently discard earlier summary chunks. Version 4.4.3 fixes this adapter defect; these historical results do not establish full 2.0.29 compatibility.
- No shared-service restart, frozen deployment update, live-provider calls, fresh dependency install/audit, archived upgrade or current Linux/macOS validation.

### Version 4.4.3 validation

- Helper extraction validates every assistant response after the exact admitted user prompt. Any output-limit finish, error, unfinished response or intervening user input rejects extraction; previous prompts' replies are excluded. No continuation assembly, output-cap increase, schema migration or source-history rewrite.
- Adapter regressions cover one/multiple truncated chunks followed by successful completion, both summary/edit helpers, subsequent complete revisions, earlier errors/unfinished output and cancellation. Production batch coverage checks atomic rejection, unchanged parent history/metadata, retrying only the failed sibling, and complete replacement beginnings/endings on the immediate next same-model request.
- Typecheck, **300 unit/adapter tests** on Node **24.21.0**, and **46 renderer tests** on bundled Bun **1.4.2** passed. Six new regressions failed against the old adapter before the fix; the cancellation regression already passed.
- Packaged **OpenCode 2.0.32 / Windows x64** passed **35 production server/ConPTY checks**, including an actual `length → stop` continuation rejected through public RPC, atomic batch refusal, successful retry and immediate same-model wire verification. Owned fixture cleanup passed. No shared-service restart or frozen-deployment update.
- Dependencies remain pinned to 2.0.28; ledger/export/cache remain **13/7/2**. No fresh install/audit, separate usage/subagent/revert/fork suite rerun, current Linux/macOS test or live-provider calls for this fix. This is not universal host/provider compatibility or automatic repair of previously saved incomplete summaries.

### Version 4.4.4 validation

- Reasoning pruning retains failed/interrupted attempts rather than refusing the selected action; successful reasoning in the same turn remains removable. The UI uses the ordinary pruning status without blocked/partial markers. Existing native-checkpoint, unsettled-tool, source-identity and opaque-state guards remain.
- Native normalization supplies an optional assistant `retainReasoning` replay fact; original native payloads remain hashed, and the existing `historyHash` representation is unchanged. Retained reasoning stays in effective counts/helper input/exports. Canonical projection preserves current-hook text without reconstructing or matching prose. One-layer restoration preserves earlier hook redactions.
- Two retry regressions failed before the change. Typecheck, **302 unit/adapter tests** and **46 renderer tests** passed on Node 24.21.0 / bundled Bun 1.4.2. Coverage includes failed/interrupted attempts followed by successful reasoning in the same turn, disjoint selections, collapsed/split ranges, combined tool pruning, RPC commits, source fingerprints, restoration, and ordinary status at 80/60 columns.
- Packaged **OpenCode 2.0.32 / Windows x64** passed **36 production server/ConPTY checks**, with owned cleanup verified. A native interrupted tool attempt followed by a successful reasoning-bearing turn retains only failed reasoning on the immediate same-model request; restoration brings safe reasoning back without changing native history. Same-turn retry cases use native/canonical adapter fixtures, not a live WebSocket failure. No fresh install/audit, separate usage/subagent/revert/fork suite rerun, Linux/macOS or live-provider test.
- Dependencies and ledger/export/cache formats remain **13/7/2**. No legacy reductions are reset; previously valid reasoning-prune operations could not include these failed/interrupted attempts. This does not establish universal WebSocket retry or signed-provider compatibility.

### Version 4.4.5 validation

- Ctrl+E prepares and immediately applies the same checked one-layer restoration, without rendering a preview or requiring Ctrl+S. Summary, pruning and deletion restoration share this path; summary-editor Ctrl+S remains unchanged. No ledger/export/cache, dependency or controller-validation changes.
- Seven updated renderer expectations failed against the old preview workflow. Typecheck, **302 unit/adapter tests** and **48 renderer tests** passed. Tests cover immediate summary expansion, all pruning modes, deletion at 80/60 columns, mixed disjoint ranges in one write, repeat keys while busy, native-dialog ownership and an idle-state change between preparation and application.
- Packaged **OpenCode 2.0.32 / Windows x64** passed **36 production server/ConPTY checks** and the small fork/ConPTY suite (**6 groups / 12 observations**), with owned cleanup verified. Actual terminal actions restore summaries, pruning and deleted ranges without Ctrl+S; summary-editor confirmation remains tested separately. No large-context fork, separate usage/subagent/revert rerun, fresh install/audit, Linux/macOS or live-provider validation for this UI change.

## Architecture

| Area | Files |
| --- | --- |
| V2 lifecycle, hooks, agents, RPC registration | `src/server.ts` |
| Public in-process session/model/helper adapter | `src/host.ts` |
| Verified fork identity mapping and reversible-state inheritance | `src/fork.ts`, `src/retention.ts` |
| Native revert source manifests and retained-prefix reconciliation | `src/revert.ts` |
| Shared RPC schemas / remote inspector adapter | `src/rpc.ts`, `src/control.ts` |
| Small domain views / native normalization | `src/model.ts`, `src/normalize.ts` |
| Ledger schema, V2 persistence decoding and append-only writes | `src/ledger.ts` |
| Ledger replay, turn grouping, summaries, expansion | `src/context.ts` |
| Canonical request patching / native validation | `src/projection.ts`, `src/tool-result.ts` |
| Public idle observation / protected execution spans | `src/activity.ts`, `src/history.ts` |
| Provider-anchored guard and request observations | `src/budget.ts` |
| Controller, parallel batch and saved-summary editor | `src/controller.ts`, `src/batch.ts`, `src/summary-editor.ts` |
| Budget gate and strategy/ownership state | `src/autocompaction.ts`, `src/auto-state.ts` |
| Exempt-tail selection and bounded emergency summaries | `src/last-resort.ts` |
| Token rules, metrics and display status | `src/text.ts`, `src/tokens.ts`, `src/metrics.ts`, `src/status.ts` |
| Server-local files and effective export | `src/storage.ts`, `src/snapshot.ts` |
| Inspector, public TUI capability type and input guard | `src/tui.tsx`, `src/ui.ts`, list/menu/reader/help TSX modules |
| Compact overview, display-only budget and breakdown helpers | `src/context-overview.tsx`, `src/inspector-view.ts` |

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

The ledger remains in session metadata under `opencode_context_manager`; strategy/status uses a separate namespace. Current writes use **format 13**, with no runtime cursor. Normal maintenance is append-only; verified native-revert reconciliation rebuilds the retained reversible layers instead. The decoder accepts ordinary-session V2 formats 7–12 and returns the same operations in a format-13 view without writing. The server separately backfills source provenance from intact validated history on access, preserving old operations/fingerprints. It rejects truncated cursors, invalid revisions, foreign owners and formats 1–6. Package version, ledger format, budget-cache format and export schema are independent. Current export schema is **7**; accounting cache stays **2**. Do not downgrade after format-13 writes.

`historyHash` preserves the established V2 fingerprint representation, including the fixed tool discriminator `nativeVersion: 2` **inside the hash only**. It is not a runtime version switch. Frozen 3.2.0 source/request hashes in `test/ledger.test.ts` protect nested summaries, revision, expansion and partial-turn checkpoint compatibility. Never change that representation casually or regenerate expected hashes to hide a regression. Budget bootstrap replays an explicit operation prefix; this is not Undo.

The `checkpoint: true` compact operation splits a USER block after its final source message before replay, so later continuations cannot move that boundary. Ordinary fresh children (parentID, no fork) receive an empty own ledger only after validating any copied ledger belongs to an ancestor; unrelated metadata is retained and inherited live-pause notices removed. Own ledgers and unrelated/corrupt copies are never silently reset. Initialization is coalesced and pending writes drain on unload.

Native forks have `fork.sessionID` but no `parentID`; the host copies stored messages with new IDs and current metadata, not this plugin's request projection. `host.ts` initializes them on public fork events or before their first access. It verifies the copied snapshot's ancestor ownership, matches native payloads in order at the native cutoff, then `fork.ts` reconstructs retained effective transformation layers with new source IDs/fingerprints. The source ledger/history are never written. Complete summaries/deletions stay applied; crossing ones open recursively to retained content, with earlier pruning/nested layers preserved. Active per-turn pruning layers are rebuilt independently; already-undone audit operations need not be copied. Saved summary revisions supply their current text without adding expansion layers.

Format 12 adds immutable optional `turnEnds`: copied leaf-turn boundaries are applied before replay so inherited checkpoint prefixes/tails remain separately restorable. Maintenance cannot add/change/remove these boundaries. Initialization validates the final policy and rechecks destination ownership/location before merging metadata; it drops inherited pause notices, keeps strategy and unrelated metadata, and drains on unload. Nested uninitialized forks use the copied policy snapshot without initializing/writing ancestors. Parent history must remain available and match during initialization; missing/changed source or unavailable native boundaries fail closed. Once initialized, the fork survives parent removal. No old-fork repair/migration command is provided.

Format 13 adds an optional `sources` manifest through the last referenced native message: ordered ID, full normalized per-message hash, user-turn bit and creation time. It contains no message bodies. Older in-development format-13 manifests omitted `created`: keep that field optional on decode, reject invalid supplied values, and backfill only after every original source ID/hash/user bit matches intact history. Missing timestamps never become zero or guessed values. If already-truncated history lacks the required provenance, fail without rewriting it. Live source checkouts can write persistent data before release; unreleased records still require compatibility.

While native undo is staged, `Controller.load` computes a deterministic retained-prefix policy without replacing the saved redo state. `retention.ts` preserves wholly retained summaries/deletions and pruning layers, recursively opens crossing reductions, and retains checkpoint turn boundaries. Context maintenance and generation remain blocked while staged. Native `/redo` restores the original view; host clearing can append an idle record, so old helper proposals may correctly become stale.

On first access after commit, `revert.ts` accepts only an exact retained prefix of the recorded sources followed by new records no older than the recorded history. Changed retained payloads, interior holes, incomplete provenance, older replacement history and unfamiliar native-checkpoint windows fail closed. A matching retained native checkpoint remains read-only. Absent suffix records are represented by empty structural placeholders only while reconstructing the old transformation tree; they never become provider messages, exports, helpers or token totals. The optional unavailable-ID set in `project` is confined to this verified reconstruction; ordinary replay and canonical request checks remain strict.

The adapter coalesces and rechecks reconciliation before its metadata write, merges current unrelated namespaces, and removes stale pause notices on history-epoch changes. A staged read racing commit is re-read once rather than returned to a new request as obsolete undo state. Further drift, movement, unload or conflicting policy writes fail closed. Public view events can prepare legacy manifests, but correctness for recorded manifests does not depend on receiving revert events; there is no synchronous pre-revert hook or plugin-domain durable-log reader at the pinned baseline. This is verified suffix-truncation reconciliation, not arbitrary history repair or a transaction against external metadata writers.

Rebuilding records a deterministic `epoch` and rebases only retained operations/boundaries. Normal maintenance cannot change epoch/source provenance. Budget scope includes that epoch: discard incompatible anchors and exclude retained historical reports until the new request gets its own usage. Main guards, output caps, protected turns and helper cancellation remain in force. The host owns prompt restoration, commit and file rollback; submitting a prompt commits native undo before model hooks. File changes can therefore stay reverted if a later provider/budget failure occurs, and `/redo` cannot restore a committed cutoff.

Expansion provenance is replay-only. It must not enter provider metadata, helper input, or effective exports. New revisions target stable summary IDs without creating another expansion layer. RPC commits use the same strict ledger schema as persistence.

Pruning keeps a per-turn stack of effective layers during replay, using immutable message/part replacements. Format-10 `expand` operations explicitly name summary IDs and/or `pruneTargets` (operation ID plus exact visible turn source IDs). A summary expands first without restoring its hidden pruning; an ordinary turn restores only its latest effective prune. Combined modes restore together. Restoration of part of a wider prune must leave the other turns unchanged. Split checkpoint tails filter pre-pruning messages to their own source IDs and must never resurrect the hidden prefix. Old saved `expand` operations with only summary IDs keep their old semantics.

Canonical restoration uses snapshots from the current incoming hook messages, not stored unredacted content. Restore dropped wrappers, attachments, error content, reasoning and pruning-rule state together. Reconstruct layers on each replay, so no bulky original content is added to the ledger. Exclude both `previous` and `pruning` provenance from exports and helpers. Model/source drift, busy/protected turns and stale previews still fail closed. Restoring while paused can increase the guard; it never grants permission to resume above the threshold.

Format 11 adds standalone `delete` operations and explicit `expand.deletedIDs`. Replay collapses each selected range into one `kind: "deleted"` block with its source IDs, `deletionID`, empty `messages` and replay-only `previous` blocks. It contributes no model messages or marker and no local content tokens. Canonical replay saves/removes owned entries, including whole tool pairs; expansion restores current-hook entries and exact prior effective blocks, not raw history or hidden inner layers. Mixed summary/pruning/deletion expansion applies in one checked write. Already-deleted-only ranges cannot create another deletion. Deletions are indivisible like summaries, may be nested inside a wider deletion/summary, and remain absent from helper input. Format-7–10 envelopes cannot contain deletion operations/targets. Existing fingerprints remain unchanged.

Native `session.context` exposes the active window, not arbitrary pre-checkpoint history. Host checkpoints are read-only. Later turns can be edited without discarding a checkpoint or restoring history behind it. The plugin does not reconstruct the host's history selection or private model converter.

## Invariants

### Editing and request projection

- A USER row starts at a user message; following synthetic/skill/shell context belongs to that effective range. Host control/system/idle records are not editable USER text. Unfinished/user-only snapshots must be labeled honestly.
- Background shell records (`metadata.background === true`) remain in saved source fingerprints but OpenCode deliberately omits their canonical messages; completion arrives separately as synthetic context. Projection must allow that specific omission without reconstructing the shell or suppressing missing-message/tool-pair checks. Production smoke covers all pruning combinations across a real background shell completion.
- Ranges are inclusive and disjoint; adjacent ranges remain separate. Existing summaries and DELETED ranges are indivisible until expanded.
- Never rewrite transcript messages/parts. Operations alter the request projection only; spills are ingestion-time previews with full captured text saved separately. Range deletion removes the entire selected effective content but retains an empty inspector row and replay-only restoration state. Preserve unselected/system context; do not insert a synthetic deletion message.
- Reasoning removal removes whole reasoning parts, including opaque part metadata, but does not guess that commentary/visible text is reasoning.
- Large tool pruning changes model-visible result text only, preserves inputs and attachments, keeps Unicode boundaries, pins tokenizer/rule identity, and skips non-saving or duplicate rule applications.
- All-output pruning replaces every terminal result, including empty/error results and attachments. It must not leave original interruption output in the error/content fields.
- Whole-tool deletion removes both calls and results, including hosted pairs, and requires reasoning removal. Empty wrappers disappear without invented assistant prose.
- Leave unselected messages, typed tool output, and provider call state alone. Never put plugin provenance in `providerMetadata`.
- Operate on the **current canonical result**, not an earlier unredacted stored result. Reject unknown shapes/ownership rather than guessing.
- Native checkpoints, unsettled historical tool calls and opaque provider-result pruning have explicit pre-write guards. Failed/interrupted reasoning is retained during reasoning pruning, never guessed out of ordinary canonical text; safe reasoning in the same range is still removed. Summary/whole-call deletion is available where it can safely replace the whole selected material.
- Pending work must be invalidated by source/revision changes, native revert, location changes, or cancellation. Metadata writes are not host-wide CAS; concurrent arbitrary external writers remain unsupported.

### Summaries and edits

- Freeze effective history, runtime background, source fingerprint, policy revision, and consuming tokenizer once per batch.
- With isolation off, each initial helper sees the **same full pre-batch effective context** with only its own selected range marked. `head` includes only preceding effective blocks plus selection; `total` includes only selection. Both omit captured runtime background. Scope is frozen per batch across retries/refinements, but each disjoint range uses its own boundaries against the same snapshot. Never include sibling results or hidden restoration content in another initial request. Isolation is a summary-only inspector choice, not a pruning combination or automatic-policy override.
- The selected range is the only source to summarize; before/after/runtime regions are background. Preserve unfinished state and describe binary attachments without inventing their contents.
- Detailed mode uses a soft 2×–20× review band on the complete wrapped replacement; exact boundaries need no retry. At most one follow-up; accept the second completed nonempty response regardless of size. Brief mode is single-pass.
- Empty, truncated, failed, or cancelled responses are invalid. Validate the entire response sequence for the admitted helper prompt, not just its last assistant message: `length` followed by `stop` is still rejected. Previous review/edit prompts are separate generations. Manual summaries need not save tokens; automatic near-limit candidates must.
- Apply the complete successful batch in one checked write. Failed siblings block partial application; retry only unresolved jobs against the frozen source. Cancellation prevents late application, except a write already in flight is not promised to roll back.
- Saved-summary editing starts a new deny-all helper containing only the applied summary and edit request. Further edits continue that dialogue; proposals require explicit apply. No original-range/background leakage and no size-review retry.
- Helpers are tracked by server generation and parent session, with client-side cleanup tracking. Close/discard/apply/abort/reload removes owned helpers. Crash recovery of abandoned helpers is not implemented.
- Helper budget policy follows the originating action, not the parent's strategy. Controllers default to manual; automatic controllers and last-resort jobs explicitly use `auto`. Inspector RPC creates manual jobs. The host adapter records the trigger only in its live owned-job map; metadata cannot grant a bypass. Manual summaries, retries/refinements and summary edits skip local input preflight and helper budget accounting, but still isolate system/tools, preserve host output caps and validate source/ownership/cancellation/completion. Automatic helpers and main-request pause/resume retain their guards. Do not weaken the global multiplier or silently omit background to make a manual request fit.

### Autocompaction and cancellation

- Require explicit `compaction.auto: false`; native auto/overflow compaction runs before the context hook. Reject native compaction while the plugin owns this workflow.
- Check every main request, including tool-driven continuations. Use positive `limit.input`, else `context - output`, minus configured headroom. Equality fits. Invalid budgets fail visibly. Never change host/provider output caps.
- The guard uses normalized per-response input+cached read/write and visible output+reasoning exactly once, never session-wide accumulated spend. Pair the report with its captured outgoing request using an unchanged native prefix and exact model/agent/configuration/tokenizer scope; helpers are independently scoped. Ignore failed/missing/malformed measurements.
- Save hashed count units and a policy hash, not prompts/credentials. Pair only the immediately following assistant: interrupted attempts/new input cannot be mistaken for the sampled request. Drain pending accounting writes on unload. Never use transient generation to overwrite primary observations.
- Recount edits against the same frozen anchor. Charge added units separately from removed units, with growth multiplier at least `max(estimateMultiplier, reportedInput / sampledLocalInput)`; removal credit is unscaled local count. Do not use a permanently unchanged old reported floor, scale removal credit as exact savings, or recalibrate the baseline from each candidate.
- Bootstrap without a captured request is explicitly unpaired. Reconstruct a historical policy prefix excluding operations created after the response began or selecting that response/future messages. This is not proof of historical request identity; timestamps/configuration can be uncertain. New matched observations supersede it.
- Forks exclude all copied assistant reports when creating their first accounting cache. The inherited effective ledger may have rebuilt/coalesced operation history, so copied reports cannot safely establish its historical projection. Use the normal local fallback until the fork's own captured request receives usage; subsequent accounting/restart works normally. Never copy the parent's cache or treat rewritten operation ordering as historical wire evidence.
- Native revert reconstruction changes the ledger epoch and therefore budget scope. Retained old reports are not proof of the rebuilt request. A larger expanded prefix must pass the ordinary local/provider-aware guard before dispatch; revert and redo grant no budget bypass.
- Native checkpoint/raw-prefix changes and model/provider/variant/agent/tokenizer/route changes invalidate incompatible anchors. Include both provider and model `compatibility` in the request scope: they can change protocol lowering even when IDs, settings, headers and limits stay the same. Do not immediately bootstrap from the very historical reports just invalidated by a scope change. Live gate validation checks current route/model configuration and capacity before maintenance/resume.
- Missing usage falls back to a visible configurable local uplift (default 1.3). Unknown overhead remains uncertain; no universal media/opaque-state/provider bound is claimed. Keep local content totals, historical reported usage and the actual guard forecast clearly separate in the UI/export.
- Typed `tool-result.content` is not raw JSON text: count its text parts and image/PDF allowances separately, never base64 file bytes or long file URLs as prose. Preserve full payload identity in unit hashes and leave requests unchanged. Plain text/JSON/error results keep serialized-text counting because those paths can genuinely send the bytes as text. Direct media and tool files share allowances; they remain rough estimates, not provider/image-resolution guarantees. Test media-bearing continuations with both fallback and reported usage.
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

Components use public V2 theme tokens, router destinations, data events and keymap modes directly. Input guards use `base`, our `context-manager` mode, and native modal ownership. There is no synthetic `theme.current`, route wrapper or private `dialog.open` cast. Use semantic action/formfield/feedback colors, not raw hues. Native dialogs/model pickers must never trigger actions underneath them.

Keep content-sized rows capped by `maxLinesPerTurn`, measured cursor reveal/paging, fixed headers/footers, and 80×24/short-terminal coverage. Textarea data comes from `.plainText`. Send text and Return separately in real-terminal tests so autocomplete can update.

The default view is an overview, not a diagnostic dump. Keep local/selected totals visible in every main view, sizes aligned separately from turn titles, and full diagnostics reachable with `v`. Below 80 columns, switch full-width panes with Tab without losing ranges or cursor. The overview meter always uses tokens, even when local counts show characters. A paused request uses its frozen threshold; a historical request is labeled as such and compared only with a matching model/variant's current threshold. Missing/invalid limits or a changed model omit the percentage. These are display helpers, never new resume authority or provider accounting.

## Evidence and change workflow

Use official [V2 plugin](https://opencode.ai/v2/docs/build/plugins), [migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1), [RPC](https://opencode.ai/v2/docs/build/plugins/rpc), and [CLI plugin](https://opencode.ai/v2/docs/build/plugins/cli) docs. Confirm exact release declarations and runtime behavior; search indexes and current docs have shown incompatible examples.

Important pinned-source locations: `packages/plugin/src/promise/*`, `packages/plugin/src/tui/*`, `packages/core/src/session/model-request.ts`, `session/runner/to-llm-message.ts`, `session/runner/llm.ts`, `session/compaction.ts`, `plugin/host.ts`, and generated `packages/client/src/promise/generated/*`.

Do not import Core/private host modules. Use `@opencode/plugin`, `@opencode/client` and `@opencode/ai`. Promise APIs have per-method result shapes; not every result has `.data`. RPC output must be JSON without undefined fields. Declare expected RPC errors to avoid hiding them behind `rpc.internal`.

For changes:

1. Add a regression for the exact failing transition. For history edits, inspect the **next same-model main request** before another summary can hide it.
2. Keep pure replay/rules separate from host and UI adaptation. Do not rewrite stable workflows merely to mirror host DTOs.
3. Run all checks and production smoke for hook/projection/persistence/suspension changes. Label renderer-only or fake-provider coverage honestly.
4. Update README/development docs. Keep package/lockfile/version constants coordinated; change policy/export versions only when their formats change.
5. Verify a clean public tree works without `.local/`. Review all staged paths, diffs, identities, and audit results. No forced dependency upgrades.

## Privacy and limits

Server artifacts are under `~/.local/state/opencode-context-manager/<project-hash>/`. Spill files older than seven days are cleaned on startup; captures/exports remain. Files use restrictive creation modes where supported; review local ACLs separately.

Native RPC uses host authentication; the plugin creates no control credential file or custom listener. Do not commit or share old credentials or private captures.

`budget-<session-hash>.json` is an accounting cache of scope/history/content hashes and counts, not prompts or credentials. Current format **2** is independent of host/ledger versions. The reader validates format 1 but returns a format-2 view without its old count units or pending match; scope and report exclusions survive. The next request reconstructs compatible native usage as unpaired using the historical policy prefix, then persists format 2. Never reuse inflated old units as removal credit or preserve their invalid input/local calibration. Unknown/corrupt caches still fail validation. Do not delete accounting state to force a paused request through; a live gate keeps its frozen estimator.

`script/usage-smoke.ts` emits deliberately mismatched OpenAI-style SSE usage. It verifies provider-triggered MANUAL/AUTO pauses with low local counts, cached/reasoning normalization, summary and large-prune resume, tool-result growth, restart persistence, pre-upgrade edits, model/endpoint invalidation (including a held gate), and isolated automatic-helper capacity checks. It also sends manual batches above the selected model's advertised input capacity and manual edit follow-ups after oversized usage reports, then checks a real HTTP provider rejection without partial writes. It uses the same owned private host/fake-provider isolation as the production smoke.

The same suite returns a large valid synthetic PNG through a real tool, verifies the next provider request retains the stored image without spurious AUTO/last-resort work, and restarts with a format-1 oversized image-count cache to verify migration and fresh usage matching. `test/media-fixture.ts` generates a decodable noise PNG; arbitrary bytes labeled image/png would be omitted by the host and would not exercise the bug. Compare wire media to native stored content, not an independently compressed Node copy: Node/Bun encoders may produce different bytes for the same pixels.

`script/subagent-smoke.ts` enables the real built-in subagent tool in an isolated fixture with nesting depth4. It tests foreground/background and nested children of edited MANUAL parents, independent ledgers, last-resort same-turn continuation, exact retained tool output, steering/queue delivery, summary failure, ancestor Stop, no manual gates, and persisted checkpoint restart. Fake providers prove mechanics, not semantic summary quality.

Exports exclude hidden expansion layers, not every possible secret. Original history/spills remain; pruning is not secure erasure and disabling the plugin can restore original context. Keep model/provider errors useful without dumping headers/credentials. Share only synthetic, sanitized reproductions.

Known boundaries: no automatic old-ledger migration, no remote artifact transport, no orphan-helper crash recovery, no external-writer transaction guarantee, no universal signed-reasoning/opaque-checkpoint/WebSocket/provider guarantee, and no exact token/billing or losslessness promise. Keep the package `private: true`; this repository has no license grant or published npm release.
