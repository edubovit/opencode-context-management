import { createHash, randomUUID } from "node:crypto"
import type { Message, Part, Session, ToolPart } from "./model.ts"
import { KEY } from "./config.ts"
import { chars, pruneText, toolText, type PruneRule } from "./text.ts"
import { contentTokens } from "./metrics.ts"
import { FALLBACK_BASIS, isEncoding, TOKENIZER_ID, type TokenBasis } from "./tokens.ts"
export { toolText } from "./text.ts"

export type Envelope = { info: Message; parts: Part[] }
export type Mode = "tool-prune" | "tool-prune-all" | "tool-delete" | "prune-reason" | "compact" | "brief"
export type RestoreMode = "expand"
export type Block = {
  kind: "turn" | "compact" | "brief"
  sourceIDs: string[]
  messages: Envelope[]
  closed: boolean
  pruned?: Record<string, string>
  reasonPruned?: boolean
  toolsDeleted?: boolean
  allToolsPruned?: boolean
  summaryID?: string
  previous?: Block[]
}
export type Operation = {
  id: string
  mode: Mode | RestoreMode | "revise" | "unprune"
  sourceIDs: string[]
  beforeHash: string
  beforeChars: number
  beforeTokens?: number
  tokenizer?: TokenBasis
  created: number
  summary?: string
  rule?: PruneRule
  summaryIDs?: string[]
  targetID?: string
  pruneReason?: true
  checkpoint?: true
}
export type Policy = { version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; sessionID: string; revision: number; cursor: number; operations: Operation[] }

export function emptyPolicy(sessionID: string): Policy {
  return { version: 7, sessionID, revision: 0, cursor: 0, operations: [] }
}

export function readPolicy(session: Pick<Session, "id" | "metadata" | "nativeVersion">): Policy {
  const value = session.metadata?.[KEY]
  if (value === undefined) return emptyPolicy(session.id)
  if (!value || typeof value !== "object") throw new Error("Invalid context-manager state")
  const policy = value as Policy
  if (session.nativeVersion === 2 && (![7, 8].includes(policy.version) || policy.sessionID !== session.id))
    throw new Error("This session has a V1 or inherited context-manager ledger. Its original data is preserved. Use the V1 checkout to export it; automatic V2 migration is unsafe.")
  if (policy.sessionID !== session.id) return emptyPolicy(session.id)
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(policy.version) || !Array.isArray(policy.operations) || !Number.isSafeInteger(policy.revision) || policy.revision < 0 ||
      !Number.isInteger(policy.cursor) || policy.cursor < 0 || policy.cursor > policy.operations.length)
    throw new Error("Unsupported or damaged context-manager state")
  const ids = new Set<string>()
  for (const op of policy.operations) {
    if (!op || typeof op.id !== "string" || !["tool-prune", "tool-prune-all", "tool-delete", "prune-reason", "compact", "brief", "unprune", "expand", "revise"].includes(op.mode) || !Array.isArray(op.sourceIDs) ||
        !op.sourceIDs.length || !op.sourceIDs.every((id) => typeof id === "string") || typeof op.beforeHash !== "string")
      throw new Error("Invalid context-manager operation")
    if (policy.version >= 7 && (ids.has(op.id) || new Set(op.sourceIDs).size !== op.sourceIDs.length || !Number.isSafeInteger(op.created) || op.created < 0 || !Number.isSafeInteger(op.beforeChars) || op.beforeChars < 0))
      throw new Error("Invalid operation identity or accounting")
    if (op.checkpoint !== undefined && (policy.version < 8 || op.checkpoint !== true || op.mode !== "compact")) throw new Error("Invalid last-resort checkpoint")
    ids.add(op.id)
    if ((["tool-prune-all", "tool-delete", "prune-reason"].includes(op.mode) || op.pruneReason !== undefined) && policy.version < 6)
      throw new Error("Pruning modes require policy version 6")
    if (op.pruneReason !== undefined && (op.pruneReason !== true || !["tool-prune", "tool-prune-all", "tool-delete"].includes(op.mode)))
      throw new Error("Invalid reasoning pruning combination")
    if (op.mode === "tool-delete" && op.pruneReason !== true) throw new Error("Deleting tools requires pruning reasoning")
    if (op.mode === "tool-prune" && (!op.rule || ![op.rule.threshold, op.rule.head, op.rule.tail].every(Number.isSafeInteger)))
      throw new Error("Invalid saved pruning rule")
    if (op.rule && op.rule.unit !== undefined && op.rule.unit !== "tokens") throw new Error("Unknown saved pruning units")
    if (op.rule?.unit === "tokens" && (policy.version < 3 || !isEncoding(op.rule.encoding) || op.rule.library !== TOKENIZER_ID ||
        op.rule.threshold < 1 || op.rule.head < 0 || op.rule.tail < 0 || op.rule.head + op.rule.tail >= op.rule.threshold))
      throw new Error("Unsupported or invalid saved token pruning rule")
    if ((op.tokenizer !== undefined || op.beforeTokens !== undefined) &&
        (!op.tokenizer || !isEncoding(op.tokenizer.encoding) || op.tokenizer.library !== TOKENIZER_ID || !Number.isSafeInteger(op.beforeTokens) || op.beforeTokens! < 0))
      throw new Error("Unsupported saved token accounting")
    if ((op.mode === "compact" || op.mode === "brief") && (typeof op.summary !== "string" || !op.summary.trim())) throw new Error("Missing saved summary")
    if (op.mode === "revise" && (policy.version < 4 || typeof op.targetID !== "string" || typeof op.summary !== "string" || !op.summary.trim()))
      throw new Error("Invalid saved summary revision")
    if (policy.version === 1 && (op.mode === "unprune" || op.mode === "expand")) throw new Error("Restore actions require policy version 2")
    if (op.mode === "expand" && (!Array.isArray(op.summaryIDs) || !op.summaryIDs.length || !op.summaryIDs.every((id) => typeof id === "string")))
      throw new Error("Missing summary expansion targets")
  }
  return policy
}

export function hash(value: unknown) {
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
  return createHash("sha256").update(canonical ?? "null").digest("hex")
}

export function historyHash(messages: Envelope[]) {
  return hash(messages.map(({ info, parts }) => ({ id: info.id, role: info.role, parts, ...(info.sourceHash ? { sourceHash: info.sourceHash } : {}) })))
}

export function nativeActive(messages: Envelope[], revert?: Session["revert"]) {
  let visible = structuredClone(messages).filter((message) => !["idle", "system", "model-switched", "agent-switched", "location-switched"].includes(message.info.kind ?? ""))
  if (revert) {
    const index = visible.findIndex((m) => m.info.id === revert.messageID)
    if (index >= 0) {
      const last = visible[index]
      const partIndex = last.parts.findIndex((p) => p.id === revert.partID)
      visible = visible.slice(0, index)
      if (partIndex > 0) visible.push({ ...last, parts: last.parts.slice(0, partIndex) })
    }
  }
  const summaryIndex = visible.findLastIndex((m) => m.info.role === "assistant" && m.info.summary && m.info.finish && !m.info.error)
  const summary = visible[summaryIndex]
  if (summary?.info.role === "assistant") {
    const parentID = summary.info.parentID
    const start = visible.findIndex((m) => m.info.id === parentID)
    const marker = visible[start]?.parts.find((p) => p.type === "compaction")
    if (marker?.type === "compaction") {
      const tail = visible.findIndex((m) => m.info.id === marker.tail_start_id)
      visible = [
        ...visible.slice(start, summaryIndex + 1),
        ...(tail >= 0 && tail < start ? visible.slice(tail, start) : []),
        ...visible.slice(summaryIndex + 1),
      ]
    }
  }
  for (const m of visible) for (const p of m.parts) {
    if (p.type === "tool" && p.state.status === "completed" && p.state.time.compacted) {
      p.state.output = "[Old tool result content cleared]"
      p.state.attachments = []
    }
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
    const last = block.messages.findLast((message) => !message.info.kind || ["user", "assistant"].includes(message.info.kind))?.info ?? block.messages.at(-1)!.info
    block.closed = block.messages[0].info.role === "user" && last.role === "assistant" &&
      !!last.time.completed && !!last.finish && !["tool-calls", "unknown"].includes(last.finish) &&
      !block.messages.some((m) => m.parts.some((p) => p.type === "tool" && ["pending", "running"].includes(p.state.status)))
  }
  return result
}

export function serialize(messages: Envelope[]) {
  return messages.map((message) => [
    `[${message.info.role} ${message.info.id}]`,
    ...message.parts.flatMap((part) => {
      if (part.type === "text") return part.ignored ? [] : [part.text]
      if (part.type === "reasoning") return [`[Visible reasoning]\n${part.text}`]
      if (part.type === "file") return [`[Attachment ${part.mime}: ${part.filename ?? part.id}]`]
      if (part.type === "compaction") return ["[Native compaction checkpoint]"]
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

export function select(blocks: Block[], start: number, end: number) {
  const low = Math.min(start, end)
  const high = Math.max(start, end)
  if (!Number.isInteger(low) || low < 0 || high >= blocks.length) throw new Error("Choose an inclusive start and end turn")
  return blocks.slice(low, high + 1)
}

export function operation(mode: Operation["mode"], selected: Block[], rule?: PruneRule, tokenizer: TokenBasis = FALLBACK_BASIS): Operation {
  const messages = blockMessages(selected)
  return {
    id: randomUUID(), mode, sourceIDs: selected.flatMap((b) => b.sourceIDs),
    beforeHash: historyHash(messages), beforeChars: chars(serialize(messages)), beforeTokens: contentTokens(messages, tokenizer), tokenizer: { ...tokenizer }, created: Date.now(),
    rule,
    ...(mode === "expand" ? { summaryIDs: selected.flatMap((block) => block.summaryID ? [block.summaryID] : []) } : {}),
  }
}

export function summaryText(op: Operation, text = op.summary ?? "") {
  return `[Context manager ${op.mode} summary of ${op.sourceIDs.length} original messages]\n${text.trim()}\n[End summary]`
}

export function replacement(op: Operation, selected: Block[]): Block {
  const first = selected[0].messages[0]
  const last = selected.at(-1)!.messages.at(-1)!
  if (first.info.role !== "user") throw new Error("Summary range must start with a user message")
  const assistant: Envelope = {
    info: last.info.role === "assistant"
      ? { ...last.info, summary: false, error: undefined, finish: "stop", time: { ...last.info.time, completed: last.info.time.completed ?? op.created } }
      : {
        id: `msg_cm_${op.id}`, sessionID: last.info.sessionID, role: "assistant", parentID: first.info.id,
        providerID: last.info.model.providerID, modelID: last.info.model.modelID,
        agent: last.info.agent, mode: last.info.agent, path: { cwd: "", root: "" },
        time: { created: op.created, completed: op.created }, finish: "stop", summary: false,
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
    messages: [
      { info: first.info, parts: [part(first, "Earlier conversation range, replaced with an approved summary:")] },
      { info: assistant.info, parts: [part(assistant, summaryText(op))] },
    ],
  }
}

export function replacementChars(op: Operation, selected: Block[]) {
  return chars(serialize(replacement(op, selected).messages))
}

export function replacementTokens(op: Operation, selected: Block[]) {
  return contentTokens(replacement(op, selected).messages, op.tokenizer ?? FALLBACK_BASIS)
}

export function project(active: Envelope[], policy: Policy, observe?: (op: Operation, selected: Block[]) => void): Block[] {
  let blocks = turns(structuredClone(active))
  const pruned = new Map<string, string>()
  const originals = new Map(active.flatMap((message) => message.parts.flatMap((part) => part.type === "tool" ? [[part.id, part] as const] : [])))
  for (const op of policy.operations.slice(0, policy.cursor)) {
    if (op.checkpoint) blocks = splitAfter(blocks, op.sourceIDs.at(-1)!)
    const start = blocks.findIndex((b) => b.sourceIDs[0] === op.sourceIDs[0])
    const end = blocks.findIndex((b) => b.sourceIDs.at(-1) === op.sourceIDs.at(-1))
    if (start < 0 || end < start) throw new Error("Saved range no longer exists. Restore the original host history before continuing.")
    const selected = blocks.slice(start, end + 1)
    const selectedMessages = blockMessages(selected)
    if (hash(selected.flatMap((b) => b.sourceIDs)) !== hash(op.sourceIDs) ||
        (historyHash(selectedMessages) !== op.beforeHash && (pruned.size === 0 || legacyPrunedHash(selectedMessages, pruned) !== op.beforeHash)))
      throw new Error("Saved range content changed. Restore the original host history before continuing.")
    observe?.(op, selected)
    if (op.mode === "revise") {
      const block = selected[0]
      if (selected.length !== 1 || block.kind === "turn" || !block.summaryID || block.summaryID !== op.targetID)
        throw new Error("Summary revision target is no longer visible")
      blocks[start] = { ...block, messages: replacement({ ...op, id: block.summaryID, mode: block.kind }, selected).messages }
      continue
    }
    if (["tool-prune", "tool-prune-all", "tool-delete", "prune-reason"].includes(op.mode)) {
      for (const b of selected) {
        if (b.kind !== "turn") continue
        if (op.pruneReason || op.mode === "prune-reason") {
          for (const m of b.messages) m.parts = m.parts.filter((p) => p.type !== "reasoning")
          b.reasonPruned = true
        }
        if (op.mode === "tool-delete") {
          for (const m of b.messages) m.parts = m.parts.filter((p) => {
            if (p.type !== "tool") return true
            pruned.delete(p.id)
            return false
          })
          b.toolsDeleted = true
          delete b.allToolsPruned
        }
        if (op.mode === "tool-prune-all") {
          for (const m of b.messages) for (const p of m.parts) {
            if (p.type !== "tool" || (p.state.status !== "completed" && p.state.status !== "error")) continue
            setToolText(p, TOOL_OUTPUT_PRUNED)
            p.state.attachments = []
            if (p.state.status === "error") p.state.error = TOOL_OUTPUT_PRUNED
            pruned.set(p.id, "all")
          }
          if (!b.toolsDeleted) b.allToolsPruned = true
        }
        if (op.mode === "tool-prune") for (const m of b.messages) for (const p of m.parts) {
          if (p.type === "tool" && pruned.get(p.id) !== "all") prunePart(p, op.rule!, pruned)
        }
      }
      continue
    }
    if (op.mode === "unprune") {
      for (const message of selectedMessages) for (const part of message.parts) {
        if (part.type !== "tool" || !pruned.has(part.id)) continue
        const original = originals.get(part.id)
        if (!original) throw new Error("Original tool result unavailable for restoration")
        setToolText(part, toolText(original))
        pruned.delete(part.id)
      }
      continue
    }
    if (op.mode === "expand") {
      const targets = new Set(op.summaryIDs)
      if (!targets.size || selected.filter((block) => block.summaryID && targets.has(block.summaryID)).length !== targets.size)
        throw new Error("Selected summary is no longer available for expansion")
      const expanded = selected.flatMap((block) => {
        if (!block.summaryID || !targets.has(block.summaryID)) return [block]
        if (!block.previous) throw new Error("Summary has no pre-compaction state")
        const previous = structuredClone(block.previous)
        restorePruning(previous, pruned)
        return previous
      })
      blocks.splice(start, selected.length, ...expanded)
      continue
    }
    const summary = replacement(op, selected)
    summary.previous = structuredClone(withPruning(selected, pruned))
    blocks.splice(start, selected.length, summary)
  }
  return withPruning(blocks, pruned)
}

function withPruning(blocks: Block[], pruned: Map<string, string>): Block[] {
  return blocks.map((block) => ({
    ...block,
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
  }
}

function prunePart(part: ToolPart, rule: PruneRule, pruned: Map<string, string>) {
  if (part.state.status !== "completed" && part.state.status !== "error") return
  const signature = hash(rule)
  if (pruned.get(part.id) === signature) return
  const outputPath = typeof part.state.metadata?.outputPath === "string" ? part.state.metadata.outputPath : undefined
  const original = toolText(part)
  const text = pruneText(original, rule, outputPath)
  if (text === original) return
  setToolText(part, text)
  pruned.set(part.id, signature)
}

function setToolText(part: ToolPart, text: string) {
  if (part.state.status === "completed") part.state.output = text
  else if (part.state.status === "error") {
    if (part.nativeVersion === 2) {
      part.state.error = text
      if (typeof part.state.metadata?.output === "string") part.state.metadata.output = text
      return
    }
    if (part.state.metadata?.interrupted === true && typeof part.state.metadata.output === "string") part.state.metadata.output = text
    else part.state.error = text
  }
}

function legacyPrunedHash(messages: Envelope[], pruned: Map<string, string>) {
  return historyHash(messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => part.type === "tool" && pruned.has(part.id)
      ? { ...part, metadata: { ...part.metadata, [KEY]: pruned.get(part.id)! } }
      : part),
  })))
}

export function append(policy: Policy, op: Operation): Policy {
  return { ...policy, version: op.checkpoint || policy.version === 8 ? 8 : 7, revision: policy.revision + 1, cursor: policy.cursor + 1, operations: [...policy.operations.slice(0, policy.cursor), op] }
}

export function splitAfter(blocks: Block[], id: string): Block[] {
  return blocks.flatMap((block) => {
    const index = block.sourceIDs.indexOf(id)
    if (index < 0 || index === block.sourceIDs.length - 1) return [block]
    if (block.kind !== "turn") throw new Error("Cannot split a saved summary")
    const cut = index + 1
    return [
      { ...block, sourceIDs: block.sourceIDs.slice(0, cut), messages: block.messages.slice(0, cut), closed: false },
      { ...block, sourceIDs: block.sourceIDs.slice(cut), messages: block.messages.slice(cut) },
    ]
  })
}

export const TOOL_OUTPUT_PRUNED = "[Tool output pruned]"
