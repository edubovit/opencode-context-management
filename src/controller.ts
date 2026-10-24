import type { Model, ModelChoice, Session } from "./model.ts"
import { KEY, type Settings } from "./config.ts"
import { append, hash, historyHash, activeMessages, operation, project, readPolicy, summaryStart, type Block, type Envelope, type Operation, type Policy } from "./context.ts"
import { validatePruning, type Isolation, type Pruning } from "./compaction.ts"
import { generateSummary, inputEstimate, summaryEditPrompt, SUMMARIZER_SYSTEM } from "./summarize.ts"
import type { Artifacts, RuntimeCapture } from "./storage.ts"
import { snapshot } from "./snapshot.ts"
import { bindPruneRule, type PruneRule } from "./text.ts"
import { tokenBasis, type TokenBasis } from "./tokens.ts"
import { lastReportedUsage } from "./metrics.ts"
import { resolveRanges } from "./ranges.ts"
import { revertPolicy } from "./revert.ts"
import type { AutoState, Expected } from "./auto-state.ts"
import { summaryProgress } from "./summary-progress.ts"
import type { HelperPurpose, HelperTrigger, Host } from "./host-contract.ts"

export type Loaded = { session: Session; raw: Envelope[]; policy: Policy; blocks: Block[]; fingerprint: string; runtime?: RuntimeCapture; models: Model[]; tokenizer: TokenBasis; pruneRule: PruneRule; usage?: ReturnType<typeof lastReportedUsage>; auto?: AutoState }
export type Draft = Expected & { operation: Operation; attempts: number; model: ModelChoice; jobID: string }
export type SummaryView = { id: string; text: string; block: Block; revision: number; fingerprint: string; tokenizer: TokenBasis }
export type RestorePlan = Expected & { operations: Operation[] }

export class Controller {
  private job?: string
  private cleanup?: Promise<void>
  private cancelled = false
  private working = false
  private disposed = false
  constructor(readonly host: Host, readonly sessionID: string, readonly config: Settings, readonly storage: Artifacts, private readonly purpose: HelperPurpose = "summary", private readonly trigger: HelperTrigger = "manual") {}

  async load(): Promise<Loaded> {
    const [session, raw, runtime, models, auto] = await Promise.all([this.host.session(this.sessionID), this.host.messages(this.sessionID), this.storage.capture(this.sessionID), this.host.models(), this.host.auto?.state(this.sessionID)])
    const policy = session.revert ? revertPolicy(raw, readPolicy(session), session.revert.messageID) : readPolicy(session)
    const active = sessionModel(session, raw)
    const model = models.find((m) => m.id === active?.modelID && m.providerID === active.providerID)
    const tokenizer = tokenBasis(active, model, this.config.tokenizer)
    return { session, raw, policy, blocks: project(activeMessages(raw, session.revert), policy), fingerprint: historyHash(raw), runtime, models, tokenizer, pruneRule: bindPruneRule(this.config.prune, tokenizer), usage: lastReportedUsage(raw), auto }
  }

  async requireIdle() {
    this.requireOpen()
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
    const before = historyHash(loaded.blocks.flatMap((block) => block.messages))
    const operations = selected.map((blocks) => ({
      ...operation(mode, blocks, options.tools === "large" ? loaded.pruneRule : undefined, loaded.tokenizer),
      ...(options.reasoning && mode !== "prune-reason" ? { pruneReason: true as const } : {}),
    })).filter((op) => {
      const after = project(activeMessages(loaded.raw, loaded.session.revert), append(loaded.policy, op))
      return historyHash(after.flatMap((block) => block.messages)) !== before
    })
    if (!operations.length) throw new Error("No eligible content for the selected pruning modes")
    await this.applyOperations(operations, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint })
  }

  async deleteRanges(ranges: string[][]) {
    await this.requireIdle()
    const loaded = await this.load()
    this.requireNotReverted(loaded.session)
    const selected = resolveRanges(loaded.blocks, ranges)
    this.requireUnprotected(loaded, ranges.flat())
    const operations = selected.filter((blocks) => blocks.some((block) => block.kind !== "deleted"))
      .map((blocks) => operation("delete", blocks, undefined, loaded.tokenizer))
    if (!operations.length) throw new Error("Selected ranges are already deleted")
    await this.applyOperations(operations, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint })
  }

  async prepareRestore(ranges: string[][]): Promise<RestorePlan> {
    if (this.job) throw new Error("Apply or discard the summary draft before restoring context")
    await this.requireIdle()
    const loaded = await this.load()
    this.requireNotReverted(loaded.session)
    const groups = resolveRanges(loaded.blocks, ranges)
    this.requireUnprotected(loaded, ranges.flat())
    const operations = groups.map((blocks) => operation("expand", blocks, undefined, loaded.tokenizer)).filter((op) => op.summaryIDs?.length || op.pruneTargets?.length || op.deletedIDs?.length)
    if (!operations.length) throw new Error("No restorable summaries, pruning or deleted ranges in the selection")
    return { operations, revision: loaded.policy.revision, fingerprint: loaded.fingerprint }
  }

  async restoreRanges(ranges: string[][]) {
    const plan = await this.prepareRestore(ranges)
    await this.applyOperations(plan.operations, plan)
  }

  async checkSnapshot(expected: Expected) {
    await this.requireIdle()
    const loaded = await this.load()
    this.requireNotReverted(loaded.session)
    if (loaded.policy.revision !== expected.revision || loaded.fingerprint !== expected.fingerprint)
      throw new Error("Session changed; refresh and select again.")
    return loaded
  }

  async applyOperations(operations: Operation[], expected: Expected, guard?: () => void) {
    if (!operations.length) throw new Error("No operations to apply")
    const loaded = await this.checkSnapshot(expected)
    this.requireUnprotected(loaded, operations.flatMap((op) => op.sourceIDs))
    const next = operations.reduce(append, loaded.policy)
    readPolicy({ id: this.sessionID, metadata: { [KEY]: next } })
    project(activeMessages(loaded.raw, loaded.session.revert), next)
    await this.save(next, expected, guard)
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

  async summarize(mode: "compact" | "brief", ids: string[], override?: ModelChoice, frozen?: Loaded, isolation: Isolation = "off"): Promise<Draft> {
    if (this.job) throw new Error("Apply or discard the current draft before starting another compaction")
    this.beginWork()
    try {
      await this.requireIdle()
      const loaded = frozen ?? await this.load()
      this.requireNotReverted(loaded.session)
      const selected = resolveRanges(loaded.blocks, [ids])[0]
      this.requireUnprotected(loaded, ids)
      if (!summaryStart(selected.flatMap((block) => block.messages))) throw new Error("Summary range must start with a visible user message or settled shell input")
      const op = operation(mode, selected, undefined, loaded.tokenizer)
      const chosen = override ?? this.defaultModel(loaded)
      if (!chosen) throw new Error("Choose a compaction model first")
      const choice = { ...chosen }
      const model = await this.resolveModel(choice)
      const result = await generateSummary(op, loaded.blocks, selected, (text) => this.request(choice, model, text), isolation === "off" && loaded.runtime ? JSON.stringify(loaded.runtime) : undefined, isolation)
      return { ...result, revision: loaded.policy.revision, fingerprint: loaded.fingerprint, model: choice, jobID: this.job! }
    } catch (error) {
      await this.releaseJob()
      throw error
    } finally {
      this.working = false
      if (this.disposed) await this.releaseJob()
    }
  }

  async dump(hostVersion: string) {
    const loaded = await this.load()
    const value = snapshot(this.sessionID, hostVersion, loaded.blocks, loaded.policy, loaded.runtime, loaded.tokenizer, loaded.usage)
    return this.storage.write(`dump-${Date.now()}-${hash(this.sessionID).slice(0, 8)}.json`, value)
  }

  async summaryProgress() {
    const job = this.job
    if (!job) return undefined
    const progress = this.host.progress ? await this.host.progress(job) : summaryProgress(await this.host.messages(job))
    if (this.job !== job) return undefined
    return progress
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
    this.requireOpen()
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

  private async releaseJob() {
    if (this.cleanup) return this.cleanup
    if (!this.job) return
    const id = this.job
    this.cleanup = this.host.remove(id).then(() => { this.job = undefined }).finally(() => { this.cleanup = undefined })
    return this.cleanup
  }

  private requireNotReverted(session: Session) {
    if (session.revert) throw new Error("Finish OpenCode's undo/unrevert before creating context operations")
  }

  private requireOpen() {
    if (this.disposed) throw new Error("Context inspector is closed")
  }

  private requireUnprotected(loaded: Loaded, ids: string[]) {
    const pause = loaded.auto?.pause
    if (pause && ids.some((id) => (pause.protectedIDs ?? [pause.userID]).includes(id))) throw new Error("The entire active USER turn is protected until this run ends")
  }

  private async save(next: Policy, expected: Expected, guard?: () => void) {
    await this.requireIdle()
    const [session, raw] = await Promise.all([this.host.session(this.sessionID), this.host.messages(this.sessionID)])
    this.requireNotReverted(session)
    if (readPolicy(session).revision !== expected.revision || historyHash(raw) !== expected.fingerprint)
      throw new Error("Session or policy changed; refresh before applying")
    this.requireOpen()
    guard?.()
    await this.host.update(this.sessionID, { ...session.metadata, [KEY]: next }, { revision: expected.revision, fingerprint: expected.fingerprint })
  }
}

function sessionModel(session: Session, raw: Envelope[]): ModelChoice | undefined {
  const last = raw.findLast((message) => message.info.role === "user")?.info
  const active = session.model
  return active ? { providerID: active.providerID, modelID: active.id, variant: active.variant } : last?.role === "user" ? last.model : undefined
}
