import { Controller, type ModelChoice, type SummaryView } from "./controller.ts"

export class SummaryEditor {
  draft?: string
  private worker: Controller
  private pending?: Promise<void>
  private closed = false
  private cancelled = false
  private cleanupNeeded = false
  constructor(private readonly owner: Controller, public view: SummaryView) {
    this.worker = new Controller(owner.host, owner.sessionID, owner.config, owner.storage, "edit")
  }

  get text() { return this.draft ?? this.view.text }

  async request(instruction: string, model: ModelChoice) {
    this.available()
    this.cancelled = false
    const pending = (async () => {
      await this.owner.checkSnapshot(this.view)
      if (this.cleanupNeeded) { await this.worker.discard(); this.cleanupNeeded = false }
      if (this.closed || this.cancelled) throw new Error("Summary edit cancelled")
      const text = await this.worker.rewrite(this.text, instruction, model)
      if (this.closed || this.cancelled) throw new Error("Summary edit cancelled")
      this.draft = text
    })()
    this.pending = pending
    try { await pending } finally { this.pending = undefined }
  }

  async apply(text = this.draft) {
    this.available()
    if (text === undefined) throw new Error("No summary changes to apply")
    this.view = await this.owner.editSummary(this.view, text, () => { if (this.closed) throw new Error("Summary edit cancelled") })
    this.draft = undefined
    this.cleanupNeeded = true
    try { await this.worker.discard(); this.cleanupNeeded = false }
    catch { return "Summary updated, but edit dialogue cleanup failed. Close the reader to retry cleanup." }
  }

  async cancel() { this.cancelled = true; await this.worker.cancel() }

  async dispose() {
    this.closed = true
    await this.cancel().catch(() => {})
    await this.pending?.catch(() => {})
    await this.worker.dispose()
  }

  private available() {
    if (this.closed) throw new Error("Summary reader is closed")
    if (this.pending) throw new Error("Wait for the summary edit request")
  }
}
