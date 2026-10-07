import { Message, type ContentPart } from "@opencode/ai"
import type { SessionMessageInfo } from "@opencode/client"
import { hash, nativeActive, project, replacement, type Block, type Envelope, type Operation, type Policy } from "../context.ts"
import { pruneResult } from "./request.ts"
import { tokenCount, type TokenBasis } from "../tokens.ts"

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { type: "tool" }>
type Entry = { message: Message; sourceIDs: string[]; anchor: number; slot: number; summaryID?: string; rules: Map<string, string> }

export function projectRequest(native: readonly SessionMessageInfo[], raw: Envelope[], incoming: readonly Message[], policy: Policy): Message[] {
  if (!policy.cursor) return [...incoming]
  const active = nativeActive(raw)
  const selectable = new Set(active.map((message) => message.info.id))
  const originals = new Map(native.map((message) => [message.id, message]))
  const tools = new Map<string, Map<string, Tool>>()
  for (const message of native) if (message.type === "assistant") {
    const owned = new Map<string, Tool>()
    for (const part of message.content) if (part.type === "tool") {
      if (owned.has(part.id)) throw new Error("Duplicate tool identity inside one assistant message")
      owned.set(part.id, part)
    }
    tools.set(message.id, owned)
  }
  const calls = new Map<string, string | undefined>()
  const observed = new Set<string>()
  const seenCalls = new Set<string>()
  const seenResults = new Set<string>()
  let entries: Entry[] = incoming.map((message, anchor) => {
    let owner = message.id && selectable.has(message.id) ? message.id : undefined
    for (const part of message.content) if (part.type === "tool-call") {
      if (owner && tools.get(owner)?.get(part.id)?.name !== part.name) throw new Error("Model context contains an unexpected tool call")
      if (owner) {
        const key = `${owner}:${part.id}`
        if (seenCalls.has(key)) throw new Error("Duplicate selected tool call in model context")
        seenCalls.add(key)
      }
      calls.set(part.id, owner)
    }
    if (!message.id && message.role === "tool") {
      const resultOwners = new Set(message.content.flatMap((part) => part.type === "tool-result" && calls.get(part.id) ? [calls.get(part.id)!] : []))
      if (resultOwners.size > 1) throw new Error("Merged tool results have ambiguous source ownership")
      owner = [...resultOwners][0]
    }
    if (owner) for (const part of message.content) if (part.type === "tool-result") {
      if (tools.get(owner)?.get(part.id)?.name !== part.name) throw new Error("Tool result identity does not match its call")
      const key = `${owner}:${part.id}`
      if (seenResults.has(key)) throw new Error("Duplicate selected tool result in model context")
      seenResults.add(key)
    }
    if (owner) observed.add(owner)
    return { message, sourceIDs: owner ? [owner] : [], anchor, slot: 0, rules: new Map() }
  })
  const saved = new Map<string, Entry[]>()
  const selectedEntries = (ids: readonly string[]) => entries.filter((entry) => entry.sourceIDs.length && entry.sourceIDs.every((id) => ids.includes(id)))
  const replace = (op: Operation, selected: Block[], summaryID = op.id) => {
    const removed = selectedEntries(op.sourceIDs)
    if (!removed.length) throw new Error("Selected summary range is absent from model context")
    const anchor = Math.min(...removed.map((entry) => entry.anchor))
    const normalized = replacement({ ...op, id: summaryID }, selected)
    entries = entries.filter((entry) => !removed.includes(entry))
    entries.push(...normalized.messages.map((message, slot): Entry => ({
      message: Message.make({ id: message.info.id, role: message.info.role, content: message.parts.flatMap((part) => part.type === "text" ? [Message.text(part.text)] : []) }),
      sourceIDs: [...op.sourceIDs], anchor, slot, summaryID, rules: new Map(),
    })))
    return removed
  }
  project(active, policy, (op, selected) => {
    for (const block of selected) if (block.kind === "turn") {
      for (const message of block.messages) {
        if (!observed.has(message.info.id) && message.parts.some((part) => (part.type === "text" || part.type === "reasoning") ? !!part.text : part.type === "tool" || part.type === "file" || part.type === "context"))
          throw new Error("Saved source is absent from this model's context; refusing to resurrect or discard history")
        for (const [id, tool] of tools.get(message.info.id) ?? []) {
          const key = `${message.info.id}:${id}`
          if (!seenCalls.has(key) || (["completed", "error"].includes(tool.state.status) && !seenResults.has(key)))
            throw new Error("Saved tool call/result pair is absent from model context")
        }
      }
      if (block.messages.some((message) => message.info.kind === "compaction")) throw new Error("Native checkpoints cannot be edited as plugin turns")
    }
    if (op.mode === "compact" || op.mode === "brief") { saved.set(op.id, replace(op, selected)); return }
    if (op.mode === "revise") {
      const block = selected[0]
      replace({ ...op, mode: block.kind === "brief" ? "brief" : "compact" }, selected, block.summaryID)
      return
    }
    if (op.mode === "expand") {
      for (const id of op.summaryIDs ?? []) {
        const previous = saved.get(id)
        if (!previous || !entries.some((entry) => entry.summaryID === id)) throw new Error("Summary expansion layer unavailable")
        entries = entries.filter((entry) => entry.summaryID !== id)
        entries.push(...previous)
      }
      return
    }
    if (op.mode === "unprune") throw new Error("V1 unprune operations require the original V1 transcript")
    const ids = selected.filter((block) => block.kind === "turn").flatMap((block) => block.sourceIDs)
    const reason = op.pruneReason || op.mode === "prune-reason"
    const signature = op.mode === "tool-prune" ? hash(op.rule) : "all"
    entries = entries.flatMap((entry): Entry[] => {
      if (entry.summaryID || !entry.sourceIDs.some((id) => ids.includes(id))) return [entry]
      if (entry.message.native || entry.message.providerMetadata) throw new Error("Opaque message-level provider state cannot be safely edited")
      const owner = entry.sourceIDs[0]
      const original = originals.get(owner)
      if (reason && original?.type === "assistant" && original.error && original.content.some((part) => part.type === "reasoning"))
        throw new Error("Failed-assistant reasoning became visible text; refusing ambiguous removal")
      const rules = new Map(entry.rules)
      const content = entry.message.content.flatMap((part): ContentPart[] => {
        if (part.type === "reasoning" && reason) return []
        if (part.type !== "tool-call" && part.type !== "tool-result") return [part]
        const tool = tools.get(owner)?.get(part.id)
        if (!tool || tool.name !== part.name) throw new Error("Selected tool identity changed before projection")
        if (op.mode === "tool-delete") return []
        if (part.type !== "tool-result" || !["tool-prune", "tool-prune-all"].includes(op.mode)) return [part]
        if (rules.get(part.id) === "all" || rules.get(part.id) === signature) return [part]
        if (part.providerExecuted && part.providerMetadata) throw new Error("Opaque provider-executed tool results cannot be pruned safely; delete the complete call with reasoning instead")
        const next = pruneResult(part, op.mode === "tool-prune" ? "large" : "all", op.rule, tool)
        if (next !== part) rules.set(part.id, signature)
        return [next]
      })
      if (!content.length && ["assistant", "tool"].includes(entry.message.role)) return []
      if (content.length === entry.message.content.length && content.every((part, index) => part === entry.message.content[index])) return [entry]
      return [{ ...entry, rules, message: Message.make({ ...entry.message, content }) }]
    })
  })
  return entries.sort((a, b) => a.anchor - b.anchor || a.slot - b.slot).map((entry) => entry.message)
}

export function validateNativePolicy(native: readonly SessionMessageInfo[], raw: Envelope[], policy: Policy) {
  const source = new Map(native.map((message) => [message.id, message]))
  project(nativeActive(raw), policy, (op, selected) => {
    for (const block of selected) {
      if (block.kind !== "turn") continue
      for (const id of block.sourceIDs) {
        const message = source.get(id)
        if (message?.type === "compaction") throw new Error("Native checkpoints are read-only; select later USER turns")
        if (message?.type !== "assistant") continue
        if (message.content.some((part) => part.type === "tool" && ["streaming", "running"].includes(part.state.status)))
          throw new Error("The host must settle unfinished tool calls before editing this historical turn")
        if ((op.pruneReason || op.mode === "prune-reason") && message.error && message.content.some((part) => part.type === "reasoning"))
          throw new Error("Failed-assistant reasoning cannot be removed safely; summarize the range instead")
        if (["tool-prune", "tool-prune-all"].includes(op.mode) && message.content.some((part) => part.type === "tool" && part.executed && (part.providerResultState || part.providerState)))
          throw new Error("Opaque provider-executed results cannot be pruned; summarize or delete the complete calls with reasoning")
      }
    }
  })
}

export function requestTokens(messages: readonly Message[], system: readonly { text: string }[], tools: Record<string, unknown>, basis: TokenBasis) {
  return tokenCount(system.map((part) => part.text).join("\n\n"), basis.encoding) + tokenCount(JSON.stringify(tools), basis.encoding) + messages.reduce((total, message) => total + message.content.reduce((sum, part) => {
    if (part.type === "text" || part.type === "reasoning") return sum + tokenCount(part.text, basis.encoding)
    if (part.type === "tool-call") return sum + tokenCount(JSON.stringify(part.input) ?? "", basis.encoding)
    if (part.type === "tool-result") return sum + tokenCount(JSON.stringify(part.result), basis.encoding)
    return sum
  }, 0), 0)
}
