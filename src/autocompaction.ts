import { randomUUID } from "node:crypto"
import { Controller, type Host, type Loaded, type ModelChoice } from "./controller.ts"
import { AUTO_KEY, STRATEGIES, inputBudget, strategy, type AutoCommand, type AutoControl, type AutoState, type Expected, type Pause } from "./auto-state.ts"
import { AGENT, EDIT_AGENT, KEY, type Settings } from "./config.ts"
import { append, blockMessages, hash, historyHash, activeMessages, operation, project, readPolicy, type Envelope, type Policy } from "./context.ts"
import { distribution } from "./metrics.ts"
import { tokenBasis, type TokenBasis } from "./tokens.ts"
import { bindPruneRule } from "./text.ts"
import { Storage } from "./storage.ts"
import type { BudgetReading } from "./budget.ts"
import { LastResort, lastResortRange } from "./last-resort.ts"

type Gate = {
  sessionID: string; pause: Pause; fingerprint: string; basis: TokenBasis
  protectedHash: string
  estimate?: (policy: Policy) => number | BudgetReading
  valid?: () => Promise<boolean>
  active: boolean; resolve(): void; reject(error: Error): void; worker?: Pick<Controller, "cancel" | "dispose">
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
      const changed = session.revert || (gate.valid && !await gate.valid()) || await this.host.idle(sessionID) || historyHash(await this.host.messages(sessionID)) !== gate.fingerprint
      if (changed) {
        if (gate.pause.phase === "auto") {
          gate.active = false
          gate.reject(new Error("Automatic compaction cancelled: session or model configuration changed"))
          void gate.worker?.cancel().catch(() => {})
          return { strategy: strategy(session) }
        }
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
    if (gate.valid && !await gate.valid()) throw new Error("Model/provider configuration changed while paused. Abort this run before continuing.")
    if (await this.host.idle(gate.sessionID)) throw new Error("The host no longer has a suspended run; abort or reopen the inspector")
    const loaded = await new Controller(this.host, gate.sessionID, this.config, this.storage).load()
    if (loaded.session.revert) throw new Error("Session was reverted while suspended. Abort this run before continuing.")
    if (loaded.fingerprint !== gate.fingerprint) throw new Error("Session source changed while suspended. Abort this run before continuing.")
    const protectedTurn = protectedBlocks(loaded, gate.pause)
    if (!protectedTurn.length || historyHash(protectedTurn.flatMap((block) => block.messages)) !== gate.protectedHash) throw new Error("The protected active turn changed. Abort this run before continuing.")
    loaded.tokenizer = gate.basis
    loaded.pruneRule = bindPruneRule(this.config.prune, gate.basis)
    const estimate = gate.estimate ? gate.estimate(loaded.policy) : distribution(loaded.blocks, loaded.runtime, gate.basis).total
    gate.pause.tokens = typeof estimate === "number" ? estimate : estimate.tokens
    gate.pause.accounting = typeof estimate === "number" ? undefined : estimate
    return loaded
  }

  async beforeRequest(messages: Envelope[], input?: { model: ModelChoice; protectedIDs: string[]; estimate: (policy: Policy) => number | BudgetReading; valid?: () => Promise<boolean> }) {
    const user = messages.findLast((message) => message.info.role === "user")?.info
    const sessionID = user?.sessionID ?? messages[0]?.info.sessionID
    if (!sessionID || (user && [AGENT, EDIT_AGENT, "title", "summary", "compaction"].includes(user.agent))) return
    const session = await this.host.session(sessionID)
    if (session.metadata?.context_manager_job) return
    const choice = input?.model ?? (user?.role === "user" ? user.model : undefined)
    if (!choice) return
    const model = (await this.host.models()).find((model) => model.id === choice.modelID && model.providerID === choice.providerID)
    if (!model) throw new Error("Autocompaction cannot find the active model's limits")
    const budget = inputBudget(model, this.config.autocompaction.headroom)
    const basis = tokenBasis(choice, model, this.config.tokenizer)
    const blocks = project(activeMessages(messages), readPolicy(session))
    const estimate = input ? input.estimate(readPolicy(session)) : distribution(blocks, await this.storage.capture(session.id), basis).total
    const tokens = typeof estimate === "number" ? estimate : estimate.tokens
    if (tokens <= budget.threshold) return
    if (!user || user.role !== "user") throw new Error("Context exceeds the budget but has no USER turn to protect. Reduce the synthetic input through its owner or use a fresh session.")
    let resolve!: () => void
    let reject!: (error: Error) => void
    const waiting = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    void waiting.catch(() => {})
    const raw = await this.host.messages(session.id)
    const protectedIDs = input?.protectedIDs ?? [user.id]
    const protectedTurn = project(activeMessages(raw), readPolicy(session)).filter((block) => block.sourceIDs.some((id) => protectedIDs.includes(id)))
    if (!protectedTurn.length) throw new Error("Active USER turn unavailable for context suspension")
    if (await this.host.idle(session.id)) throw new Error("The host stopped before context suspension could be acquired")
    const gate: Gate = {
      sessionID: session.id, active: true, resolve, reject, basis,
      fingerprint: historyHash(raw), protectedHash: historyHash(protectedTurn.flatMap((block) => block.messages)), estimate: input?.estimate, valid: input?.valid,
      pause: { id: randomUUID(), userID: protectedTurn[0].sourceIDs[0], protectedIDs: protectedTurn.flatMap((block) => block.sourceIDs), phase: strategy(session) === "MANUAL" ? "manual" : "auto", tokens, ...(typeof estimate === "number" ? {} : { accounting: estimate }), ...budget, message: "Context threshold exceeded. Reduce earlier history; the entire active execution turn is protected." },
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
    void this.automatic(gate, mode, choice).catch((error) => {
      if (!gate.active) return
      gate.active = false
      gate.reject(new Error(`Automatic context reduction failed: ${error instanceof Error ? error.message : String(error)}`))
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
      let failed = false
      try {
        const draft = await worker.summarize("compact", selected.flatMap((block) => block.sourceIDs), choice, loaded)
        if (!gate.active) return
        const candidate = project(activeMessages(loaded.raw, loaded.session.revert), append(loaded.policy, draft.operation))
        const estimate = gate.estimate ? gate.estimate(append(loaded.policy, draft.operation)) : distribution(candidate, loaded.runtime, gate.basis).total
        const after = typeof estimate === "number" ? estimate : estimate.tokens
        if (after < gate.pause.tokens) await worker.applyOperations([draft.operation], draft)
      } catch {
        if (!gate.active) return
        await this.loaded(gate)
        failed = true
      } finally {
        await worker.dispose()
        if (gate.worker === worker) gate.worker = undefined
      }
      if (failed) break
    }
    if (!gate.active) return
    await this.lastResort(gate, choice)
  }

  private async lastResort(gate: Gate, choice?: ModelChoice) {
    const loaded = await this.loaded(gate)
    if (gate.pause.tokens <= gate.pause.threshold) { await this.locked(gate.sessionID, () => this.resume(gate)); return }
    const range = lastResortRange(loaded.blocks, this.config.autocompaction.lastResortKeepTokens, gate.basis)
    const selectedModel = choice ?? this.controller(gate).defaultModel(loaded)
    if (!selectedModel) throw new Error("Last-resort summary model is unavailable")
    gate.pause.message = `Last-resort prefix summary; preserving the newest ≈${range.tokens} tokens unchanged.`
    await this.publish(gate)
    const worker = new LastResort(this.host, gate.sessionID, this.config)
    gate.worker = worker
    try {
      const summary = await worker.summarize(range.selected, selectedModel)
      const op = { ...operation("compact", range.selected, undefined, gate.basis), checkpoint: true as const, summary }
      const next = append(loaded.policy, op)
      const estimate = gate.estimate ? gate.estimate(next) : distribution(project(activeMessages(loaded.raw), next), loaded.runtime, gate.basis).total
      const tokens = typeof estimate === "number" ? estimate : estimate.tokens
      if (tokens >= gate.pause.tokens || tokens > gate.pause.threshold) throw new Error("Last-resort summary cannot fit the request while preserving the exempt tail. Use a smaller task, a larger model, or a smaller lastResortKeepTokens setting.")
      await this.locked(gate.sessionID, async () => {
        await this.loaded(gate)
        await this.write(gate.sessionID, { [KEY]: next }, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }, gate, true)
        await this.resume(gate)
      })
    } finally {
      await worker.dispose()
      if (gate.worker === worker) gate.worker = undefined
    }
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
        const selected = strategy({ ...session, metadata: { [AUTO_KEY]: { strategy: command.strategy } } })
        await this.host.update(sessionID, { ...session.metadata, [AUTO_KEY]: { strategy: selected, ...(gate?.active ? { pause: gate.pause } : {}) } })
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

  private async write(sessionID: string, metadata: Record<string, unknown>, expected: Expected, gate?: Gate, checkpoint = false) {
    if (!gate?.active && !await this.host.idle(sessionID)) throw new Error("Main session is running; no live suspension permits editing")
    const session = await this.host.session(sessionID)
    const raw = await this.host.messages(sessionID)
    const before = readPolicy(session)
    if (before.revision !== expected.revision || historyHash(raw) !== expected.fingerprint) throw new Error("Session or policy changed before maintenance commit")
    if (gate && (!gate.active || !["manual", "auto"].includes(gate.pause.phase) || historyHash(raw) !== gate.fingerprint)) throw new Error("Suspension changed before maintenance commit")
    const next = readPolicy({ id: sessionID, metadata })
    const affected = changedOperations(before, next)
    if (affected.some((op) => op.checkpoint) && !checkpoint) throw new Error("Last-resort checkpoints require the live automatic controller")
    if (!checkpoint && gate && affected.some((op) => op.sourceIDs.some((id) => (gate.pause.protectedIDs ?? [gate.pause.userID]).includes(id)))) throw new Error("The entire active USER turn is protected until this run ends")
    if (session.revert) throw new Error("Finish native undo/unrevert before context maintenance")
    if (gate?.valid && !await gate.valid()) throw new Error("Model/provider configuration changed while paused. Abort this run before continuing.")
    const projected = project(activeMessages(raw), next)
    if (checkpoint) {
      if (!gate?.active || gate.pause.phase !== "auto" || affected.length !== 1 || !affected[0].checkpoint) throw new Error("Invalid last-resort authority")
      const range = lastResortRange(project(activeMessages(raw), before), this.config.autocompaction.lastResortKeepTokens, gate.basis)
      if (hash(affected[0].sourceIDs) !== hash(range.selected.flatMap((block) => block.sourceIDs)) || historyHash(blockMessages(projected.slice(1))) !== historyHash(blockMessages(range.tail))) throw new Error("Last-resort range or exempt tail changed")
    }
    if (!checkpoint && gate && historyHash(protectedBlocks({ blocks: projected }, gate.pause).flatMap((block) => block.messages)) !== gate.protectedHash)
      throw new Error("The protected active turn cannot change")
    await this.host.update(sessionID, { ...session.metadata, [KEY]: next, [AUTO_KEY]: session.metadata?.[AUTO_KEY] ?? { strategy: strategy(session) } })
    if (checkpoint && gate) gate.protectedHash = historyHash(blockMessages(protectedBlocks({ blocks: projected }, gate.pause)))
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

function protectedBlocks(loaded: Pick<Loaded, "blocks">, pause: Pause) {
  return loaded.blocks.filter((block) => block.sourceIDs.some((id) => (pause.protectedIDs ?? [pause.userID]).includes(id)))
}

function changedOperations(before: Policy, next: Policy) {
  if (next.sessionID !== before.sessionID) throw new Error("Invalid maintenance policy identity")
  const added = next.operations.length - before.operations.length
  if (added < 1 || next.revision !== before.revision + added ||
      hash(before.operations) !== hash(next.operations.slice(0, before.operations.length))) throw new Error("Maintenance must append operations; existing history cannot be rewritten")
  return next.operations.slice(before.operations.length)
}
