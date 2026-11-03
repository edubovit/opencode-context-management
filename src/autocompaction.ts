import { randomUUID } from "node:crypto"
import { Controller, type Loaded } from "./controller.ts"
import type { Host } from "./host-contract.ts"
import type { ModelChoice, Session } from "./model.ts"
import { AUTO_KEY, STRATEGIES, inputBudget, strategy, type AutoCommand, type AutoControl, type AutoState, type AutoWarning, type Expected, type Pause } from "./auto-state.ts"
import { AGENT, EDIT_AGENT, KEY, type Settings } from "./config.ts"
import { append, blockMessages, hash, historyHash, activeMessages, operation, project, readPolicy, splitOperation, summaryRangeStart, type Block, type Envelope, type Policy } from "./context.ts"
import { contentTokens, distribution } from "./metrics.ts"
import { tokenBasis, type TokenBasis } from "./tokens.ts"
import { bindPruneRule } from "./text.ts"
import { Storage } from "./storage.ts"
import type { BudgetReading } from "./budget.ts"
import { LastResort, lastResortRange } from "./last-resort.ts"

type Gate = {
  sessionID: string; pause: Pause; readonly fingerprint: string; basis: TokenBasis
  protectedHash: string
  activeIDs: ReadonlySet<string>
  estimate?: (policy: Policy) => number | BudgetReading
  valid?: () => Promise<boolean>
  active: boolean; resolve(): void; reject(error: Error): void; worker?: Pick<Controller, "cancel" | "dispose">
}

export class Autocompaction implements AutoControl {
  private gates = new Map<string, Gate>()
  private queues = new Map<string, Promise<unknown>>()
  private closed = false
  constructor(private host: Host, private config: Settings, private storage: Storage,
    private warn: (warning: AutoWarning) => void | Promise<void> = warning => { console.warn("Context manager last resort:", JSON.stringify(warning)) }) {}

  observe(session: Session): AutoState {
    const gate = this.gates.get(session.id)
    return { strategy: strategy(session), ...(gate?.active ? { pause: structuredClone(gate.pause) } : {}) }
  }

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
    return { strategy: strategy(session), ...(gate?.active ? { pause: structuredClone(gate.pause) } : {}) }
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
      update: (id, metadata, expected, guard) => {
        if (!expected) throw new Error("Missing maintenance source check")
        return this.locked(id, () => this.write(id, metadata, expected, gate, false, guard))
      },
    }
    return new Controller(host, gate.sessionID, this.config, this.storage, "summary", "auto")
  }

  private requireGate(gate: Gate) {
    if (this.closed || this.gates.get(gate.sessionID) !== gate || !gate.active || !["manual", "auto"].includes(gate.pause.phase))
      throw new Error("Suspended run is no longer active")
  }

  private async loaded(gate: Gate): Promise<Loaded> {
    this.requireGate(gate)
    if (gate.valid && !await gate.valid()) throw new Error("Model/provider configuration changed while paused. Abort this run before continuing.")
    if (await this.host.idle(gate.sessionID)) throw new Error("The host no longer has a suspended run; abort or reopen the inspector")
    const loaded = await new Controller(this.host, gate.sessionID, this.config, this.storage).load()
    this.requireGate(gate)
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
    if (this.closed) throw new Error("Context manager has been unloaded")
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
    const activeStart = raw.findIndex(message => message.info.id === user.id)
    if (activeStart < 0) throw new Error("Active USER turn unavailable for context suspension")
    const activeIDs = new Set(raw.slice(activeStart).map(message => message.info.id))
    const protectedTurn = initialProtection(project(activeMessages(raw), readPolicy(session)), protectedIDs, activeIDs)
    if (!protectedTurn.length) throw new Error("Active USER turn unavailable for context suspension")
    if (await this.host.idle(session.id)) throw new Error("The host stopped before context suspension could be acquired")
    if (this.closed) throw new Error("Context manager unloaded before context suspension could be acquired")
    const gate: Gate = {
      sessionID: session.id, active: true, resolve, reject, basis, activeIDs,
      fingerprint: historyHash(raw), protectedHash: historyHash(protectedTurn.flatMap((block) => block.messages)), estimate: input?.estimate, valid: input?.valid,
      pause: { id: randomUUID(), userID: protectedTurn[0].sourceIDs[0], protectedIDs: protectedTurn.flatMap((block) => block.sourceIDs), phase: strategy(session) === "MANUAL" ? "manual" : "auto", tokens, ...(typeof estimate === "number" ? {} : { accounting: estimate }), ...budget, message: "Context threshold exceeded. Reduce earlier history; active execution input and the final active subturn are protected." },
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
    const splitAttempted = new Set<string>()
    let wholeAttempted = false
    await this.publish(gate)
    while (gate.active) {
      const loaded = await this.loaded(gate)
      if (gate.pause.tokens <= gate.pause.threshold) {
        await this.locked(gate.sessionID, () => this.resume(gate))
        return
      }
      const protectedIDs = new Set(gate.pause.protectedIDs ?? [gate.pause.userID])
      const stop = loaded.blocks.findIndex(block => block.sourceIDs.some(id => protectedIDs.has(id)))
      if (stop < 0) throw new Error("Protected active turn is no longer present; abort this run")
      const earlier = loaded.blocks.slice(0, stop)
      const oversized = (block: Block) => block.kind === "turn" && !block.sourceIDs.some(id => attempted.has(id) || splitAttempted.has(id)) && contentTokens(block.messages, gate.basis) > this.config.autocompaction.splitThresholdTokens
      const selection = mode === "AUTO_PER_TURN" ? perTurnSelection(earlier, attempted, this.config.autocompaction.minRangeTokens, gate.basis, oversized) : undefined
      const splitting = selection?.split ?? (mode === "AUTO_PER_TURN" && !selection?.range ? loaded.blocks.slice(stop).find(block => oversized(block) && block.sourceIDs.every(id => gate.activeIDs.has(id))) : undefined)
      if (splitting) {
        for (const id of splitting.sourceIDs) splitAttempted.add(id)
        const count = Math.max(2, Math.ceil(contentTokens(splitting.messages, gate.basis) / this.config.autocompaction.maxSubturnTokens))
        let plan: ReturnType<typeof splitOperation> | undefined
        try { plan = splitOperation(splitting, count, gate.basis, this.config.subturns) } catch {}
        if (plan) {
          gate.pause.message = `Splitting an oversized USER turn into ${plan.parts} safe subturns before cleanup.`
          await this.locked(gate.sessionID, () => this.write(gate.sessionID, { [KEY]: append(loaded.policy, plan!.operation) }, { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }, gate))
        }
        continue
      }
      const next = selection?.range
      if (next) for (const block of next) for (const id of block.sourceIDs) attempted.add(id)
      else if (wholeAttempted || !earlier.length) break
      else wholeAttempted = true
      const selected = next ?? earlier
      gate.pause.message = next ? `Compacting ${next.length} earlier turn/subturn block${next.length === 1 ? "" : "s"}.` : "Compacting the whole earlier prefix (one fallback pass)."
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
    await this.warn({ sessionID: gate.sessionID, pauseID: gate.pause.id, message: "Normal automatic cleanup could not fit this request. Attempting last-resort prefix summarization; it may summarize part of the active turn while retaining the newest tail." })
    if (!gate.active) return
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

  private async write(sessionID: string, metadata: Record<string, unknown>, expected: Expected, gate?: Gate, checkpoint = false, guard?: () => void) {
    if (this.closed) throw new Error("Context manager has been unloaded")
    const phase = gate?.pause.phase
    if (!gate?.active && !await this.host.idle(sessionID)) throw new Error("Main session is running; no live suspension permits editing")
    const session = await this.host.session(sessionID)
    const raw = await this.host.messages(sessionID)
    const before = readPolicy(session)
    if (before.revision !== expected.revision || historyHash(raw) !== expected.fingerprint) throw new Error("Session or policy changed before maintenance commit")
    if (gate && (this.gates.get(sessionID) !== gate || !gate.active || !["manual", "auto"].includes(gate.pause.phase) || historyHash(raw) !== gate.fingerprint)) throw new Error("Suspension changed before maintenance commit")
    const next = readPolicy({ id: sessionID, metadata })
    const affected = changedOperations(before, next)
    const structural = affected.every(op => op.mode === "partition")
    if (!structural && affected.some(op => op.mode === "partition")) throw new Error("Structural maintenance cannot be combined with content edits")
    if (affected.some((op) => op.checkpoint) && !checkpoint) throw new Error("Last-resort checkpoints require the live automatic controller")
    if (!checkpoint && !structural && gate && affected.some((op) => op.sourceIDs.some((id) => (gate.pause.protectedIDs ?? [gate.pause.userID]).includes(id)))) throw new Error("The active USER input or final subturn is protected until this run ends")
    if (session.revert) throw new Error("Finish native undo/unrevert before context maintenance")
    if (gate?.valid && !await gate.valid()) throw new Error("Model/provider configuration changed while paused. Abort this run before continuing.")
    const projected = project(activeMessages(raw), next)
    let protection: ReturnType<typeof structuralProtection> | undefined
    if (structural) {
      const checked = gate ? await this.loaded(gate) : await new Controller(this.host, sessionID, this.config, this.storage).load()
      if (checked.fingerprint !== expected.fingerprint || hash(checked.policy) !== hash(before)) throw new Error("Session or policy changed before structural maintenance commit")
      if (!gate && !await this.host.idle(sessionID)) throw new Error("Main session is running; no live suspension permits editing")
      protection = structuralProtection(activeMessages(raw), before, affected, checked.tokenizer, this.config.subturns, gate)
    }
    if (checkpoint) {
      if (!gate?.active || gate.pause.phase !== "auto" || affected.length !== 1 || !affected[0].checkpoint) throw new Error("Invalid last-resort authority")
      const range = lastResortRange(project(activeMessages(raw), before), this.config.autocompaction.lastResortKeepTokens, gate.basis)
      if (hash(affected[0].sourceIDs) !== hash(range.selected.flatMap((block) => block.sourceIDs)) || historyHash(blockMessages(projected.slice(1))) !== historyHash(blockMessages(range.tail))) throw new Error("Last-resort range or exempt tail changed")
    }
    if (!checkpoint && !structural && gate && historyHash(protectedBlocks({ blocks: projected }, gate.pause).flatMap((block) => block.messages)) !== gate.protectedHash)
      throw new Error("The protected active turn cannot change")
    if (!await this.host.configured()) throw new Error("Context manager has been unloaded")
    if (gate?.valid && !await gate.valid()) throw new Error("Model/provider configuration changed before maintenance commit")
    const idle = await this.host.idle(sessionID)
    if (gate ? idle : !idle) throw new Error("Session activity changed before maintenance commit")
    const [current, currentRaw] = await Promise.all([this.host.session(sessionID), this.host.messages(sessionID)])
    const authorize = () => {
      if (this.closed) throw new Error("Context manager unloaded before maintenance commit")
      if (gate) {
        this.requireGate(gate)
        if (gate.pause.phase !== phase) throw new Error("Suspension phase changed before maintenance commit")
      }
      guard?.()
    }
    authorize()
    if (current.revert) throw new Error("Finish native undo/unrevert before context maintenance")
    if (historyHash(currentRaw) !== expected.fingerprint || hash(readPolicy(current)) !== hash(before)) throw new Error("Session or policy changed before maintenance commit")
    await this.host.update(sessionID, { ...current.metadata, [KEY]: next, [AUTO_KEY]: current.metadata?.[AUTO_KEY] ?? { strategy: strategy(current) } }, expected, authorize)
    authorize()
    if (gate && protection) {
      gate.pause.protectedIDs = protection.ids
      gate.pause.userID = protection.ids[0]
      gate.protectedHash = protection.hash
    }
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
  close() { this.closed = true; for (const id of this.gates.keys()) this.cancel(id) }
}

export function perTurnRange(earlier: Block[], attempted: ReadonlySet<string>, minimum: number, basis: TokenBasis): Block[] | undefined {
  return perTurnSelection(earlier, attempted, minimum, basis)?.range
}

function perTurnSelection(earlier: Block[], attempted: ReadonlySet<string>, minimum: number, basis: TokenBasis, split?: (block: Block) => boolean): { range?: Block[]; split?: Block } | undefined {
  let selected: Block[] = []
  let tokens = 0
  for (const block of earlier) {
    if (block.kind !== "turn" || block.sourceIDs.some(id => attempted.has(id))) {
      selected = []
      tokens = 0
      continue
    }
    if (!selected.length && !summaryRangeStart([block])) continue
    if (split?.(block)) return { split: block }
    selected.push(block)
    tokens += contentTokens(block.messages, basis)
    if (tokens > minimum) return { range: selected }
  }
}

function initialProtection(blocks: Block[], ids: string[], activeIDs: ReadonlySet<string>) {
  const protectedTurn = blocks.filter(block => block.sourceIDs.some(id => ids.includes(id)))
  const active = blocks.filter(block => block.sourceIDs.every(id => activeIDs.has(id)))
  const tail = active.at(-1)
  if (!tail?.subturn || !active.some(block => protectedTurn.includes(block))) return protectedTurn
  return blocks.filter(block => block === tail || (protectedTurn.includes(block) && !active.includes(block)))
}

function structuralProtection(raw: Envelope[], before: Policy, operations: Policy["operations"], basis: TokenBasis, limits: Settings["subturns"], gate?: Gate) {
  let policy = before
  let blocks = project(raw, policy)
  let ids = gate ? protectedBlocks({ blocks }, gate.pause).flatMap(block => block.sourceIDs) : []
  if (gate && historyHash(blockMessages(protectedBlocks({ blocks }, gate.pause))) !== gate.protectedHash) throw new Error("The protected active turn changed")
  for (const op of operations) {
    const selected = blocks.filter(block => block.sourceIDs.some(id => op.sourceIDs.includes(id)))
    if (hash(selected.flatMap(block => block.sourceIDs)) !== hash(op.sourceIDs)) throw new Error("Structural maintenance must select complete current blocks")
    if (op.cuts?.length) {
      if (selected.length !== 1) throw new Error("Split requires one current ordinary turn or subturn")
      const planned = splitOperation(selected[0], op.cuts.length + 1, basis, limits)
      if (hash(planned.operation.cuts) !== hash(op.cuts)) throw new Error("Split boundaries do not match the safe subturn plan")
    } else if (selected.length < 2 || selected.some(block => !block.subturn)) throw new Error("Merge requires sibling subturns")
    policy = append(policy, op)
    const projected = project(raw, policy)
    if (historyHash(blockMessages(blocks)) !== historyHash(blockMessages(projected)) || hash(blocks.flatMap(block => block.sourceIDs)) !== hash(projected.flatMap(block => block.sourceIDs))) throw new Error("Structural maintenance cannot change context content or sources")
    if (gate && op.cuts?.length && op.sourceIDs.some(id => ids.includes(id)) && op.sourceIDs.every(id => gate.activeIDs.has(id))) {
      const tail = projected.findLast(block => block.sourceIDs.some(id => op.sourceIDs.includes(id)))!
      ids = [...ids.filter(id => !op.sourceIDs.includes(id)), ...tail.sourceIDs]
    }
    ids = projected.filter(block => block.sourceIDs.some(id => ids.includes(id))).flatMap(block => block.sourceIDs)
    blocks = projected
  }
  if (gate && !ids.length) throw new Error("Structural maintenance cannot remove active protection")
  return { ids, hash: historyHash(blockMessages(blocks.filter(block => block.sourceIDs.some(id => ids.includes(id))))) }
}

function protectedBlocks(loaded: Pick<Loaded, "blocks">, pause: Pause) {
  return loaded.blocks.filter((block) => block.sourceIDs.some((id) => (pause.protectedIDs ?? [pause.userID]).includes(id)))
}

function changedOperations(before: Policy, next: Policy) {
  if (next.sessionID !== before.sessionID) throw new Error("Invalid maintenance policy identity")
  if (hash(before.turnEnds) !== hash(next.turnEnds)) throw new Error("Fork turn boundaries cannot be changed by maintenance")
  if (hash(before.subturnOrigins) !== hash(next.subturnOrigins)) throw new Error("Subturn provenance cannot be changed by maintenance")
  if (before.epoch !== next.epoch || hash(before.sources) !== hash(next.sources)) throw new Error("Revert provenance cannot be changed by maintenance")
  const added = next.operations.length - before.operations.length
  if (added < 1 || next.revision !== before.revision + added ||
      hash(before.operations) !== hash(next.operations.slice(0, before.operations.length))) throw new Error("Maintenance must append operations; existing history cannot be rewritten")
  return next.operations.slice(before.operations.length)
}
