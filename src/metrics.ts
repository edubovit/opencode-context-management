import type { Block, Envelope } from "./context.ts"
import type { RuntimeCapture } from "./storage.ts"
import { chars, toolText } from "./text.ts"
import { FALLBACK_BASIS, tokenCount, type TokenBasis } from "./tokens.ts"

export function distribution(blocks: Block[], runtime?: RuntimeCapture, basis: TokenBasis = FALLBACK_BASIS, unit: "tokens" | "characters" = "tokens") {
  const measure = (text: string) => unit === "tokens" ? tokenCount(text, basis.encoding) : chars(text)
  const counts: Record<string, number> = {
    user: 0, assistant: 0, summaries: 0, reasoning: 0, toolInputs: 0, toolOutputs: 0, loadedSkills: 0,
    systemPrompts: 0, advertisedSkills: 0, capturedToolDefinitions: 0,
  }
  let attachments = 0
  for (const block of blocks) for (const message of block.messages) for (const part of message.parts) {
    if (part.type === "text" && !part.ignored) counts[block.kind === "turn" ? message.info.role : "summaries"] += measure(part.text)
    if (part.type === "reasoning") counts.reasoning += measure(part.text)
    if (part.type === "file") attachments++
    if (part.type === "context") counts[part.category === "skill" ? "loadedSkills" : part.category === "system" ? "systemPrompts" : "assistant"] += measure(part.text)
    if (part.type !== "tool") continue
    counts.toolInputs += measure(JSON.stringify(part.state.input))
    if (part.state.status === "completed" || part.state.status === "error")
      counts[part.tool === "skill" ? "loadedSkills" : "toolOutputs"] += measure(toolText(part))
    if (part.state.status === "completed" || part.state.status === "error") attachments += part.state.attachments?.length ?? 0
  }
  for (const system of runtime?.system ?? []) {
    for (const segment of system.split(/(<available_skills>[\s\S]*?<\/available_skills>)/g))
      counts[segment.startsWith("<available_skills>") ? "advertisedSkills" : "systemPrompts"] += measure(segment)
  }
  let unknownToolSchemas = 0
  for (const tool of runtime?.tools ?? []) {
    const missing = !!tool.parameters && typeof tool.parameters === "object" && "unavailable" in tool.parameters
    if (missing) unknownToolSchemas++
    counts.capturedToolDefinitions += measure(tool.description) + (missing ? 0 : measure(JSON.stringify(tool.parameters) ?? ""))
  }
  const unavailableCategories = [
    ...(!runtime?.system ? ["systemPrompts", "advertisedSkills"] : []),
    ...(!runtime?.tools ? ["capturedToolDefinitions"] : []),
  ]
  return {
    counts, total: Object.values(counts).reduce((a, b) => a + b, 0), attachments, unknownToolSchemas, unavailableCategories,
    unit: unit === "tokens" ? "estimated content tokens" : "Unicode characters", tokenizer: unit === "tokens" ? basis : undefined,
    runtimeInventoryComplete: false, requestOverheadIncluded: false, providerOverheadTokens: null, attachmentTokens: attachments ? null : 0,
  }
}

export function contentTokens(messages: Envelope[], basis: TokenBasis = FALLBACK_BASIS) {
  return distribution([{ kind: "turn", sourceIDs: [], closed: false, messages }], undefined, basis).total
}

export function lastReportedUsage(raw: Envelope[]) {
  const message = raw.findLast((item) => item.info.role === "assistant" && item.info.tokens.output > 0)?.info
  if (!message || message.role !== "assistant") return undefined
  const tokens = message.tokens
  return {
    messageID: message.id, providerID: message.providerID, modelID: message.modelID,
    total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
    tokens, time: message.time.completed ?? message.time.created,
    meaning: "Last response usage; not a recount of the current projection",
  }
}
