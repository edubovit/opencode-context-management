import { randomUUID } from "node:crypto"
import { Controller, type Host, type Loaded, type ModelChoice } from "./controller.ts"
import { AUTO_KEY, STRATEGIES, inputBudget, strategy, type AutoCommand, type AutoControl, type AutoState, type Expected, type Pause } from "./auto-state.ts"
import { AGENT, EDIT_AGENT, type Settings } from "./config.ts"
import { append, hash, historyHash, nativeActive, project, readPolicy, type Envelope, type Policy } from "./context.ts"
import { distribution } from "./metrics.ts"
import { tokenBasis, type TokenBasis } from "./tokens.ts"
import { bindPruneRule } from "./text.ts"
import { Storage } from "./storage.ts"

type Gate = {
  sessionID: string; pause: Pause; fingerprint: string; basis: TokenBasis
  protectedHash: string
  active: boolean; resolve(): void; reject(error: Error): void; worker?: Controller
}

export class Autocompaction implements AutoControl {
  private gates = new Map<string, Gate>()
  private queues = new Map<string, Promise<unknown>>()
  constructor(private host: Host, private config: Settings, private storage: Storage) {}

  private locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(run)
    this.queues.set(id, next)
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id) }).catch(() => {})
    return next
  }

  async state(sessionID: string): Promise<AutoState> {
    const gate = this.gates.get(sessionID)
    const session = await this.host.session(sessionID)
    if (gate?.active && ["manual", "auto"].includes(gate.pause.phase)) {
      const changed = session.revert || await this.host.idle(sessionID) || historyHash(await this.host.messages(sessionID)) !== gate.fingerprint
      if (changed) {
        gate.pause.phase = "invalid"
        gate.pause.message = "The suspended request no longer matches current session state. Abort this run; do not resume it."
        void gate.worker?.cancel().catch(() => {})
        await this.publish(gate)
      }
    }
    return { strategy: strategy(session), ...(gate?.active ? { pause: { ...gate.pause } } : {}) }
  }

  private publish(gate: Gate) { return this.locked(gate.sessionID, () => this.publishLocked(gate)) }

  private async publishLocked(gate: Gate) {
    const current = this.gates.get(gate.sessionID)
    if (current && current !== gate) return
    const session = await this.host.session(gate.sessionID)
    await this.host.update(gate.sessionID, { ...session.metadata, [AUTO_KEY]: { strategy: strategy(session), ...(gate.active ? { pause: gate.pause } : {}) } })
  }

  private controller(gate: Gate) {
    const host: Host = {
      ...this.host,
      auto: { state: (id) => this.state(id), command: (id, command) => this.command(id, command), commit: (id, metadata, expected) => this.commit(id, metadata, expected) },
      idle: async (id) => id === gate.sessionID ? gate.active && ["manual", "auto"].includes(gate.pause.phase) : this.host.idle(id),
      update: (id, metadata, expected) => {
        if (!expected) throw new Error("Missing maintenance source check")
        return this.locked(id, () => this.write(id, metadata, expected, gate))
      },
    }
    return new Controller(host, gate.sessionID, this.config, this.storage)
  }

  private async loaded(gate: Gate): Promise<Loaded> {
    if (!gate.active) throw new Error("Suspended run is no longer active")
    if (await this.host.idle(gate.sessionID)) throw new Error("The host no longer has a suspended run; abort or reopen the inspector")
    const loaded = await new Controller(this.host, gate.sessionID, this.config, this.storage).load()
    if (loaded.session.revert) throw new Error("Session was reverted while suspended. Abort this run before continuing.")
    if (loaded.fingerprint !== gate.fingerprint) throw new Error("Session source changed while suspended. Abort this run before continuing.")
    const protectedTurn = loaded.blocks.find((block) => block.sourceIDs.includes(gate.pause.userID))
    if (!protectedTurn || historyHash(protectedTurn.messages) !== gate.protectedHash) throw new Error("The protected active turn changed. Abort this run before continuing.")
    loaded.tokenizer = gate.basis
    loaded.pruneRule = bindPruneRule(this.config.prune, gate.basis)
    gate.pause.tokens = distribution(loaded.blocks, loaded.runtime, gate.basis).total
    return loaded
  }

  async beforeRequest(messages: Envelope[]) {
    const user = messages.findLast((message) => message.info.role === "user")?.info
    if (!user || user.role !== "user" || [AGENT, EDIT_AGENT, "title", "summary", "compaction"].includes(user.agent)) return
    const session = await this.host.session(user.sessionID)
    if (session.metadata?.context_manager_job) return
    const model = (await this.host.models()).find((model) => model.id === user.model.modelID && model.providerID === user.model.providerID)
    if (!model) throw new Error("Autocompaction cannot find the active model's limits")
    const budget = inputBudget(model, this.config.autocompaction.headroom)
    const basis = tokenBasis(user.model, model, this.config.tokenizer)
    const blocks = project(nativeActive(messages), readPolicy(session))
    const tokens = distribution(blocks, await this.storage.capture(session.id), basis).total
    if (tokens <= budget.threshold) return
    let resolve!: () => void
    let reject!: (error: Error) => void
    const waiting = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    void waiting.catch(() => {})
    const raw = await this.host.messages(session.id)
    const protectedTurn = project(nativeActive(raw), readPolicy(session)).find((block) => block.sourceIDs.includes(user.id))
    if (!protectedTurn) throw new Error("Active USER turn unavailable for context suspension")
    const gate: Gate = {
      sessionID: session.id, active: true, resolve, reject, basis,
      fingerprint: historyHash(raw), protectedHash: historyHash(protectedTurn.messages),
      pause: { id: randomUUID(), userID: user.id, phase: strategy(session) === "MANUAL" ? "manual" : "auto", tokens, ...budget, message: "Context threshold exceeded. Reduce earlier history; the entire active USER turn is protected." },
    }
    if (this.gates.has(session.id)) throw new Error("A context suspension already owns this session")
    this.gates.set(session.id, gate)
    try {
      await this.publish(gate)
      const selectedStrategy = strategy(session)
      if (selectedStrategy !== "MANUAL") this.start(gate, selectedStrategy)
      await waiting
    } finally {
      gate.active = false
      if (this.gates.get(session.id) === gate) this.gates.delete(session.id)
      await gate.worker?.dispose().catch(() => {})
      await this.publish(gate).catch(() => {})
    }
  }

  private start(gate: Gate, mode: Exclude<AutoState["strategy"], "MANUAL">, choice?: ModelChoice) {
    gate.pause.phase = "auto"
    void this.automatic(gate, mode, choice).catch(async (error) => {
      if (!gate.active) return
      if (gate.pause.phase !== "invalid") gate.pause.phase = "manual"
      gate.pause.message = error instanceof Error ? error.message : String(error)
      await this.publish(gate).catch(() => {})
    })
  }

  private async automatic(gate: Gate, mode: "AUTO_PER_TURN" | "AUTO_SESSION", choice?: ModelChoice) {
    const attempted = new Set<string>()
    let wholeAttempted = false
    await this.publish(gate)
    while (gate.active) {
      const loaded = await this.loaded(gate)
      if (gate.pause.tokens <= gate.pause.threshold) {
        await this.locked(gate.sessionID, () => this.resume(gate))
        return
      }
      const stop = loaded.blocks.findIndex((block) => block.sourceIDs.includes(gate.pause.userID))
      if (stop < 0) throw new Error("Protected active turn is no longer present; abort this run")
      const earlier = loaded.blocks.slice(0, stop)
      const next = mode === "AUTO_PER_TURN" ? earlier.find((block) => block.kind === "turn" && !attempted.has(block.sourceIDs[0])) : undefined
      if (next) attempted.add(next.sourceIDs[0])
      else if (wholeAttempted || !earlier.length) break
      else wholeAttempted = true
      const selected = next ? [next] : earlier
      gate.pause.message = next ? `Compacting earlier USER turn (${attempted.size} attempted).` : "Compacting the whole earlier prefix (one fallback pass)."
      await this.publish(gate)
      const worker = this.controller(gate)
      gate.worker = worker
      try {
        const draft = await worker.summarize("compact", selected.flatMap((block) => block.sourceIDs), choice, loaded)
        if (!gate.active) return
        const candidate = project(nativeActive(loaded.raw, loaded.session.revert), append(loaded.policy, draft.operation))
        const after = distribution(candidate, loaded.runtime, gate.basis).total
        if (after < gate.pause.tokens) await worker.applyOperations([draft.operation], draft)
      } finally {
        await worker.dispose()
        if (gate.worker === worker) gate.worker = undefined
      }
    }
    if (!gate.active) return
    gate.pause.phase = "manual"
    gate.pause.message = "Automatic compaction could not free enough space. Resume is blocked; reduce earlier history or abort the run."
    await this.publish(gate)
  }

  private async resume(gate: Gate) {
    await this.loaded(gate)
    if (gate.pause.tokens > gate.pause.threshold) throw new Error(`Resume blocked: remove at least ≈${gate.pause.tokens - gate.pause.threshold} more tokens`)
    gate.pause.phase = "resuming"
    await this.publishLocked(gate)
    gate.resolve()
  }

  async command(sessionID: string, command: AutoCommand): Promise<AutoState> {
    await this.locked(sessionID, async () => {
      const gate = this.gates.get(sessionID)
      if (command.action === "strategy") {
        if (!STRATEGIES.includes(command.strategy)) throw new Error("Unknown autocompaction strategy")
        if (gate?.pause.phase === "auto") throw new Error("Wait for automatic compaction to finish or abort the run")
        const session = await this.host.session(sessionID)
        await this.host.update(sessionID, { ...session.metadata, [AUTO_KEY]: { strategy: command.strategy, ...(gate?.active ? { pause: gate.pause } : {}) } })
        return
      }
      if (!gate?.active || gate.pause.id !== command.pauseID) throw new Error("This suspension is no longer active")
      if (command.action === "abort") {
        gate.pause.phase = "aborting"
        gate.active = false
        void gate.worker?.cancel().catch(() => {})
        try { await this.host.abort(sessionID) }
        finally { gate.reject(new Error("Suspended run aborted")) }
        return
      }
      if (gate.pause.phase !== "manual") throw new Error("Wait for automatic compaction to finish or abort the run")
      if (command.action === "resume") await this.resume(gate)
      else if (command.action === "run") {
        const selected = strategy(await this.host.session(sessionID))
        if (selected === "MANUAL") throw new Error("Choose an AUTO strategy first")
        this.start(gate, selected, command.model)
      } else throw new Error("Unknown autocompaction action")
    })
    return this.state(sessionID)
  }

  async commit(sessionID: string, metadata: Record<string, unknown>, expected: Expected) {
    return this.locked(sessionID, async () => {
      const gate = this.gates.get(sessionID)
      if (gate?.active && gate.pause.phase !== "manual") throw new Error("The suspended run is not available for manual changes")
      await this.write(sessionID, metadata, expected, gate)
    })
  }

  private async write(sessionID: string, metadata: Record<string, unknown>, expected: Expected, gate?: Gate) {
    if (!gate?.active && !await this.host.idle(sessionID)) throw new Error("Main session is running; no live suspension permits editing")
    const session = await this.host.session(sessionID)
    const raw = await this.host.messages(sessionID)
    const before = readPolicy(session)
    if (before.revision !== expected.revision || historyHash(raw) !== expected.fingerprint) throw new Error("Session or policy changed before maintenance commit")
    if (gate && (!gate.active || !["manual", "auto"].includes(gate.pause.phase) || historyHash(raw) !== gate.fingerprint)) throw new Error("Suspension changed before maintenance commit")
    const next = readPolicy({ id: sessionID, metadata })
    const affected = changedOperations(before, next)
    if (gate && affected.some((op) => op.sourceIDs.includes(gate.pause.userID))) throw new Error("The entire active USER turn is protected until this run ends")
    if (session.revert) throw new Error("Finish native undo/unrevert before context maintenance")
    const projected = project(nativeActive(raw), next)
    if (gate && historyHash(projected.find((block) => block.sourceIDs.includes(gate.pause.userID))?.messages ?? []) !== gate.protectedHash)
      throw new Error("The protected active turn cannot change")
    await this.host.update(sessionID, { ...metadata, [AUTO_KEY]: session.metadata?.[AUTO_KEY] ?? { strategy: "MANUAL" } })
    if (gate) { await this.loaded(gate); await this.publishLocked(gate) }
  }

  cancel(sessionID: string) {
    const gate = this.gates.get(sessionID)
    if (!gate) return
    gate.active = false
    void gate.worker?.cancel().catch(() => {})
    gate.reject(new Error("Suspended session stopped"))
  }
  close() { for (const id of this.gates.keys()) this.cancel(id) }
}

function changedOperations(before: Policy, next: Policy) {
  if (next.sessionID !== before.sessionID) throw new Error("Invalid maintenance policy identity")
  const added = next.cursor - before.cursor
  if (added < 1 || next.operations.length !== next.cursor || next.revision !== before.revision + added ||
      hash(before.operations.slice(0, before.cursor)) !== hash(next.operations.slice(0, before.cursor))) throw new Error("Maintenance must append operations; existing history cannot be rewritten")
  const operations = next.operations.slice(before.cursor)
  if (operations.some((op) => op.mode === "unprune")) throw new Error("Pruning is final; unprune is no longer supported")
  return operations
}
