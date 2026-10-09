import type { Model, ModelChoice, Session } from "./model.ts"
export type { ModelChoice } from "./model.ts"
import { KEY, type Settings } from "./config.ts"
import { append, hash, historyHash, activeMessages, operation, project, readPolicy, select, serialize, type Block, type Envelope, type Operation, type Policy, type RestoreMode } from "./context.ts"
import { validatePruning, type Pruning } from "./compaction.ts"
import { generateSummary, inputEstimate, refinementPrompt, summaryEditPrompt, SUMMARIZER_SYSTEM } from "./summarize.ts"
import type { Artifacts, RuntimeCapture } from "./storage.ts"
import { snapshot } from "./snapshot.ts"
import { toolStatus } from "./status.ts"
import { bindPruneRule, chars, type PruneRule } from "./text.ts"
import { tokenBasis, type TokenBasis } from "./tokens.ts"
import { contentTokens, lastReportedUsage } from "./metrics.ts"
import { resolveRanges } from "./ranges.ts"
import type { AutoControl, AutoState, Expected } from "./auto-state.ts"

export type HelperTrigger = "manual" | "auto"

export interface Host {
  auto?: AutoControl
  session(id: string): Promise<Session>
  messages(id: string): Promise<Envelope[]>
  idle(id: string): Promise<boolean>
  update(id: string, metadata: Record<string, unknown>, expected?: Expected): Promise<void>
  models(): Promise<Model[]>
  configured(): Promise<boolean>
  createJob(purpose?: "summary" | "edit", ownerID?: string, trigger?: HelperTrigger): Promise<string>
  generate(id: string, model: ModelChoice, text: string, purpose?: "summary" | "edit"): Promise<string>
  abort(id: string): Promise<void>
  remove(id: string): Promise<void>
}
export type Loaded = { session: Session; raw: Envelope[]; policy: Policy; blocks: Block[]; fingerprint: string; runtime?: RuntimeCapture; models: Model[]; tokenizer: TokenBasis; pruneRule: PruneRule; usage?: ReturnType<typeof lastReportedUsage>; auto?: AutoState }
export type Draft = { operation: Operation; attempts: number; refinements: number; revision: number; fingerprint: string; selected: Block[]; totalBlocks: number; model: ModelChoice; jobID: string }
export type SummaryView = { id: string; text: string; block: Block; revision: number; fingerprint: string; tokenizer: TokenBasis }
export type RestorePreview = {
  operation: Operation & { mode: RestoreMode }
  revision: number
  fingerprint: string
  before: Block[]
  after: Block[]
  afterChars: number
  afterTokens: number
  summaries: number
  prunings: number
}
export type MultiRestorePreview = {
  mode: RestoreMode; operations: Operation[]; revision: number; fingerprint: string; ranges: string[][]
  before: Block[]; after: Block[]; beforeTokens: number; afterTokens: number; tokenizer: TokenBasis; summaries: number; prunings: number
}

export class Controller {
  private job?: string
  private preview?: Draft
  private cleanup?: Promise<void>
  private cancelled = false
  private working = false
  private disposed = false
  constructor(readonly host: Host, readonly sessionID: string, readonly config: Settings, readonly storage: Artifacts, private readonly purpose: "summary" | "edit" = "summary", private readonly trigger: HelperTrigger = "manual") {}

  async load(): Promise<Loaded> {
    const [session, raw, runtime, models, auto] = await Promise.all([this.host.session(this.sessionID), this.host.messages(this.sessionID), this.storage.capture(this.sessionID), this.host.models(), this.host.auto?.state(this.sessionID)])
    const policy = readPolicy(session)
    const active = sessionModel(session, raw)
    const model = models.find((m) => m.id === active?.modelID && m.providerID === active.providerID)
    const tokenizer = tokenBasis(active, model, this.config.tokenizer)
    return { session, raw, policy, blocks: project(activeMessages(raw, session.revert), policy), fingerprint: historyHash(raw), runtime, models, tokenizer, pruneRule: bindPruneRule(this.config.prune, tokenizer), usage: lastReportedUsage(raw), auto }
  }

  async requireIdle() {
    if (!await this.host.configured()) throw new Error("Server plugin is not active. Enable the plugin directory and reload OpenCode.")
    if (!await this.host.idle(this.sessionID)) throw new Error("Wait for the main session to become idle")
  }

  async prune(ids: string[], options: Pruning = { reasoning: false, tools: "large" }) {
    return this.pruneRanges([ids], options)
  }

  async pruneRanges(ranges: string[][], options: Pruning = { reasoning: false, tools: "large" }) {
    validatePruning(options)
    await this.requireIdle()
    const loaded = await this.load()
    this.requireNotReverted(loaded.session)
    const selected = resolveRanges(loaded.blocks, ranges)
    this.requireUnprotected(loaded, ranges.flat())
    const mode = options.tools === "large" ? "tool-prune" : options.tools === "all" ? "tool-prune-all" : options.tools === "delete" ? "tool-delete" : "prune-reason"
    const operations = selected.map((blocks) => ({
      ...operation(mode, blocks, options.tools === "large" ? loaded.pruneRule : undefined, loaded.tokenizer),
      ...(options.reasoning && mode !== "prune-reason" ? { pruneReason: true as const } : {}),
    })).filter((op) => {
      const after = project(activeMessages(loaded.raw, loaded.session.revert), append(loaded.policy, op))
      return historyHash(after.flatMap((block) => block.messages)) !== historyHash(loaded.blocks.flatMap((block) => block.messages))
    })
    if (!operations.length) throw new Error("No eligible content for the selected pruning modes")
    await this.applyOperations(operations, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint })
  }

  async prepareRestoreRanges(mode: RestoreMode, ranges: string[][]): Promise<MultiRestorePreview> {
    if (mode !== "expand") throw new Error("Only one-layer context restoration is supported")
    if (this.job) throw new Error("Apply or discard the summary draft before restoring context")
    await this.requireIdle()
    const loaded = await this.load()
    this.requireNotReverted(loaded.session)
    const groups = resolveRanges(loaded.blocks, ranges)
    this.requireUnprotected(loaded, ranges.flat())
    const before = groups.flat()
    const status = toolStatus(before, loaded.pruneRule, loaded.tokenizer)
    const operations = groups.map((blocks) => operation(mode, blocks, undefined, loaded.tokenizer)).filter((op) => op.summaryIDs?.length || op.pruneTargets?.length)
    if (!operations.length) throw new Error("No restorable summaries or pruning in the selection")
    const next = operations.reduce(append, loaded.policy)
    const projected = project(activeMessages(loaded.raw, loaded.session.revert), next)
    const after = resolveRanges(projected, ranges).flat()
    return {
      mode, operations, revision: loaded.policy.revision, fingerprint: loaded.fingerprint, ranges, before, after,
      beforeTokens: contentTokens(before.flatMap((block) => block.messages), loaded.tokenizer),
      afterTokens: contentTokens(after.flatMap((block) => block.messages), loaded.tokenizer), tokenizer: loaded.tokenizer,
      summaries: status.summaries, prunings: status.prunings,
    }
  }

  async checkSnapshot(expected: { revision: number; fingerprint: string }) {
    await this.requireIdle()
    const loaded = await this.load()
    this.requireNotReverted(loaded.session)
    if (loaded.policy.revision !== expected.revision || loaded.fingerprint !== expected.fingerprint)
      throw new Error("Session changed since preview. Discard and select again.")
    return loaded
  }

  async applyOperations(operations: Operation[], expected: { revision: number; fingerprint: string }, guard?: () => void) {
    if (!operations.length) throw new Error("No operations to apply")
    const loaded = await this.checkSnapshot(expected)
    this.requireUnprotected(loaded, operations.flatMap((op) => op.sourceIDs))
    const next = operations.reduce(append, loaded.policy)
    readPolicy({ id: this.sessionID, metadata: { [KEY]: next } })
    project(activeMessages(loaded.raw, loaded.session.revert), next)
    await this.save(loaded.policy, next, loaded.fingerprint, guard)
  }

  async summary(id: string): Promise<SummaryView> {
    const loaded = await this.load()
    const block = loaded.blocks.find((block) => block.summaryID === id)
    const op = loaded.policy.operations.findLast((op) => op.id === id || (op.mode === "revise" && op.targetID === id))
    if (!block || op?.summary === undefined) throw new Error("Hover a visible compact/brief summary first")
    return { id, text: op.summary, block, revision: loaded.policy.revision, fingerprint: loaded.fingerprint, tokenizer: op.tokenizer }
  }

  async editSummary(view: SummaryView, text: string, guard?: () => void) {
    if (!text.trim()) throw new Error("Summary cannot be empty")
    const loaded = await this.checkSnapshot(view)
    const block = loaded.blocks.find((block) => block.summaryID === view.id)
    if (!block || historyHash(block.messages) !== historyHash(view.block.messages)) throw new Error("Summary changed; reopen it before editing")
    if (text.trim() === view.text) return view
    const op = { ...operation("revise", [block], undefined, view.tokenizer), targetID: view.id, summary: text.trim() }
    const edited = project(activeMessages(loaded.raw, loaded.session.revert), append(loaded.policy, op)).find((block) => block.summaryID === view.id)!
    await this.applyOperations([op], view, guard)
    return { ...view, text: op.summary, block: edited, revision: view.revision + 1 }
  }

  async rewrite(summary: string, instruction: string, choice: ModelChoice) {
    this.beginWork()
    try {
      if (this.purpose !== "edit") throw new Error("Use a summary-edit worker")
      if (!instruction.trim()) throw new Error("Describe the changes you want first")
      const model = await this.resolveModel(choice)
      return await this.request(choice, model, summaryEditPrompt(summary, instruction))
    } finally {
      this.working = false
      if (this.disposed) await this.releaseJob()
    }
  }

  async prepareRestore(mode: RestoreMode, ids: string[]): Promise<RestorePreview> {
    if (mode !== "expand") throw new Error("Only one-layer context restoration is supported")
    if (this.job) throw new Error("Apply or discard the summary draft before restoring context")
    await this.requireIdle()
    const loaded = await this.load()
    this.requireNotReverted(loaded.session)
    const before = this.selection(loaded.blocks, ids)
    this.requireUnprotected(loaded, ids)
    const status = toolStatus(before, loaded.pruneRule, loaded.tokenizer)
    if (!status.summaries && !status.prunings) throw new Error("No restorable summaries or pruning in the selected range")
    const op = { ...operation(mode, before, undefined, loaded.tokenizer), mode }
    const projected = project(activeMessages(loaded.raw, loaded.session.revert), append(loaded.policy, op))
    const after = this.selection(projected, ids)
    return {
      operation: op, revision: loaded.policy.revision, fingerprint: loaded.fingerprint, before, after,
      afterChars: chars(serialize(after.flatMap((block) => block.messages))),
      afterTokens: contentTokens(after.flatMap((block) => block.messages), loaded.tokenizer),
      summaries: status.summaries, prunings: status.prunings,
    }
  }

  async applyRestore(preview: RestorePreview) {
    if (preview.operation.mode !== "expand") throw new Error("Only one-layer context restoration is supported")
    await this.requireIdle()
    const loaded = await this.load()
    this.requireNotReverted(loaded.session)
    if (loaded.policy.revision !== preview.revision || loaded.fingerprint !== preview.fingerprint)
      throw new Error("Session changed since restore preview. Cancel and preview again.")
    this.requireUnprotected(loaded, preview.operation.sourceIDs)
    const next = append(loaded.policy, preview.operation)
    project(activeMessages(loaded.raw, loaded.session.revert), next)
    await this.save(loaded.policy, next, preview.fingerprint)
  }

  async summarize(mode: "compact" | "brief", ids: string[], override?: ModelChoice, frozen?: Loaded): Promise<Draft> {
    if (this.job) throw new Error("Apply or discard the current draft before starting another compaction")
    this.beginWork()
    try {
      await this.requireIdle()
      const loaded = frozen ?? await this.load()
      this.requireNotReverted(loaded.session)
      const selected = this.selection(loaded.blocks, ids)
      this.requireUnprotected(loaded, ids)
      if (selected[0].messages[0]?.info.role !== "user") throw new Error("Summary range must start with a user message")
      const op = operation(mode, selected, undefined, loaded.tokenizer)
      const chosen = override ?? this.defaultModel(loaded)
      if (!chosen) throw new Error("Choose a compaction model first")
      const choice = { ...chosen }
      const model = await this.resolveModel(choice)
      const result = await generateSummary(op, loaded.blocks, selected, (text) => this.request(choice, model, text), loaded.runtime ? JSON.stringify(loaded.runtime) : undefined)
      const draft = { ...result, refinements: 0, revision: loaded.policy.revision, fingerprint: loaded.fingerprint, selected, totalBlocks: loaded.blocks.length, model: choice, jobID: this.job! }
      this.preview = draft
      return draft
    } catch (error) {
      await this.releaseJob()
      throw error
    } finally {
      this.working = false
      if (this.disposed) await this.releaseJob()
    }
  }

  async refine(draft: Draft, summary: string, instruction: string, override?: ModelChoice): Promise<Draft> {
    this.beginWork()
    try {
      this.requirePreview(draft)
      if (!instruction.trim()) throw new Error("Describe the changes you want first")
      await this.requireIdle()
      await this.unchanged(draft)
      const choice = { ...(override ?? draft.model) }
      const model = await this.resolveModel(choice)
      const text = await this.request(choice, model, refinementPrompt(summary, instruction))
      const revised = { ...draft, operation: { ...draft.operation, summary: text }, refinements: draft.refinements + 1, model: choice }
      this.preview = revised
      return revised
    } finally {
      this.working = false
      if (this.disposed) await this.releaseJob()
    }
  }

  async apply(draft: Draft, text: string) {
    if (this.working) throw new Error("Wait for the summary request to finish")
    this.requirePreview(draft)
    if (!text.trim()) throw new Error("Summary cannot be empty")
    const loaded = await this.unchanged(draft)
    await this.save(loaded.policy, append(loaded.policy, { ...draft.operation, summary: text.trim() }), draft.fingerprint)
    try { await this.releaseJob() }
    catch { return `Summary applied, but temporary conversation ${draft.jobID} could not be deleted. Close the inspector to retry cleanup.` }
  }

  async dump(hostVersion: string) {
    const loaded = await this.load()
    const value = snapshot(this.sessionID, hostVersion, loaded.blocks, loaded.policy, loaded.runtime, loaded.tokenizer, loaded.usage)
    return this.storage.write(`dump-${Date.now()}-${hash(this.sessionID).slice(0, 8)}.json`, value)
  }

  async cancel() {
    this.cancelled = true
    if (this.working && this.job) await this.host.abort(this.job)
  }

  async discard() {
    if (this.working) throw new Error("Cancel the summary request and wait before discarding")
    await this.releaseJob()
  }

  async dispose() {
    this.disposed = true
    await this.cancel()
    if (!this.working) await this.releaseJob()
  }

  defaultModel(loaded: Loaded): ModelChoice | undefined {
    const model = sessionModel(loaded.session, loaded.raw)
    if (!model && !this.config.summarizer.modelID) return undefined
    return {
      providerID: this.config.summarizer.providerID ?? model!.providerID,
      modelID: this.config.summarizer.modelID ?? model!.modelID,
      variant: this.config.summarizer.variant ?? (this.config.summarizer.modelID ? undefined : model?.variant),
    }
  }

  private beginWork() {
    if (this.disposed) throw new Error("Context inspector is closed")
    if (this.working) throw new Error("A summary is already running")
    this.working = true
    this.cancelled = false
  }

  private async resolveModel(choice: ModelChoice) {
    if (!choice.providerID || !choice.modelID) throw new Error("Choose a compaction model first")
    const model = (await this.host.models()).find((m) => m.id === choice.modelID && m.providerID === choice.providerID)
    if (!model) throw new Error("Summarizer model is unavailable; select a connected provider/model")
    if (choice.variant && choice.variant !== "default" && !model.variants.some((variant) => variant.id === choice.variant))
      throw new Error(`Unsupported reasoning variant: ${choice.variant}`)
    return model
  }

  private async request(choice: ModelChoice, model: Model, text: string) {
    if (this.cancelled) throw new Error("Summary cancelled")
    await this.requireIdle()
    if (this.trigger === "auto") {
      const history = this.job ? await this.host.messages(this.job) : []
      const basis = tokenBasis(choice, model, this.config.tokenizer)
      const estimate = inputEstimate(text, basis, history, SUMMARIZER_SYSTEM)
      const limit = model.limit.input || model.limit.context
      if (!limit || estimate > limit)
        throw new Error(`Automatic summary conversation may not fit summarizer: estimated ${estimate} input tokens, input limit ${limit || "unknown"}.`)
    }
    if (this.cancelled) throw new Error("Summary cancelled")
    this.job ??= await this.host.createJob(this.purpose, this.sessionID, this.trigger)
    if (this.cancelled) throw new Error("Summary cancelled")
    const summary = (await this.host.generate(this.job, choice, text, this.purpose)).trim()
    if (this.cancelled) throw new Error("Summary cancelled")
    if (!summary) throw new Error("Summarizer returned an empty result")
    return summary
  }

  private requirePreview(draft: Draft) {
    if (this.job !== draft.jobID || this.preview?.operation.id !== draft.operation.id || this.preview.refinements !== draft.refinements)
      throw new Error("This draft's conversation is no longer active; generate a new draft")
  }

  private async unchanged(draft: Draft) {
    const loaded = await this.load()
    if (loaded.policy.revision !== draft.revision || loaded.fingerprint !== draft.fingerprint)
      throw new Error("Session changed since summary generation. Discard this draft and generate again.")
    return loaded
  }

  private async releaseJob() {
    if (this.cleanup) return this.cleanup
    if (!this.job) return
    const id = this.job
    this.cleanup = this.host.remove(id).then(() => { this.job = undefined; this.preview = undefined }).finally(() => { this.cleanup = undefined })
    return this.cleanup
  }

  private selection(blocks: Block[], ids: string[]) {
    const start = blocks.findIndex((b) => b.sourceIDs[0] === ids[0])
    const end = blocks.findIndex((b) => b.sourceIDs.at(-1) === ids.at(-1))
    const chosen = select(blocks, start, end)
    if (hash(chosen.flatMap((b) => b.sourceIDs)) !== hash(ids)) throw new Error("Selection changed; refresh and select again")
    return chosen
  }

  private requireNotReverted(session: Session) {
    if (session.revert) throw new Error("Finish OpenCode's undo/unrevert before creating context operations")
  }

  private requireUnprotected(loaded: Loaded, ids: string[]) {
    const pause = loaded.auto?.pause
    if (pause && ids.some((id) => (pause.protectedIDs ?? [pause.userID]).includes(id))) throw new Error("The entire active USER turn is protected until this run ends")
  }

  private async save(before: Policy, next: Policy, fingerprint: string, guard?: () => void) {
    await this.requireIdle()
    const [session, raw] = await Promise.all([this.host.session(this.sessionID), this.host.messages(this.sessionID)])
    if (readPolicy(session).revision !== before.revision || historyHash(raw) !== fingerprint)
      throw new Error("Session or policy changed; refresh before applying")
    guard?.()
    await this.host.update(this.sessionID, { ...session.metadata, [KEY]: next }, { revision: before.revision, fingerprint })
  }
}

function sessionModel(session: Session, raw: Envelope[]): ModelChoice | undefined {
  const last = raw.findLast((message) => message.info.role === "user")?.info
  const active = session.model
  return active ? { providerID: active.providerID, modelID: active.id, variant: active.variant } : last?.role === "user" ? last.model : undefined
}
