import type { ContentPart, Message } from "@opencode/ai"
import type { SessionMessageInfo } from "@opencode/client"
import { z } from "zod"
import { hash } from "./context.ts"
import { tokenCount, type TokenBasis } from "./tokens.ts"

const count = z.number().int().nonnegative()
const unitSchema = z.object({ key: z.string(), tokens: count })
const prefixSchema = z.object({ length: count, hash: z.string() })
const modelSchema = z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
const anchorSchema = z.object({
  reportID: z.string(), prefix: prefixSchema, policy: z.string(), units: z.array(unitSchema),
  input: count, output: count, inputLocal: count, matched: z.boolean(),
})
export const budgetStateSchema = z.object({
  version: z.literal(1), scope: z.string(), excludedReports: z.array(z.string()).optional(),
  pending: z.object({ prefix: prefixSchema, policy: z.string(), units: z.array(unitSchema) }).optional(),
  anchor: anchorSchema.optional(),
})
export type BudgetState = z.infer<typeof budgetStateSchema>
export type BudgetUnit = z.infer<typeof unitSchema>
export type BudgetReading = {
  tokens: number; local: number; source: "provider-matched" | "provider-unpaired" | "local-fallback"
  multiplier: number; added: number; removed: number
  reported?: { messageID: string; input: number; output: number }
}
export type BudgetIdentity = { scope: string; model: z.infer<typeof modelSchema>; agent: string }
type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>

function unit(kind: string, id: string, value: unknown, text: string, basis: TokenBasis): BudgetUnit {
  return { key: hash([kind, id, value]), tokens: tokenCount(text, basis.encoding) }
}

function partUnit(part: ContentPart, id: string, basis: TokenBasis): BudgetUnit {
  if (part.type === "text" || part.type === "reasoning") return unit(part.type, id, part.text, part.text, basis)
  if (part.type === "tool-call") return unit(part.type, id, { id: part.id, name: part.name, input: part.input }, JSON.stringify(part.input) ?? "", basis)
  if (part.type === "tool-result") return unit(part.type, id, { id: part.id, name: part.name, result: part.result }, JSON.stringify(part.result), basis)
  if (part.type === "compaction") return unit(part.type, id, part, part.text ?? "", basis)
  const tokens = part.type === "media" ? part.media.mediaType.startsWith("image/") ? 1500 : part.media.mediaType === "application/pdf" ? 2000 : 0 : 0
  return { key: hash([part.type, id, part]), tokens }
}

export function budgetUnits(messages: readonly Message[], system: readonly { text: string }[], tools: Record<string, unknown>, basis: TokenBasis): BudgetUnit[] {
  return [
    unit("system", "", system.map((part) => part.text), system.map((part) => part.text).join("\n\n"), basis),
    unit("tools", "", tools, JSON.stringify(tools), basis),
    ...messages.flatMap((message) => message.content.map((part) => partUnit(part, message.id ?? "", basis))),
  ]
}

export function localTokens(units: readonly BudgetUnit[]) { return units.reduce((sum, item) => sum + item.tokens, 0) }

export function budgetScope(identity: Omit<BudgetIdentity, "scope">, basis: TokenBasis, configuration: unknown) {
  return hash({ model: { ...identity.model, variant: identity.model.variant ?? "default" }, agent: identity.agent, tokenizer: { encoding: basis.encoding, library: basis.library }, configuration })
}

function prefix(native: readonly SessionMessageInfo[]) { return { length: native.length, hash: hash(native) } }
function matches(saved: z.infer<typeof prefixSchema>, native: readonly SessionMessageInfo[]) {
  return saved.length <= native.length && saved.hash === hash(native.slice(0, saved.length))
}

function reported(message: Assistant, identity: BudgetIdentity) {
  if (message.error || message.time.completed === undefined || !message.tokens || message.agent !== identity.agent ||
      message.model.providerID !== identity.model.providerID || message.model.id !== identity.model.id ||
      (message.model.variant ?? "default") !== (identity.model.variant ?? "default")) return
  const values = [message.tokens.input, message.tokens.cache.read, message.tokens.cache.write, message.tokens.output, message.tokens.reasoning]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return
  const input = values[0] + values[1] + values[2]
  const output = values[3] + values[4]
  if (!input || !Number.isSafeInteger(input + output)) return
  return { input, output }
}

function outputUnits(message: Assistant, basis: TokenBasis) {
  return message.content.map((part) => {
    if (part.type !== "tool") return unit(part.type, message.id, part.text, part.text, basis)
    const input = part.state.input
    return unit("tool-call", message.id, { id: part.id, name: part.name, input }, JSON.stringify(input) ?? "", basis)
  })
}

export function prepareBudget(identity: BudgetIdentity, native: readonly SessionMessageInfo[], current: readonly Message[], system: readonly { text: string }[], tools: Record<string, unknown>, basis: TokenBasis, policy: string, saved?: BudgetState, bootstrap?: (response: Assistant) => { messages: readonly Message[]; policy: string }): BudgetState {
  const changedScope = saved !== undefined && saved.scope !== identity.scope
  const state: BudgetState = changedScope ? { version: 1, scope: identity.scope, excludedReports: native.filter((message) => message.type === "assistant").map((message) => message.id) } : saved ? structuredClone(saved) : { version: 1, scope: identity.scope }
  const boundary = native.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  if (state.anchor) {
    const index = native.findIndex((message) => message.id === state.anchor!.reportID)
    const report = native[index]
    if (index <= boundary || report?.type !== "assistant" || !reported(report, identity) || !matches(state.anchor.prefix, native)) delete state.anchor
  }
  const excluded = new Set(state.excludedReports)
  const index = native.findLastIndex((message, index) => index > boundary && !excluded.has(message.id) && message.type === "assistant" && reported(message, identity) !== undefined)
  const response = native[index]
  if (response?.type !== "assistant" || changedScope) { delete state.pending; return state }
  if (state.anchor?.reportID === response.id) return state
  const usage = reported(response, identity)!
  const pending = state.pending
  const paired = pending && matches(pending.prefix, native) && pending.prefix.length === index
  if (paired) {
    state.anchor = { reportID: response.id, prefix: prefix(native.slice(0, index + 1)), policy: pending.policy, units: [...pending.units, ...outputUnits(response, basis)], ...usage, inputLocal: localTokens(pending.units), matched: true }
  } else {
    const reference = bootstrap?.(response)
    const before = new Set(native.slice(0, index + 1).map((message) => message.id))
    const resultIDs = new Set(native.slice(index).flatMap((message) => message.type === "assistant" ? message.content.flatMap((part) => part.type === "tool" ? [part.id] : []) : []))
    const earlierTools = new Set(native.slice(0, index).flatMap((message) => message.type === "assistant" ? message.content.flatMap((part) => part.type === "tool" ? [part.id] : []) : []))
    const baseline = (reference?.messages ?? current).filter((message) => message.role !== "system" && (message.id ? before.has(message.id) : message.role === "tool" && message.content.every((part) => part.type === "tool-result" && earlierTools.has(part.id))))
      .map((message) => ({ ...message, content: message.content.filter((part) => part.type !== "tool-result" || !resultIDs.has(part.id)) }))
    const units = budgetUnits(baseline, system, tools, basis)
    state.anchor = { reportID: response.id, prefix: prefix(native.slice(0, index + 1)), policy: reference?.policy ?? policy, units, ...usage, inputLocal: Math.max(1, localTokens(units) - localTokens(outputUnits(response, basis))), matched: false }
  }
  delete state.pending
  return state
}

export function recordRequest(state: BudgetState, native: readonly SessionMessageInfo[], units: BudgetUnit[], policy: string): BudgetState {
  return { ...state, pending: { prefix: prefix(native), policy, units } }
}

export function estimateBudget(current: readonly BudgetUnit[], state: BudgetState, fallbackMultiplier: number): BudgetReading {
  if (!Number.isFinite(fallbackMultiplier) || fallbackMultiplier < 1) throw new Error("Invalid budget estimate multiplier")
  const local = localTokens(current)
  const anchor = state.anchor
  if (!anchor) {
    const tokens = Math.ceil(local * fallbackMultiplier)
    if (!Number.isSafeInteger(tokens)) throw new Error("Local fallback budget is outside supported numeric bounds")
    return { tokens, local, source: "local-fallback", multiplier: fallbackMultiplier, added: local, removed: 0 }
  }
  const remaining = new Map<string, { tokens: number; count: number }>()
  for (const item of anchor.units) {
    const previous = remaining.get(item.key)
    remaining.set(item.key, { tokens: item.tokens, count: (previous?.count ?? 0) + 1 })
  }
  let added = 0
  for (const item of current) {
    const previous = remaining.get(item.key)
    if (previous?.count && previous.tokens === item.tokens) previous.count--
    else added += item.tokens
  }
  const removed = [...remaining.values()].reduce((sum, item) => sum + item.tokens * item.count, 0)
  const multiplier = Math.max(fallbackMultiplier, anchor.input / Math.max(1, anchor.inputLocal))
  const tokens = Math.ceil(Math.max(local, anchor.input + anchor.output + added * multiplier - removed))
  if (!Number.isSafeInteger(tokens)) throw new Error("Provider budget is outside supported numeric bounds")
  return { tokens, local, source: anchor.matched ? "provider-matched" : "provider-unpaired", multiplier, added, removed, reported: { messageID: anchor.reportID, input: anchor.input, output: anchor.output } }
}
