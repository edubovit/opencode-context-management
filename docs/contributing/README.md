# Contributing

[README.md](../../README.md) covers installation, controls and options. This document describes the current architecture, development workflow and safety requirements. Keep documentation in the present tense: no release diaries, superseded behavior or accumulated validation matrices. User documentation belongs in the root README, operational guides under `docs/`, and developer references under `docs/contributing/`.

## Development workflow

- Work on `master` in the canonical development checkout. Do not create branches or development worktrees unless requested.
- Keep live OpenCode pointed at a separate frozen deployment clone. Develop and change dependencies only in the development checkout.
- Updating the frozen clone is deployment, not publication. Do it only with authorization, after work is complete, verified, committed and pushed. Shared-service restart/reload also requires authorization.
- Use isolated synthetic-provider hosts for integration tests. Never use a real session as a mutable fixture. Keep imported development source unchanged during final host suites: private hosts watch it too.
- Treat any OpenCode research checkout as read-only. Use public APIs, not private Core imports, a host fork or a duplicate provider converter.
- Keep private research/captures/logs under ignored `.local/`. Public tests must work without those files.
- Never put machine-specific paths, workstation configuration, credentials or private session captures in tracked files. Use generic placeholders and sanitize diagnostics.

For each change:

1. Read the affected code and current [server-plugin](https://opencode.ai/v2/docs/build/plugins), [RPC](https://opencode.ai/v2/docs/build/plugins/rpc) or [CLI-plugin](https://opencode.ai/v2/docs/build/plugins/cli) documentation. Verify API shapes against installed declarations and actual runtime behavior.
2. Add a regression for the exact transition. For context edits, inspect the next same-model request before another operation can hide a defect.
3. Keep domain logic separate from host/UI adapters; avoid unrelated refactors.
4. Run the relevant checks below. Distinguish unit, renderer, installed-terminal and real-provider evidence.
5. Update these docs to describe current behavior. Coordinate `package.json`, lockfile root versions and `src/config.ts` when changing the plugin version. Change persisted formats only when their contracts change.
6. Review all intended public files, including new files, for whitespace, path privacy and sensitive content. Commit/push only when requested; do not deploy implicitly.

## Setup

```sh
npm ci --ignore-scripts
npm run check
```

Use Node.js **22+** and retain optional dependencies. On Windows, `npm.cmd` avoids PowerShell shim restrictions. No build step is required: OpenCode loads the `src/` server and TUI entrypoints.

The supported host range is **>=2.1.4 <3**, with OpenTUI **>=0.6.8 <0.7**. Older hosts are not supported or part of the acceptance matrix. Use [package.json](../../package.json) and [package-lock.json](../../package-lock.json) as the exact dependency inventory. Saved-data compatibility is separate: keep existing ledgers, fingerprints and pinned tokenizer rules readable. Server and TUI **plugin** versions must agree on their shared RPC contract.

Upgrade public OpenCode packages together. The host owns shared runtime dependencies; do not bypass runtime compatibility checks or use aliases to force mismatched packages to load. Preserve explicit dependency overrides unless a tested replacement removes their need. Do not use forced peer resolution or unrelated upgrades to silence warnings.

Refresh direct pins and transitive lockfile entries, then audit both the lockfile and a clean install. Keep host-required exact runtime versions rather than forcing every transitive dependency to its newest major. The `gpt-tokenizer-legacy` alias is a persistence codec, not a host-runtime workaround: saved rules require its exact behavior. Do not upgrade or remove it while those records remain supported.

Renderer tests use the bundled platform-specific Bun through `script/test-tui.mjs`, not the Node backend. OpenTUI's Node-backend requirement can produce an install warning on supported Node versions; do not replace the renderer launcher with direct Node JSX execution. Dependency changes require coordinated live-service restart and terminal reconnect when deployed.

## Testing

### Local checks

```sh
npm run typecheck
npm test
npm run test:tui
# All three:
npm run check
git diff --check
npm audit
```

Unit/adapter tests cover normalization, replay, canonical projection, persistence, ownership, cancellation, budget accounting and workflow transitions. Renderer tests drive production OpenTUI components, not UI replicas.

Keep frozen source/request fingerprints and deterministic mixed-operation replay tests. Never regenerate expected hashes merely to make a regression pass. Check input immutability, JSON round trips and the next canonical request, not just the inspector's labels.

Tokenizer upgrades must test Unicode boundary changes, mixed old/new pruning layers, exact canonical replay and restoration. Select codecs and count caches by both encoding and library version. Preserve saved tokenizer IDs; use the current library for new operations and request accounting. A changed tokenizer invalidates the accounting scope and excludes old reports until a fresh request can be paired.

### Installed-host suites

Pass the actual OpenCode executable; on Windows use `opencode.exe`, not an npm `.cmd` wrapper.

```sh
npm run test:host -- /absolute/path/to/opencode --tui
npm run test:usage -- /absolute/path/to/opencode
npm run test:subagents -- /absolute/path/to/opencode
npm run test:revert -- /absolute/path/to/opencode --tui
node --import tsx script/fork-smoke.ts /absolute/path/to/opencode --tui
node --import tsx script/continuation-smoke.ts /absolute/path/to/opencode
node --import tsx script/observation-smoke.ts /absolute/path/to/opencode
```

| Suite | Coverage |
| --- | --- |
| `host-smoke.ts` | Production RPC/hooks, pruning/restoration, deletion, summaries/edits, helper completion, live progress, request guards, cancellation, movement, reload and restart. `--tui` adds the actual inspector. |
| `usage-smoke.ts` | Deliberately mismatched provider/local usage, cached/reasoning normalization, model/route invalidation, held requests, manual/automatic helper limits, media and cache persistence. |
| `subagent-smoke.ts` | Foreground/background/nested children, independent ledgers, automatic recovery, retained tails, queued/steered inputs, Stop and restart. |
| `continuation-smoke.ts` | Two paused background children, pruning after primary idle, repeated automatic continuation, untouched new results, stale restoration refusal and restoration after restart. |
| `observation-smoke.ts` | Read-only child/nested-child discovery, paused AUTO observation, real terminal navigation, disabled mutation controls, automatic refresh through compaction/running/idle, unchanged metadata/history and no observer model requests. |
| `revert-smoke.ts` | Stage/redo/commit, retained-prefix reconstruction, cold restart, file rollback and next-request context. `--tui` checks native prompt restoration and inspector behavior. |
| `fork-smoke.ts` | Full/partial/nested forks, independent restoration, source deletion, isolation and large-context round trips. `--small` omits the large-context case; `--tui` exercises native fork and inspector controls. |

`script/host-fixture.ts` creates an owned foreground server and loopback fake provider with isolated HOME/config/data/cache/state/environment. It does not use real credentials, MCP servers or the shared service. Stop only owned processes.

Inspect the printed fixture directory's `result.json`, `host.log`, `stdout.log` and `requests.json`. Both the scenario result and **`cleaned: true`** must succeed. A provided destination must not already exist. The PTY driver uses prebuilt node-pty and xterm decoding; no Python or WSL is required on Windows. PTY availability depends on the packaged platform binaries.

Wait for actual slash-command registration, not just the session title, before opening the inspector. Capture decoded active-screen content before shutdown resets the alternate screen. Send text and Return separately so autocomplete can update. Preserve the original test error if shutdown also fails.

Renderer coverage must include narrow/short screens, semantic colors, modal ownership, selected totals, footer bounds and cursor/range preservation. Real-terminal checks separately establish plugin discovery, authenticated RPC, input handling and native lifecycle behavior.

### Persistence and installation checks

For a persisted-state transition, use an installed baseline source that exports `rememberPolicy`:

```sh
npm run test:upgrade -- /path/to/baseline-opencode /path/to/current-opencode /path/to/baseline/src
```

Use the same executable twice for a plugin-only upgrade. The runner imports synthetic provider-state history through the public API, saves reductions using the baseline, and restarts the same private fixture with current code. It checks unchanged policy fingerprints, exact pinned-tokenizer output, the next request, independent summary/pruning restoration and another restart. It never upgrades the shared service or edits a live database. Default tests cover older ledger formats with frozen fixtures and do not depend on archives or `.local/`.

For dependency or packaging changes, copy only public files into a clean directory, run `npm ci --ignore-scripts`, full local checks, audit and the relevant installed-host suites. Confirm manifest/lock/source version agreement and review dependency drift.

Synthetic providers prove protocol and workflow behavior, not summary quality, real-provider capacity/billing or universal signed/opaque/stateful-transport compatibility. Record the actual host/platform and commands used when reporting a change. Do not imply unrun suites or platforms passed. Live-provider tests require explicit provider/model and request-limit authorization.

## Architecture

| Area | Files |
| --- | --- |
| Lifecycle, hooks, hidden agents and RPC registration | `src/server.ts` |
| Public session/model/helper adapter | `src/host.ts` |
| Host contract and native/domain normalization | `src/host-contract.ts`, `src/model.ts`, `src/normalize.ts` |
| Stable content and source fingerprints | `src/fingerprint.ts` |
| Shared RPC contract and remote inspector adapter | `src/rpc.ts`, `src/control.ts` |
| Ledger schema and decoding | `src/ledger.ts` |
| Turn grouping, replay, summaries and restoration | `src/context.ts` |
| Canonical request editing and native validation | `src/projection.ts`, `src/tool-result.ts` |
| Fork mapping and retained-layer reconstruction | `src/fork.ts`, `src/retention.ts` |
| Native revert provenance and reconciliation | `src/revert.ts` |
| Idle evidence and protected execution spans | `src/activity.ts`, `src/history.ts` |
| Request/report accounting and guards | `src/budget.ts`, `src/autocompaction.ts`, `src/auto-state.ts` |
| Emergency prefix/tail selection and summaries | `src/last-resort.ts` |
| Manual workflows, batches and saved-summary edits | `src/controller.ts`, `src/batch.ts`, `src/summary-editor.ts` |
| Helper progress counters | `src/summary-progress.ts`, `src/server.ts` |
| Token rules, metrics and status | `src/text.ts`, `src/tokens.ts`, `src/metrics.ts`, `src/status.ts` |
| Server artifacts and effective export | `src/storage.ts`, `src/snapshot.ts` |
| Terminal registration and suspension-event lifecycle | `src/tui.tsx` |
| Inspector and public input guard | `src/inspector.tsx`, `src/ui.ts`, list/menu/reader/help TSX modules |
| Read-only child browser and observation loader | `src/subagents.tsx`, observer RPCs in `src/server.ts` |
| Overview and display-only accounting | `src/context-overview.tsx`, `src/inspector-view.ts` |

### Data flow

1. Setup validates options and registers hidden deny-all helpers, hooks and authenticated native RPC. It does not rewrite configuration or open a separate control listener.
2. The inspector reads server snapshots. TUI caches and display values are not editing authority.
3. Native active history becomes small domain envelopes. Native source hashes preserve identity for fields not rendered by normalization.
4. Replay produces effective blocks. Operations carry source IDs, expected hashes and revision checks; checked commits replay again and preserve unrelated metadata.
5. OpenCode lowers history to canonical `@opencode/ai` messages before context hooks. Projection edits owned current entries/call-result pairs; it does not rebuild the private converter.
6. Reductions and restoration preserve anchored chronological placement and current-hook pre-images, including earlier-hook redactions.
7. The request guard measures the projected request plus available system/tool context. Resume releases that same held hook with updated policy, not a new prompt.

Stored transcript, normalized effective view, canonical hook request, provider wire and export are distinct. Do not claim counters/exports are wire-accurate.

Replay owns one detached copy of native-domain input and shares immutable retained layers. Restoration copies the block wrappers before editing them; never mutate a saved pre-image. Request projections and counted units may be reused only inside one hook invocation, keyed by the complete policy hash. A revision number alone cannot distinguish alternative candidates, and a cache must not cross changed hook inputs.

### Passive observation

`children` and `observe` use authenticated native RPC at the session's current location. They read public session data directly, not `nativeSession`, so observation cannot initialize a child/fork ledger, backfill provenance or reconcile native revert. `observe` checks owned policy decoding and rechecks location, policy and revert after reading context. Concurrent changes fail visibly rather than presenting mismatched source/policy snapshots. Missing or foreign saved state is never reset for display.

`Autocompaction.observe` copies only a currently owned in-memory pause. It never calls gate validity checks, updates metadata, cancels a helper or releases a held request. Persisted pause notices do not become live display authority. Idle detection is an observation, not an editing lock; a timeout is shown as running/busy. Child pages verify `parentID` independently of native cursor filters and omit internal helpers; nested navigation loads one level at a time.

The read-only remote adapter blocks mutations independently of UI shortcuts; controllers also reject maintenance when their host is read-only. Summary readers expose no edit/request actions. Disposal owns no child execution or automatic helper. Polling is coalesced and ignores late responses after disposal. Context polls preserve visible source anchors; readers freeze a snapshot. Do not navigate away, resume, abort, or revalidate an AUTO gate just because a displayed pause disappears. Test these properties with a held provider response and a live automatic helper, not only static mock history.

## Persistence

| State | Location / format |
| --- | --- |
| Ledger | Session metadata `opencode_context_manager`; writes format **13** |
| Strategy and pause notice | Separate session-metadata namespace; notice is not live authority |
| Effective export | Schema **7** |
| Budget cache | Format **2**, server-local hashes/counts rather than request text |

Package, host, RPC and persisted-format compatibility are separate concerns. Do not downgrade sessions to a reader that cannot understand their stored format. Decoder compatibility is defined by `src/ledger.ts` and its frozen fixtures, not by release prose. Preserve supported records and fingerprints; refuse malformed/foreign state rather than resetting it. Unreleased source checkouts can persist real state too.

Normal maintenance appends operations. Verified committed native revert rebuilds retained reversible layers instead. `historyHash` retains its established representation, including the fixed `nativeVersion: 2` discriminator inside the hash; this is not a runtime switch. Native-derived `retainReasoning` is a replay fact, not an extra fingerprint field.

Native-derived shell settlement/background flags also stay outside fingerprints. Keep shell records' stored domain role and turn grouping stable; summary replacement alone introduces a user/assistant pair, with distinct IDs even for a single shell record. Settled leading shell input is eligible, but a background-only omitted record needs visible follow-up context. Restoration uses current canonical pre-images, never resurrects omitted background shell wrappers, and never executes a command. Exercise `script/shell-summary-smoke.ts` against an isolated host for the immediate summary/restoration requests.

Normalization reads current `native` provider data and checkpoint `metadata.recent`, without old-host DTO fallbacks. Source hashing still uses the established field names for assistant/part data so saved reductions retain their fingerprints; this is persistence compatibility, not an old-host adapter. Conflicting aliases remain hashed, not silently discarded. Opaque hosted-tool checks use `native`; checkpoints stay read-only. Do not reconstruct a legacy split tool payload from merged native data or rewrite saved hashes to conceal a lossy host migration.

### Reversible layers

- A summary stores its current text and stable ID; revisions do not add expansion layers.
- Pruning reconstructs an immutable per-turn stack. `expand` names summary IDs, exact per-turn `pruneTargets`, and/or `deletedIDs`.
- A deleted range is one block with empty messages, source IDs and a deletion ID. It contributes no provider placeholder or content tokens.
- Replay-only `previous` and `pruning` hold restoration state. Never put them into helper input, provider metadata or effective exported blocks.
- A summary expands without restoring hidden pruning. An ordinary turn restores its latest effective pruning layer. A deleted range restores its prior effective blocks. Mixed disjoint restoration applies atomically.
- Partial restoration of a wider prune leaves other turns unchanged. Split checkpoint tails restore only their own IDs and cannot resurrect the hidden prefix.
- Replay separates an ordinary block at each saved operation's last source before matching its ordered IDs and fingerprint. Later synthetic input or resumed assistant work must not extend an earlier operation. Apply these boundaries in operation order, not all at once: earlier pruning/restoration targets retain their original grouping. Do not split summaries or deleted ranges, rewrite hashes, clear the ledger or infer boundaries from timestamps. Existing matching ledgers require no migration.
- Successful idle is not a permanent turn boundary. Test a saved final-turn reduction followed by background completion, further tool steps, another completion, restart and restoration. New input stays visible and unpruned; main budget/protected-span guards remain authoritative. Missing, reordered, inserted or changed selected sources still fail.
- Canonical restoration uses current incoming hook snapshots, not stored unredacted text. Restore wrappers, attachments, error content and whole tool pairs consistently.

### Child and fork ownership

Ordinary fresh children receive an empty own ledger only after copied ownership is verified against ancestry. Keep unrelated metadata and remove inherited pause authority. Initialization is coalesced; pending writes drain on unload.

Native forks have `fork.sessionID`, not ordinary-child `parentID`. Match copied native payloads in order at the recorded cutoff, ignoring only reassigned top-level message IDs. Reconstruct independent operations with mapped sources and new fingerprints; never write the source session. Complete reductions stay applied, crossing reductions open recursively, current summary revisions remain current, and undone audit operations need not be copied.

Immutable `turnEnds` preserves copied leaf/checkpoint boundaries. Initialization rechecks target policy/location/history before merging metadata. Nested uninitialized forks use the copied snapshot without initializing ancestors. Source history must match during initialization; afterward source removal is allowed. Missing or mismatched sources fail closed.

### Native revert

The `sources` manifest records ordered IDs, message hashes, user-turn flags and creation times through the last referenced message; it contains no message bodies. Missing optional timestamps may be backfilled only from matching intact history. Invalid supplied timestamps are rejected; missing values must never become invented zeros.

While undo is staged, derive the retained view without replacing saved redo authority. Context maintenance/generation stays blocked. Clearing undo can append an idle record, making pending proposals stale even when visible content matches.

After commit, accept only a verified retained prefix followed by sufficiently new records. Changed survivors, interior holes, incomplete provenance and unfamiliar checkpoint windows fail closed. Absent suffix placeholders exist only while reconstructing the transformation tree; they never enter requests, helpers, exports or counters. Ordinary replay does not bypass source checks.

Coalesce reconciliation and recheck policy, history, location and unload state before writing. Re-read a staged/committed race once; further drift fails. Preserve unrelated metadata and remove obsolete pause notices. Correctness must not depend on asynchronous revert events.

Reconstruction changes the ledger `epoch`, invalidates incompatible usage and excludes retained reports until new requests establish their own measurements. Normal maintenance cannot rewrite `turnEnds`, `sources` or `epoch`. The host owns prompt restoration and file rollback; this is strict prefix reconciliation, not arbitrary recovery or a transaction against external writers.

## Behavioral invariants

### Editing and projection

- USER turns start at user messages; associated synthetic/skill/shell content belongs to the effective range. Control/system/idle records are not editable USER text. Label unfinished/user-only turns honestly.
- Ranges are inclusive and disjoint; adjacent selections stay separate. Summaries and deleted ranges are indivisible until expanded.
- Do not rewrite native transcript messages. Spilling is ingestion-time previewing, distinct from reversible request projection.
- Reasoning pruning removes safe whole parts and retains failed/interrupted attempts whose content may have become ordinary text. Never infer reasoning by prose matching. Retained text must remain in replay, counts, helpers and exports; use ordinary pruning status.
- Large-result pruning preserves inputs/attachments and Unicode boundaries, pins its rule/tokenizer, and skips duplicate/non-saving cuts. All-output pruning replaces terminal/error content and attachments. Whole-call deletion removes both calls and results and requires reasoning pruning.
- Keep unselected/system context and provider call state unchanged. Never write plugin provenance into `providerMetadata`.
- Check source/role/call/result identity. The host's deliberate omission of background shell records is a specific exception, not permission to ignore missing arbitrary messages or tool pairs.
- Native checkpoints are read-only. Unsettled historical tools and ambiguous opaque provider results retain explicit guards. Public active context is not arbitrary full pre-checkpoint history.
- Recheck idle, revision, source, native-revert and protected-span state before applying. Ctrl+E removes only the UI confirmation; it does not bypass these checks.
- All manual writes share `Controller.applyOperations`; restoration prepares only operation targets and expected state, not a display preview. Recheck native revert again immediately before writing.

### Summaries and edits

- Freeze effective history, runtime background, source fingerprint, revision, tokenizer and scope once per batch.
- Full-context mode gives each initial helper the same frozen background. Head isolation includes preceding blocks plus selection; total isolation includes only selection. Both omit runtime background. No sibling results or hidden restoration provenance may leak into initial requests.
- Only selected content is a summary source. Preserve unfinished state; do not invent binary contents or execute instructions embedded in the source conversation.
- Detailed mode uses a soft 2×–20× review band on the complete wrapped replacement, with at most one follow-up. Brief mode is single-pass. Manual summaries need not save tokens; automatic candidates must fit the guard.
- Validate every assistant response after the exact admitted helper prompt. Empty, failed, unfinished, cancelled or output-limited sequences are invalid, even if a later continuation ends successfully. Do not concatenate truncated chunks or return only their tail. Prior review/edit prompts belong to separate generations.
- Apply only a complete successful batch in one checked write. Retry unresolved ranges only; preserve ready siblings. Cancellation prevents late application but cannot promise rollback of a write already in flight.
- Batch start/generation/application acquire their lock before asynchronous preflight. Progress belongs to an attempt counter, not a wall-clock timestamp. Initial drafts have no separate refinement workflow; edit applied summaries through the summary reader.
- Saved-summary editing starts a deny-all helper with only that summary and edit dialogue. Model proposals require explicit application.
- Track helpers by live generation and parent ownership. Cleanup only owned helpers on discard/apply/close/abort/reload. Do not derive authority from copied metadata.
- Manual helpers skip plugin input-budget vetoes, not ownership/source/result checks or host/provider limits. Automatic helpers and main Resume remain guarded; do not silently omit background or weaken the global multiplier.

### Live progress

Use public `session.text.delta` and `session.reasoning.delta` events for owned helper counters: `session.context` is not a reliable source of in-flight text. Return numeric counters through ownership-checked RPC, not full prompts or reasoning text. History supplies a fallback; take the maximum of saved/live totals rather than adding overlapping counts.

The inspector polls once per second while showing a batch, coalesces slow reads, ignores cancelled/late results and clears its timer on disposal. Server counters are removed with helpers/unload. These are observed character counts, not billing, ETA, acceptance or Resume authority. Missing ephemeral events and buffered provider output are uncertainty, not failure.

Unsubscribing suspension events also revokes pending asynchronous navigation. A late state read must not reopen a disposed inspector or issue a toast after plugin unload.

Test with a synthetic SSE response paused after a content delta but before finish. The actual terminal must show output while generation remains unresolved and parent metadata remains unchanged. Always release the provider gate in cleanup.

### Accounting and automatic cleanup

- Require `compaction.auto: false`; native compaction precedes the context hook. Check every main request, including tool continuations.
- Use positive explicit input capacity, otherwise context minus output, then subtract headroom. Equality fits; invalid limits fail. Preserve output caps.
- Normalize input/cache read/cache write and output/reasoning exactly once. Use per-response measurements, never accumulated session spend.
- Pair a captured request only with its matching next assistant report under exact model/provider/variant/agent/tokenizer/route/options/history identity. Include provider and model `compatibility`. Exclude invalidated reports from immediate bootstrap.
- Recount candidates against one frozen anchor. Uplift growth by at least the configured multiplier or observed input/local ratio; credit removals only by unscaled local counts. Retain unexplained overhead.
- Unpaired reconstruction is explicitly uncertain; local fallback is visibly labeled. Fork/revert histories must measure their own requests. Do not copy parent caches or use rebuilt operation order as historical wire evidence.
- Count typed tool media separately from text; do not count binary base64/URLs as prose. Preserve full payload identity. Text/JSON/error serialization remains counted as text. Use valid media fixtures and compare wire media with native content.
- Protect the full active execution span, including queued/steered input. Only the live AUTO owner may create a last-resort checkpoint within it, after verifying the unchanged exempt tail.
- AUTO_PER_TURN tries earlier USER turns, then the prefix; AUTO_SESSION tries the prefix. Children map MANUAL to AUTO_PER_TURN. Top-level MANUAL requires explicit cleanup/resume.
- Last resort retains whole messages/tool pairs/summaries around the configured tail and uses prefix-only chunk/merge helpers bounded to four rounds/64 requests. Apply only a complete fitting candidate; otherwise end AUTO without manual fallback or oversized dispatch.
- Refuse oversized synthetic-only context with no USER turn. Deliver queued inputs exactly once.
- Idle observations are evidence, not an admission lock. Recheck before acquiring a pause. Only the in-memory owner can resume; saved notices cannot revive waits.
- Release the original hook on Resume; never create a prompt/synthetic substitute. Stop/move/delete/reload/unload/event loss revoke authority. Late finalizers must not overwrite a newer owner.

### UI and input ownership

Use public semantic theme tokens, router destinations and keymap modes. Native dialogs, pickers and readers must block shortcuts underneath them. Keep busy-repeat guards, range/cursor state and paused exit choices.

Keep the overview quiet: aligned local/selected totals and a small budget breakdown, with full diagnostics under **v**. Narrow panes switch without losing selection. Batch progress uses full width. Fixed headers/footers and measured cursor reveal must work in short terminals; textarea values come from `.plainText`.

Local character mode does not change token guards. Historical and live meters must be labeled separately, use only compatible limits, and omit invented percentages. Display values never authorize writes or Resume.

## Storage and privacy

Artifacts live in `~/.local/state/opencode-context-manager/<directory-hash>/`, keyed by the absolute working directory. Spill files older than seven days are cleaned at startup; captures/exports remain. Restrictive file creation modes do not replace checking platform ACLs.

Budget caches contain scope/history/content hashes and counts, not prompts or credentials. Validate persisted caches and discard incompatible count units/pending matches without erasing required exclusions. Never delete accounting state to force a held request through.

Exports omit hidden restoration layers, not every secret: effective content and audit summary revisions can remain sensitive. Original native history and spills survive pruning/deletion. Use synthetic sanitized reports; never dump credentials, headers or private transcript text into errors or public logs.

Known limits include no remote artifact transport, orphan-helper crash recovery, arbitrary-history repair, external-writer transaction guarantee, universal signed/opaque/provider-transport support, exact token billing or lossless summarization. Keep the package private; no published npm release or license grant is implied.
