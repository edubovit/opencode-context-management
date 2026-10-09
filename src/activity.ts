export class Activity {
  private readonly pending = new Map<string, Set<(error?: unknown) => void>>()
  private readonly closed = new AbortController()

  constructor(private readonly wait: (sessionID: string) => Promise<void>) {}

  async idle(sessionID: string, timeout = 25): Promise<boolean> {
    this.closed.signal.throwIfAborted()
    if (!Number.isFinite(timeout) || timeout < 0) throw new Error("Invalid idle observation timeout")
    let observers = this.pending.get(sessionID)
    if (!observers) {
      observers = new Set()
      this.pending.set(sessionID, observers)
      const current = observers
      const complete = (error?: unknown) => {
        if (this.pending.get(sessionID) === current) this.pending.delete(sessionID)
        for (const done of current) done(error)
      }
      void Promise.resolve().then(() => this.wait(sessionID)).then(() => complete(), (error: unknown) => complete(error ?? new Error("Idle observation failed")))
    }
    const current = observers
    return new Promise<boolean>((resolve, reject) => {
      const finish = (idle: boolean, error?: unknown) => {
        clearTimeout(timer)
        current.delete(done)
        this.closed.signal.removeEventListener("abort", abort)
        if (error !== undefined) reject(error)
        else resolve(idle)
      }
      const done = (error?: unknown) => finish(true, error)
      const abort = () => finish(false, this.closed.signal.reason)
      const timer = setTimeout(() => finish(false), timeout)
      current.add(done)
      this.closed.signal.addEventListener("abort", abort, { once: true })
    })
  }

  close() {
    this.closed.abort(new Error("Context manager activity observer closed"))
    this.pending.clear()
  }
}
