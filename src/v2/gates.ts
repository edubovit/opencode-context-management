import { randomUUID } from "node:crypto"

type Gate = {
  id: string
  release(): void
  reject(error: Error): void
}

export class Gates {
  private readonly gates = new Map<string, Gate>()
  private closed = false

  async pause(sessionID: string, ready: (id: string) => void | Promise<void>): Promise<void> {
    if (this.closed) throw new Error("Context manager gates are closed")
    if (this.gates.has(sessionID)) throw new Error("A context suspension already owns this session")
    let resolve!: () => void
    let reject!: (error: Error) => void
    const waiting = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    void waiting.catch(() => {})
    const gate = { id: randomUUID(), release: resolve, reject }
    this.gates.set(sessionID, gate)
    try {
      await ready(gate.id)
      await waiting
    } finally {
      if (this.gates.get(sessionID) === gate) this.gates.delete(sessionID)
    }
  }

  current(sessionID: string) {
    return this.gates.get(sessionID)?.id
  }

  release(sessionID: string, id: string) {
    const gate = this.gates.get(sessionID)
    if (!gate || gate.id !== id) throw new Error("This context suspension is no longer active")
    this.gates.delete(sessionID)
    gate.release()
  }

  cancel(sessionID: string, error = new Error("Suspended session stopped")) {
    const gate = this.gates.get(sessionID)
    if (!gate) return
    this.gates.delete(sessionID)
    gate.reject(error)
  }

  close() {
    this.closed = true
    for (const sessionID of this.gates.keys()) this.cancel(sessionID, new Error("Context manager unloaded"))
  }
}
