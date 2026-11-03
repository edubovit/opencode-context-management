import { randomUUID } from "node:crypto"
import { visibleParts, type Envelope, type Part, type Session, type ToolPart } from "./model.ts"
import { hash, historyHash, sameIDs } from "./fingerprint.ts"
export { hash, historyHash } from "./fingerprint.ts"
export type { Envelope } from "./model.ts"
import { KEY } from "./config.ts"
import { chars, pruneText, toolText, type PruneRule } from "./text.ts"
import { contentTokens } from "./metrics.ts"
import { FALLBACK_BASIS, type TokenBasis } from "./tokens.ts"
import type { Operation, Policy } from "./ledger.ts"
import { planSubturns } from "./subturn-plan.ts"
export { append, emptyPolicy, readPolicy, POLICY_VERSION, type Mode, type Operation, type Policy } from "./ledger.ts"
export { toolText } from "./text.ts"

export type Block = {
  kind: "turn" | "compact" | "brief" | "deleted"
  sourceIDs: string[]
  messages: Envelope[]
  closed: boolean
  pruned?: Record<string, string>
  reasonPruned?: boolean
  toolsDeleted?: boolean
  allToolsPruned?: boolean
  summaryID?: string
  deletionID?: string
  previous?: Block[]
  pruning?: PruningLayer[]
  subturn?: { originID: string }
  segments?: Block[]
}

type PruningLayer = {
  operationID: string
  before: Pick<Block, "messages" | "pruned" | "reasonPruned" | "toolsDeleted" | "allToolsPruned">
}

export function activeMessages(messages: Envelope[], revert?: Session["revert"]) {
  const visible = messages.filter((message) => !["idle", "system", "model-switched", "agent-switched", "location-switched"].includes(message.info.kind))
  if (revert) {
    const index = visible.findIndex((m) => m.info.id === revert.messageID)
    if (index >= 0) return visible.slice(0, index)
  }
  return visible
}

export function turns(messages: Envelope[]): Block[] {
  const result: Block[] = []
  for (const message of messages) {
    if (message.info.role === "user" || result.length === 0)
      result.push({ kind: "turn", sourceIDs: [], messages: [], closed: false })
    const block = result[result.length - 1]
    block.messages.push(message)
    block.sourceIDs.push(message.info.id)
  }
  for (const block of result) {
    const last = block.messages.findLast((message) => ["user", "assistant"].includes(message.info.kind))?.info ?? block.messages.at(-1)!.info
    block.closed = block.messages[0].info.role === "user" && last.role === "assistant" &&
      !!last.time.completed && !!last.finish && !["tool-calls", "unknown"].includes(last.finish) &&
      !block.messages.some((m) => m.parts.some((p) => p.type === "tool" && ["pending", "running"].includes(p.state.status)))
  }
  for (const block of result) if (block.messages[0].info.kind === "shell" && block.messages.every(m => m.info.kind === "shell" || m.info.kind === "synthetic"))
    block.closed = summaryStart(block.messages)
  return result
}

export function serialize(messages: Envelope[]) {
  return messages.map((message) => [
    `[${message.info.role} ${message.info.id}]`,
    ...visibleParts(message).flatMap((part) => {
      if (part.type === "text") return [part.text]
      if (part.type === "reasoning") return [`[Visible reasoning]\n${part.text}`]
      if (part.type === "file") return [`[Attachment ${part.mime}: ${part.filename ?? part.id}]`]
      if (part.type === "context") return [`[${part.category} context]\n${part.text}`]
      if (part.type !== "tool") return []
      const output = toolText(part)
      return [
        `[Tool call ${part.callID}: ${part.tool}]\n${JSON.stringify(part.state.input)}`,
        `[Tool result]\n${output}`,
        ...(part.state.status === "completed" || part.state.status === "error" ? (part.state.attachments ?? []).map((a) => `[Attachment ${a.mime}: ${a.filename ?? a.id}]`) : []),
      ]
    }),
  ].join("\n")).join("\n\n")
}

export function blockMessages(blocks: Block[]) {
  return blocks.flatMap((b) => b.messages)
}

export function summaryStart(messages: Envelope[]) {
  const first = messages[0]?.info
  if (first?.role === "user") return true
  return first?.kind === "shell" && first.shell?.settled === true &&
    messages.every(m => m.info.kind !== "shell" || (m.info.role === "assistant" && m.info.shell?.settled === true)) &&
    (!first.shell.background || messages.some(m => m.info.kind === "synthetic" || m.info.role === "user"))
}

export function summaryRangeStart(blocks: Block[]) {
  const first = blocks.find(block => block.messages.length)
  return summaryStart(blockMessages(blocks)) || !!(first?.kind === "turn" && first.subturn)
}

export function splitOperation(block: Block, requested: number, basis: TokenBasis, limits: { minTokens: number; minSplitTokens: number }): { operation: Operation; parts: number } {
  if (block.kind !== "turn" || (!block.subturn && (block.messages[0]?.info.role !== "user" || block.messages[0].info.kind !== "user")))
    throw new Error("Select one ordinary original USER turn or subturn to split")
  const plan = planSubturns(block.messages, requested, basis, limits.minTokens, limits.minSplitTokens)
  return { operation: { ...operation("partition", [block], undefined, basis), cuts: plan.ends }, parts: plan.sizes.length }
}

export function validatePartition(op: Operation, blocks: Block[], basis: TokenBasis, limits: { minTokens: number; minSplitTokens: number }): void {
  if (op.mode !== "partition" || !op.cuts) throw new Error("Expected a structural partition operation")
  if (op.summary || op.rule || op.summaryIDs || op.targetID || op.pruneReason || op.checkpoint || op.pruneTargets || op.deletedIDs)
    throw new Error("Structural partitions cannot change content or restoration layers")
  const start = blocks.findIndex(block => block.sourceIDs[0] === op.sourceIDs[0])
  const end = blocks.findIndex(block => block.sourceIDs.at(-1) === op.sourceIDs.at(-1))
  if (start < 0 || end < start) throw new Error("Partition selection changed; refresh and select again")
  const selected = blocks.slice(start, end + 1)
  const messages = blockMessages(selected)
  if (!sameIDs(selected.flatMap(block => block.sourceIDs), op.sourceIDs) || historyHash(messages) !== op.beforeHash)
    throw new Error("Partition source content changed")
  if (hash(op.tokenizer) !== hash(basis) || op.beforeTokens !== contentTokens(messages, basis) || op.beforeChars !== chars(serialize(messages)))
    throw new Error("Partition must use the current main-session token basis and source size")
  if (!op.cuts.length) {
    const originID = selected[0]?.subturn?.originID
    if (selected.length < 2 || !originID || selected.some(block => block.kind !== "turn" || block.subturn?.originID !== originID))
      throw new Error("Select at least two ordinary sibling subturns to merge")
    return
  }
  const block = selected[0]
  if (selected.length !== 1 || block.kind !== "turn" || (!block.subturn && (messages[0]?.info.kind !== "user" || messages[0].info.role !== "user")))
    throw new Error("Select exactly one ordinary original USER turn or subturn to split")
  planSubturns(messages, op.cuts.length + 1, basis, limits.minTokens, limits.minSplitTokens)
  let from = 0
  for (const cut of op.cuts) {
    const index = messages.findIndex(message => message.info.id === cut)
    if (index < from || index >= messages.length - 1 || !terminalToolBatch(messages[index]))
      throw new Error("Subturn cuts require ordered completed native assistant tool batches")
    if (contentTokens(messages.slice(from, index + 1), basis) < limits.minTokens) throw new Error(`Each new subturn requires at least ${limits.minTokens} content tokens`)
    from = index + 1
  }
  if (contentTokens(messages.slice(from), basis) < limits.minTokens) throw new Error(`Each new subturn requires at least ${limits.minTokens} content tokens`)
}

export function select(blocks: Block[], start: number, end: number) {
  const low = Math.min(start, end)
  const high = Math.max(start, end)
  if (!Number.isInteger(low) || low < 0 || high >= blocks.length) throw new Error("Choose an inclusive start and end turn")
  return blocks.slice(low, high + 1)
}

export function operation(mode: Operation["mode"], selected: Block[], rule?: PruneRule, tokenizer: TokenBasis = FALLBACK_BASIS): Operation {
  const messages = blockMessages(selected)
  const summaryIDs = selected.flatMap((block) => block.summaryID ? [block.summaryID] : [])
  const deletedIDs = selected.flatMap((block) => block.deletionID ? [block.deletionID] : [])
  const pruneTargets = selected.flatMap(ordinaryLeaves).flatMap((block) => {
    const layer = block.kind === "turn" && block.pruning?.at(-1)
    return layer ? [{ operationID: layer.operationID, sourceIDs: [...block.sourceIDs] }] : []
  })
  return {
    id: randomUUID(), mode, sourceIDs: selected.flatMap((b) => b.sourceIDs),
    beforeHash: historyHash(messages), beforeChars: chars(serialize(messages)), beforeTokens: contentTokens(messages, tokenizer), tokenizer: { ...tokenizer }, created: Date.now(),
    ...(rule ? { rule } : {}),
    ...(mode === "expand" && summaryIDs.length ? { summaryIDs } : {}),
    ...(mode === "expand" && deletedIDs.length ? { deletedIDs } : {}),
    ...(mode === "expand" && pruneTargets.length ? { pruneTargets } : {}),
  }
}

export function summaryText(op: Operation, text = op.summary ?? "") {
  return `[Context manager ${op.mode} summary of ${op.sourceIDs.length} original messages]\n${text.trim()}\n[End summary]`
}

export function replacement(op: Operation, selected: Block[]): Block {
  const messages = blockMessages(selected)
  const first = messages[0]
  const last = messages.at(-1)!
  if (!summaryRangeStart(selected)) throw new Error("Summary range must start with a visible user message, settled shell input or verified subturn")
  const continuation = !summaryStart(messages)
  const user: Envelope = first.info.role === "user" ? first : {
    info: { id: continuation ? `msg_cm_${op.id}_user` : first.info.id, sessionID: first.info.sessionID, kind: "user", role: "user", agent: first.info.agent, time: first.info.time, model: { providerID: first.info.providerID, modelID: first.info.modelID } }, parts: [],
  }
  const assistant: Envelope = {
    info: last.info.role === "assistant"
      ? { ...last.info, ...(continuation ? { id: `msg_cm_${op.id}_assistant` } : last.info.id === user.info.id ? { id: `msg_cm_${op.id}` } : {}), error: undefined, finish: "stop", time: { ...last.info.time, completed: last.info.time.completed ?? op.created } }
      : {
        id: `msg_cm_${op.id}`, sessionID: last.info.sessionID, role: "assistant", kind: "assistant",
        providerID: last.info.model.providerID, modelID: last.info.model.modelID,
        agent: last.info.agent,
        time: { created: op.created, completed: op.created }, finish: "stop",
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    parts: [],
  }
  const part = (message: Envelope, text: string): Part => ({
    id: `prt_cm_${op.id}_${message.info.role}`, sessionID: message.info.sessionID, messageID: message.info.id,
    type: "text", text, synthetic: true, metadata: { [KEY]: { mode: op.mode, operationID: op.id } },
  })
  return {
    kind: op.mode === "brief" ? "brief" : "compact", sourceIDs: op.sourceIDs, closed: true, summaryID: op.id,
    ...(sharedSubturn(selected) ? { subturn: sharedSubturn(selected) } : {}),
    messages: [
      { info: user.info, parts: [part(user, "Earlier conversation range, replaced with an approved summary:")] },
      { info: assistant.info, parts: [part(assistant, summaryText(op))] },
    ],
  }
}

export function replacementTokens(op: Operation, selected: Block[]) {
  return contentTokens(replacement(op, selected).messages, op.tokenizer)
}

export function project(active: Envelope[], policy: Policy, observe?: (op: Operation, selected: Block[]) => void, unavailable?: ReadonlySet<string>): Block[] {
  let blocks = turns(structuredClone(active))
  const origins = new Map(blocks.flatMap(block => block.messages[0]?.info.kind === "user" && block.messages[0].info.role === "user"
    ? block.sourceIDs.map(id => [id, block.sourceIDs[0]] as const) : []))
  const originals = new Map(active.map(message => [message.info.id, message]))
  const sourceIDs = new Set(active.map(message => message.info.id))
  for (const originID of policy.subturnOrigins ?? []) {
    if (origins.get(originID) !== originID) throw new Error("Saved subturn origin is not an original native USER turn")
    blocks = markSubturnOrigin(blocks, originID, origins)
  }
  for (const id of policy.turnEnds ?? []) {
    if (!sourceIDs.has(id)) throw new Error("Saved fork turn boundary no longer exists")
    blocks = splitAfter(blocks, id)
  }
  const pruned = new Map<string, string>()
  for (const op of policy.operations) {
    if (op.mode === "partition") {
      const start = blocks.findIndex(block => block.sourceIDs[0] === op.sourceIDs[0])
      const end = blocks.findIndex(block => block.sourceIDs.includes(op.sourceIDs.at(-1)!))
      if (start < 0 || end < start) throw new Error("Saved partition range no longer exists")
      const selected = blocks.slice(start, end + 1)
      const originID = origins.get(op.sourceIDs[0])
      if (!originID || selected.some(block => block.kind !== "turn" || block.sourceIDs.some(id => origins.get(id) !== originID)))
        throw new Error("Partition requires ordinary siblings from one original USER turn; expand summaries or deleted ranges first")
      const prefix = selected.map((block, index) => index === selected.length - 1
        ? sliceOrdinary(block, 0, block.sourceIDs.indexOf(op.sourceIDs.at(-1)!) + 1) : block)
      if (!sameIDs(prefix.flatMap(block => block.sourceIDs), op.sourceIDs) ||
          (historyHash(blockMessages(prefix)) !== op.beforeHash && !op.sourceIDs.some(id => unavailable?.has(id))))
        throw new Error("Saved range content changed. Restore the original host history before continuing.")
      if (!op.cuts || (!op.cuts.length && selected.length < 2)) throw new Error("Select at least two sibling subturns to merge")
      let previous = -1
      for (const cut of op.cuts) {
        const index = op.sourceIDs.indexOf(cut)
        if (index <= previous || index >= op.sourceIDs.length - 1) throw new Error("Partition cuts must be ordered internal source endpoints")
        previous = index
        const message = originals.get(cut)
        const missing = unavailable?.has(cut) && policy.sources?.some(source => source.id === cut)
        if (!missing && (!message || !terminalToolBatch(message)))
          throw new Error("Subturn cuts require a completed native assistant tool batch")
      }
      observe?.(op, prefix)
      const merged = joinOrdinary(selected, { originID })
      const cuts = [...op.cuts.map(id => merged.sourceIDs.indexOf(id) + 1), merged.sourceIDs.length]
      let from = 0
      const partitioned = cuts.map((to, index) => {
        const block = sliceOrdinary(merged, from, to)
        from = to
        return { ...block, closed: index < cuts.length - 1 || block.closed, subturn: { originID } }
      })
      blocks.splice(start, selected.length, ...partitioned)
      blocks = markSubturnOrigin(blocks, originID, origins)
      continue
    }
    const last = op.sourceIDs.at(-1)!
    if (blocks.some(block => block.kind === "turn" && block.sourceIDs.includes(last))) blocks = splitAfter(blocks, last)
    const start = blocks.findIndex((b) => b.sourceIDs[0] === op.sourceIDs[0])
    const end = blocks.findIndex((b) => b.sourceIDs.at(-1) === op.sourceIDs.at(-1))
    if (start < 0 || end < start) throw new Error("Saved range no longer exists. Restore the original host history before continuing.")
    const selected = blocks.slice(start, end + 1)
    const selectedMessages = blockMessages(selected)
    if (!sameIDs(selected.flatMap((b) => b.sourceIDs), op.sourceIDs) ||
        (historyHash(selectedMessages) !== op.beforeHash && !op.sourceIDs.some((id) => unavailable?.has(id))))
      throw new Error("Saved range content changed. Restore the original host history before continuing.")
    observe?.(op, selected)
    if (op.mode === "revise") {
      const block = selected[0]
      if (selected.length !== 1 || (block.kind !== "compact" && block.kind !== "brief") || !block.summaryID || block.summaryID !== op.targetID)
        throw new Error("Summary revision target is no longer visible")
      blocks[start] = { ...block, messages: replacement({ ...op, id: block.summaryID, mode: block.kind }, selected).messages }
      continue
    }
    if (op.mode === "delete") {
      if (selected.every((block) => block.kind === "deleted")) throw new Error("Selected range is already deleted")
      blocks.splice(start, selected.length, {
        kind: "deleted", sourceIDs: [...op.sourceIDs], messages: [], closed: true, deletionID: op.id,
        ...(sharedSubturn(selected) ? { subturn: sharedSubturn(selected) } : {}),
        previous: withPruning(selected, pruned),
      })
      continue
    }
    if (["tool-prune", "tool-prune-all", "tool-delete", "prune-reason"].includes(op.mode)) {
      for (const b of selected.flatMap(ordinaryLeaves)) {
        const before: PruningLayer["before"] = {
          messages: b.messages, pruned: withPruning([b], pruned)[0].pruned,
          ...(b.reasonPruned !== undefined ? { reasonPruned: b.reasonPruned } : {}),
          ...(b.toolsDeleted !== undefined ? { toolsDeleted: b.toolsDeleted } : {}),
          ...(b.allToolsPruned !== undefined ? { allToolsPruned: b.allToolsPruned } : {}),
        }
        let changed = false
        if (op.pruneReason || op.mode === "prune-reason") {
          changed ||= !b.reasonPruned
          b.reasonPruned = true
        }
        if (op.mode === "tool-delete") {
          changed ||= !b.toolsDeleted || !!b.allToolsPruned
          b.toolsDeleted = true
          delete b.allToolsPruned
        }
        if (op.mode === "tool-prune-all" && !b.toolsDeleted) {
          changed ||= !b.allToolsPruned
          b.allToolsPruned = true
        }
        b.messages = b.messages.map((message) => {
          const parts = message.parts.flatMap((part): Part[] => {
            if (part.type === "reasoning" && (op.pruneReason || op.mode === "prune-reason") &&
                !(message.info.role === "assistant" && message.info.retainReasoning)) return []
            if (part.type !== "tool") return [part]
            if (op.mode === "tool-delete") { pruned.delete(part.id); return [] }
            if (pruned.get(part.id) === "all") return [part]
            if (op.mode === "tool-prune") return [prunePart(part, op.rule!, pruned)]
            if (op.mode !== "tool-prune-all" || (part.state.status !== "completed" && part.state.status !== "error")) return [part]
            const next = withToolText(part, TOOL_OUTPUT_PRUNED)
            if (next.state.status === "completed" || next.state.status === "error") next.state.attachments = []
            pruned.set(part.id, "all")
            return [next]
          })
          if (parts.length === message.parts.length && parts.every((part, index) => part === message.parts[index])) return message
          changed = true
          return { ...message, parts }
        })
        if (changed) b.pruning = [...(b.pruning ?? []), { operationID: op.id, before }]
      }
      blocks.splice(start, selected.length, ...selected.map(refreshOrdinary))
      continue
    }
    if (op.mode === "expand") {
      const targets = new Set(op.summaryIDs)
      const deletions = new Set(op.deletedIDs)
      const pruneTargets = op.pruneTargets ?? []
      if ((!targets.size && !pruneTargets.length && !deletions.size) || selected.filter((block) => block.summaryID && targets.has(block.summaryID)).length !== targets.size)
        throw new Error("Selected summary is no longer available for expansion")
      if (selected.filter((block) => block.kind === "deleted" && block.deletionID && deletions.has(block.deletionID)).length !== deletions.size)
        throw new Error("Selected deletion is no longer available for expansion")
      if (new Set(pruneTargets.flatMap((target) => target.sourceIDs)).size !== pruneTargets.reduce((sum, target) => sum + target.sourceIDs.length, 0) ||
          pruneTargets.some((target) => !selected.flatMap(ordinaryLeaves).some((block) => block.pruning?.at(-1)?.operationID === target.operationID && sameIDs(block.sourceIDs, target.sourceIDs))))
        throw new Error("Selected pruning layer is no longer available for restoration")
      const expanded = selected.flatMap((block) => {
        if (block.kind === "turn") {
          const restored = ordinaryLeaves(block).map(leaf => {
            if (!pruneTargets.some(target => sameIDs(target.sourceIDs, leaf.sourceIDs))) return leaf
            const layer = leaf.pruning!.at(-1)!
            const { pruning: _pruning, reasonPruned: _reason, toolsDeleted: _tools, allToolsPruned: _all, ...current } = leaf
            const messages = layer.before.messages.filter(message => leaf.sourceIDs.includes(message.info.id))
            if (!sameIDs(messages.map(message => message.info.id), leaf.sourceIDs)) throw new Error("Pruning restoration source changed")
            const earlier = leaf.pruning!.slice(0, -1)
            const restored: Block = { ...current, ...layer.before, messages, ...(earlier.length ? { pruning: earlier } : {}) }
            restorePruning([restored], pruned)
            return restored
          })
          return [block.segments ? { ...joinOrdinary(restored, block.subturn), closed: block.closed } : restored[0]]
        }
        if (!(block.summaryID && targets.has(block.summaryID)) && !(block.deletionID && deletions.has(block.deletionID))) return [block]
        if (!block.previous) throw new Error("Selected range has no pre-compaction state")
        const previous = block.previous.map((item) => ({ ...item }))
        restorePruning(previous, pruned)
        return previous
      })
      blocks.splice(start, selected.length, ...expanded)
      continue
    }
    const summary = replacement(op, selected)
    summary.previous = withPruning(selected, pruned)
    blocks.splice(start, selected.length, summary)
  }
  return withPruning(blocks, pruned)
}

function withPruning(blocks: Block[], pruned: Map<string, string>): Block[] {
  return blocks.map((block) => ({
    ...block,
    ...(block.segments ? { segments: withPruning(block.segments, pruned) } : {}),
    pruned: Object.fromEntries(block.messages.flatMap((message) => message.parts.flatMap((part) =>
      part.type === "tool" && pruned.has(part.id) ? [[part.id, pruned.get(part.id)!]] : []))),
  }))
}

function restorePruning(blocks: Block[], pruned: Map<string, string>) {
  for (const block of blocks) {
    for (const message of block.messages) for (const part of message.parts) {
      if (part.type !== "tool") continue
      pruned.delete(part.id)
      if (block.pruned && Object.hasOwn(block.pruned, part.id)) pruned.set(part.id, block.pruned[part.id])
    }
    if (block.previous) restorePruning(block.previous, pruned)
    if (block.segments) restorePruning(block.segments, pruned)
  }
}

function prunePart(part: ToolPart, rule: PruneRule, pruned: Map<string, string>) {
  if (part.state.status !== "completed" && part.state.status !== "error") return part
  const signature = hash(rule)
  if (pruned.get(part.id) === signature) return part
  const outputPath = typeof part.state.metadata?.outputPath === "string" ? part.state.metadata.outputPath : undefined
  const original = toolText(part)
  const text = pruneText(original, rule, outputPath)
  if (text === original) return part
  pruned.set(part.id, signature)
  return withToolText(part, text)
}

function withToolText(part: ToolPart, text: string): ToolPart {
  if (part.state.status === "completed") return { ...part, state: { ...part.state, output: text } }
  if (part.state.status === "error") return { ...part, state: {
    ...part.state, error: text,
    ...(typeof part.state.metadata?.output === "string" ? { metadata: { ...part.state.metadata, output: text } } : {}),
  } }
  return part
}

export function splitAfter(blocks: Block[], id: string): Block[] {
  return blocks.flatMap((block) => {
    const index = block.sourceIDs.indexOf(id)
    if (index < 0 || index === block.sourceIDs.length - 1) return [block]
    if (block.kind !== "turn") throw new Error("Cannot split a saved summary or deleted range")
    const cut = index + 1
    return [
      sliceOrdinary(block, 0, cut),
      sliceOrdinary(block, cut),
    ]
  })
}

function ordinaryLeaves(block: Block): Block[] {
  return block.kind !== "turn" ? [] : block.segments?.flatMap(ordinaryLeaves) ?? [block]
}

function sharedSubturn(blocks: Block[]) {
  const subturn = blocks[0]?.subturn
  return subturn && blocks.every(block => block.subturn?.originID === subturn.originID) ? subturn : undefined
}

function markSubturnOrigin(blocks: Block[], originID: string, origins: ReadonlyMap<string, string>): Block[] {
  return blocks.map(block => ({
    ...block,
    ...(block.sourceIDs.length && block.sourceIDs.every(id => origins.get(id) === originID) ? { subturn: { originID } } : {}),
    ...(block.previous ? { previous: markSubturnOrigin(block.previous, originID, origins) } : {}),
    ...(block.segments ? { segments: markSubturnOrigin(block.segments, originID, origins) } : {}),
  }))
}

function terminalToolBatch(message: Envelope) {
  const tools = message.parts.filter(part => part.type === "tool")
  return message.info.kind === "assistant" && message.info.role === "assistant" && message.info.time.completed !== undefined &&
    tools.length > 0 && tools.every(part => part.state.status === "completed" || part.state.status === "error")
}

function joinOrdinary(blocks: Block[], subturn = blocks[0]?.subturn): Block {
  const segments = blocks.flatMap(ordinaryLeaves)
  if (segments.length === 1) return { ...segments[0], ...(subturn ? { subturn } : {}) }
  const pruning = segments.flatMap(segment => segment.pruning ?? [])
  return {
    kind: "turn", sourceIDs: segments.flatMap(segment => segment.sourceIDs), messages: blockMessages(segments), closed: blocks.at(-1)!.closed,
    segments, ...(subturn ? { subturn } : {}), ...(pruning.length ? { pruning } : {}),
    pruned: Object.assign({}, ...segments.map(segment => segment.pruned)),
    ...(segments.every(segment => segment.reasonPruned) ? { reasonPruned: true } : {}),
    ...(segments.every(segment => segment.toolsDeleted) ? { toolsDeleted: true } : {}),
    ...(segments.every(segment => segment.allToolsPruned) ? { allToolsPruned: true } : {}),
  }
}

function refreshOrdinary(block: Block): Block {
  return block.segments ? { ...joinOrdinary(block.segments, block.subturn), closed: block.closed } : block
}

function sliceOrdinary(block: Block, start: number, end = block.sourceIDs.length): Block {
  const sourceIDs = block.sourceIDs.slice(start, end)
  const ids = new Set(sourceIDs)
  if (block.segments) {
    const segments = block.segments.flatMap(segment => {
      const from = segment.sourceIDs.findIndex(id => ids.has(id))
      if (from < 0) return []
      return [sliceOrdinary(segment, from, segment.sourceIDs.findLastIndex(id => ids.has(id)) + 1)]
    })
    return { ...joinOrdinary(segments, block.subturn), closed: end === block.sourceIDs.length ? block.closed : segmentClosed(block.messages.filter(message => ids.has(message.info.id)), block.subturn) }
  }
  const messages = block.messages.filter(message => ids.has(message.info.id))
  const pruneState = (state: PruningLayer["before"]): PruningLayer["before"] => {
    const messages = state.messages.filter(message => ids.has(message.info.id))
    const parts = new Set(messages.flatMap(message => message.parts.map(part => part.id)))
    return { ...state, messages, ...(state.pruned ? { pruned: Object.fromEntries(Object.entries(state.pruned).filter(([id]) => parts.has(id))) } : {}) }
  }
  return {
    ...block, ...pruneState(block), sourceIDs, messages,
    closed: end === block.sourceIDs.length ? block.closed : segmentClosed(messages, block.subturn),
    ...(block.pruning ? { pruning: block.pruning.map(layer => ({ ...layer, before: pruneState(layer.before) })) } : {}),
  }
}

function segmentClosed(messages: Envelope[], subturn?: Block["subturn"]) {
  return !!subturn && !!messages.length && terminalToolBatch(messages.at(-1)!) || turns(messages)[0]?.closed === true
}

export const TOOL_OUTPUT_PRUNED = "[Tool output pruned]"
