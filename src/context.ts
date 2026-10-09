import { createHash, randomUUID } from "node:crypto"
import type { Message, Part, Session, ToolPart } from "./model.ts"
import { KEY } from "./config.ts"
import { chars, pruneText, toolText, type PruneRule } from "./text.ts"
import { contentTokens } from "./metrics.ts"
import { FALLBACK_BASIS, type TokenBasis } from "./tokens.ts"
import type { Operation, Policy } from "./ledger.ts"
export { append, emptyPolicy, readPolicy, POLICY_VERSION, type Mode, type Operation, type Policy, type RestoreMode } from "./ledger.ts"
export { toolText } from "./text.ts"

export type Envelope = { info: Message; parts: Part[] }
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

export function hash(value: unknown) {
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
  return createHash("sha256").update(canonical ?? "null").digest("hex")
}

export function historyHash(messages: Envelope[]) {
  return hash(messages.map(({ info, parts }) => ({
    id: info.id, role: info.role,
    parts: parts.map((part) => part.type === "tool" ? { ...part, nativeVersion: 2 } : part),
    ...(info.sourceHash ? { sourceHash: info.sourceHash } : {}),
  })))
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
  return result
}

export function serialize(messages: Envelope[]) {
  return messages.map((message) => [
    `[${message.info.role} ${message.info.id}]`,
    ...message.parts.flatMap((part) => {
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
    ...(rule ? { rule } : {}),
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
      ? { ...last.info, error: undefined, finish: "stop", time: { ...last.info.time, completed: last.info.time.completed ?? op.created } }
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
    messages: [
      { info: first.info, parts: [part(first, "Earlier conversation range, replaced with an approved summary:")] },
      { info: assistant.info, parts: [part(assistant, summaryText(op))] },
    ],
  }
}

export function replacementTokens(op: Operation, selected: Block[]) {
  return contentTokens(replacement(op, selected).messages, op.tokenizer)
}

export function project(active: Envelope[], policy: Policy, observe?: (op: Operation, selected: Block[]) => void): Block[] {
  let blocks = turns(structuredClone(active))
  const pruned = new Map<string, string>()
  for (const op of policy.operations) {
    if (op.checkpoint) blocks = splitAfter(blocks, op.sourceIDs.at(-1)!)
    const start = blocks.findIndex((b) => b.sourceIDs[0] === op.sourceIDs[0])
    const end = blocks.findIndex((b) => b.sourceIDs.at(-1) === op.sourceIDs.at(-1))
    if (start < 0 || end < start) throw new Error("Saved range no longer exists. Restore the original host history before continuing.")
    const selected = blocks.slice(start, end + 1)
    const selectedMessages = blockMessages(selected)
    if (hash(selected.flatMap((b) => b.sourceIDs)) !== hash(op.sourceIDs) ||
        historyHash(selectedMessages) !== op.beforeHash)
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
    part.state.error = text
    if (typeof part.state.metadata?.output === "string") part.state.metadata.output = text
  }
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
