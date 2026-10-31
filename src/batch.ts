import { Controller, type Draft, type Loaded } from "./controller.ts"
import type { ModelChoice } from "./model.ts"
import { resolveRanges } from "./ranges.ts"
import type { Isolation } from "./compaction.ts"
import type { SummaryReview } from "./summarize.ts"

export type BatchEntry = {
  ids: string[]; worker: Controller; choice: ModelChoice; status: "pending" | "running" | "ready" | "error"
  draft?: Draft; error?: string
  attempt: number; started?: number; finished?: number
  progress?: Awaited<ReturnType<Controller["summaryProgress"]>>
  progressUnavailable?: boolean
  review?: SummaryReview
}

export class SummaryBatch {
  entries: BatchEntry[] = []
  private frozen?: Loaded
  private mode: "compact" | "brief" = "compact"
  private isolation: Isolation = "off"
  private task?: Promise<unknown>
  private closed = false
  private cancelled = false
  private applied = false
  private polling = false
  constructor(private readonly owner: Controller) {}

  get snapshot() { return this.frozen }
  async pollProgress() {
    if (this.polling || this.closed || this.cancelled) return
    this.polling = true
    try {
      await Promise.all(this.entries.filter((entry) => entry.status === "running").map(async (entry) => {
        const attempt = entry.attempt
        try {
          const progress = await entry.worker.summaryProgress()
          if (this.closed || this.cancelled || entry.status !== "running" || entry.attempt !== attempt) return
          entry.progress = progress
          entry.progressUnavailable = false
        } catch {
          if (this.closed || this.cancelled || entry.status !== "running" || entry.attempt !== attempt) return
          entry.progressUnavailable = true
        }
      }))
    } finally { this.polling = false }
  }
  get ready() { return !this.closed && !this.cancelled && !this.applied && !this.task && this.entries.length > 0 && this.entries.every((entry) => entry.status === "ready") }

  async start(mode: "compact" | "brief", ranges: string[][], override?: ModelChoice, isolation: Isolation = "off") {
    return this.exclusive(async () => {
      if (this.entries.length) {
        if (!this.applied) throw new Error("Apply or discard the current batch first")
        await this.clear()
      }
      await this.owner.requireIdle()
      const frozen = structuredClone(await this.owner.load())
      if (frozen.session.revert) throw new Error("Finish OpenCode's undo/unrevert before creating context operations")
      const selected = resolveRanges(frozen.blocks, ranges)
      const choice = override ?? this.owner.defaultModel(frozen)
      if (!choice) throw new Error("Choose a compaction model first")
      if (this.closed || this.cancelled) throw new Error("Summary cancelled")
      this.frozen = frozen
      this.mode = mode
      this.isolation = isolation
      this.applied = false
      this.entries = selected.map((blocks) => ({
        ids: blocks.flatMap((block) => block.sourceIDs), choice: { ...choice }, status: "pending", attempt: 0,
        worker: new Controller(this.owner.host, this.owner.sessionID, this.owner.config, this.owner.storage),
      }))
    }, true)
  }

  async generate(onChange: () => void = () => {}) {
    return this.exclusive(async () => {
      if (this.applied) throw new Error("This batch has already been applied")
      const entries = this.entries.filter((entry) => !entry.draft)
      if (!entries.length) return
      try {
        await this.owner.checkSnapshot(this.expected())
        if (this.closed || this.cancelled) throw new Error("Summary cancelled")
      } catch (error) {
        for (const entry of entries) { entry.status = "error"; entry.error = error instanceof Error ? error.message : String(error) }
        onChange()
        throw error
      }
      await Promise.all(entries.map(async (entry) => {
        entry.status = "running"
        entry.attempt++
        entry.error = undefined
        entry.started = Date.now()
        entry.finished = undefined
        entry.progress = undefined
        entry.progressUnavailable = false
        entry.review = undefined
        const attempt = entry.attempt
        onChange()
        try {
          await entry.worker.discard()
          if (this.closed || this.cancelled) throw new Error("Summary cancelled")
          entry.draft = await entry.worker.summarize(this.mode, entry.ids, entry.choice, this.frozen, this.isolation, reason => {
            if (this.closed || this.cancelled || entry.attempt !== attempt || entry.status !== "running") return
            entry.review = reason
            onChange()
          })
          entry.status = "ready"
        } catch (error) {
          entry.status = "error"
          entry.error = error instanceof Error ? error.message : String(error)
        }
        entry.finished = Date.now()
        onChange()
      }))
    }, true)
  }

  async apply() {
    return this.exclusive(async () => {
      if (this.applied) throw new Error("This batch has already been applied")
      if (!this.entries.length || this.entries.some((entry) => entry.status !== "ready" || !entry.draft))
        throw new Error("Every range must have a ready draft before applying the batch")
      if (this.entries.some((entry) => !entry.draft!.operation.summary?.trim())) throw new Error("Summary cannot be empty")
      if (this.cancelled) throw new Error("Batch cancelled")
      await this.owner.applyOperations(this.entries.map((entry) => entry.draft!.operation), this.expected(), () => {
        if (this.closed || this.cancelled) throw new Error("Batch cancelled")
      })
      this.applied = true
      try { await this.clear() }
      catch { return "Batch applied, but some temporary conversations could not be deleted. Close the inspector to retry cleanup." }
    })
  }

  async cancel() {
    this.cancelled = true
    await Promise.all(this.entries.map((entry) => entry.worker.cancel()))
  }

  async discard() {
    return this.exclusive(() => this.clear())
  }

  private async clear() {
    const results = await Promise.allSettled(this.entries.map((entry) => entry.worker.discard()))
    if (results.some((result) => result.status === "rejected")) throw new Error("Some temporary conversations could not be deleted; retry closing the inspector")
    this.entries = []
    this.frozen = undefined
  }

  async dispose() {
    this.closed = true
    await this.cancel().catch(() => {})
    await this.task?.catch(() => {})
    const results = await Promise.allSettled(this.entries.map((entry) => entry.worker.dispose()))
    if (results.some((result) => result.status === "rejected")) throw new Error("Some temporary conversations could not be deleted")
    this.entries = []
  }

  private expected() {
    if (!this.frozen) throw new Error("No frozen batch context")
    return { revision: this.frozen.policy.revision, fingerprint: this.frozen.fingerprint }
  }

  private async exclusive<T>(work: () => Promise<T>, restart = false): Promise<T> {
    if (this.closed) throw new Error("Context inspector is closed")
    if (this.task) throw new Error("Wait for the current batch work to finish")
    if (restart) this.cancelled = false
    const task = Promise.resolve().then(work)
    this.task = task
    try { return await task } finally { this.task = undefined }
  }
}
