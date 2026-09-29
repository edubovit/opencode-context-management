import { Controller, type Draft, type Loaded, type ModelChoice } from "./controller.ts"
import { resolveRanges } from "./ranges.ts"

export type BatchEntry = {
  ids: string[]; worker: Controller; choice: ModelChoice; status: "pending" | "running" | "ready" | "error"
  draft?: Draft; text: string; request: string; error?: string
}

export class SummaryBatch {
  entries: BatchEntry[] = []
  private frozen?: Loaded
  private mode: "compact" | "brief" = "compact"
  private task?: Promise<void>
  private closed = false
  private cancelled = false
  private applied = false
  constructor(private readonly owner: Controller) {}

  get snapshot() { return this.frozen }
  get ready() { return !this.closed && !this.cancelled && !this.applied && !this.task && this.entries.length > 0 && this.entries.every((entry) => entry.status === "ready") }

  async start(mode: "compact" | "brief", ranges: string[][], override?: ModelChoice) {
    if (this.closed) throw new Error("Context inspector is closed")
    this.cancelled = false
    if (this.entries.length) {
      if (!this.applied) throw new Error("Apply or discard the current batch first")
      await this.discard()
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
    this.applied = false
    this.entries = selected.map((blocks) => ({
      ids: blocks.flatMap((block) => block.sourceIDs), choice: { ...choice }, status: "pending", text: "", request: "",
      worker: new Controller(this.owner.host, this.owner.sessionID, this.owner.config, this.owner.storage),
    }))
  }

  async generate(onChange: () => void = () => {}) {
    this.cancelled = false
    return this.run(this.entries.filter((entry) => !entry.draft), onChange)
  }

  async retry(index: number, onChange: () => void = () => {}) {
    const entry = this.entries[index]
    if (!entry || entry.draft) throw new Error("Choose a failed range to retry")
    return this.run([entry], onChange)
  }

  private async run(entries: BatchEntry[], onChange: () => void) {
    this.requireReady()
    if (!entries.length) return
    this.cancelled = false
    try {
      await this.owner.checkSnapshot(this.expected())
      if (this.closed || this.cancelled) throw new Error("Summary cancelled")
    } catch (error) {
      for (const entry of entries) { entry.status = "error"; entry.error = error instanceof Error ? error.message : String(error) }
      onChange()
      throw error
    }
    const task = Promise.all(entries.map(async (entry) => {
      entry.status = "running"
      entry.error = undefined
      onChange()
      try {
        await entry.worker.discard()
        if (this.closed || this.cancelled) throw new Error("Summary cancelled")
        const draft = await entry.worker.summarize(this.mode, entry.ids, entry.choice, this.frozen)
        entry.draft = draft
        entry.text = draft.operation.summary!
        entry.status = "ready"
      } catch (error) {
        entry.status = "error"
        entry.error = error instanceof Error ? error.message : String(error)
      }
      onChange()
    })).then(() => {})
    this.task = task
    try { await task } finally { this.task = undefined }
  }

  async refine(index: number) {
    this.requireReady()
    const entry = this.entries[index]
    if (!entry?.draft) throw new Error("This range has no draft to revise")
    const task = (async () => {
      const draft = await entry.worker.refine(entry.draft!, entry.text, entry.request, entry.choice)
      entry.draft = draft
      entry.text = draft.operation.summary!
      entry.request = ""
    })()
    this.task = task
    try { await task } finally { this.task = undefined }
  }

  async apply() {
    this.requireReady()
    if (!this.entries.length || this.entries.some((entry) => entry.status !== "ready" || !entry.draft))
      throw new Error("Every range must have a ready draft before applying the batch")
    if (this.entries.some((entry) => !entry.text.trim())) throw new Error("Summary cannot be empty")
    if (this.cancelled) throw new Error("Batch cancelled")
    await this.owner.applyOperations(this.entries.map((entry) => ({ ...entry.draft!.operation, summary: entry.text.trim() })), this.expected(), () => {
      if (this.closed || this.cancelled) throw new Error("Batch cancelled")
    })
    this.applied = true
    try { await this.discard() }
    catch { return "Batch applied, but some temporary conversations could not be deleted. Close the inspector to retry cleanup." }
  }

  async cancel() {
    this.cancelled = true
    await Promise.all(this.entries.map((entry) => entry.worker.cancel()))
  }

  async discard() {
    if (this.task) throw new Error("Cancel running jobs and wait before discarding the batch")
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

  private requireReady() {
    if (this.closed) throw new Error("Context inspector is closed")
    if (this.task) throw new Error("Wait for the current batch work to finish")
    if (this.applied) throw new Error("This batch has already been applied")
  }
}
