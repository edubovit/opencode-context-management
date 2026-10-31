import type { Envelope } from "./model.ts"
import { tokenCount, type TokenBasis } from "./tokens.ts"

export type SummaryProgress = { output: number; reasoning: number; requests: number }
type Kind = "text" | "reasoning"
type ProgressPart = { type: Kind; text: string; tokenizer: TokenBasis; complete: boolean }
export type ProgressParts = Map<string, ProgressPart>
const partKey = (messageID: string, type: Kind, ordinal: number) => `${messageID}:${type}:${ordinal}`

export function updateProgress(parts: ProgressParts, messageID: string, type: Kind, ordinal: number, text: string, tokenizer: TokenBasis, complete = false) {
  const key = partKey(messageID, type, ordinal)
  const previous = parts.get(key)
  if (previous?.complete && !complete) return
  parts.set(key, { type, text: complete ? text : (previous?.text ?? "") + text, tokenizer: previous?.tokenizer ?? tokenizer, complete })
}

export function summaryProgress(messages: readonly Envelope[], basis: TokenBasis | ((message: Envelope) => TokenBasis), live?: ReadonlyMap<string, ProgressPart>): SummaryProgress {
  const parts = new Map(live)
  let requests = 0
  for (const message of messages) {
    if (message.info.role === "user") requests++
    else {
      const ordinals = { text: 0, reasoning: 0 }
      const tokenizer = typeof basis === "function" ? basis(message) : basis
      for (const part of message.parts) {
        if (part.type !== "text" && part.type !== "reasoning") continue
        const key = partKey(message.info.id, part.type, ordinals[part.type]++)
        if (part.text || message.info.time.completed !== undefined || !parts.has(key))
          parts.set(key, { type: part.type, text: part.text, tokenizer, complete: true })
      }
    }
  }
  let output = 0, reasoning = 0
  for (const part of parts.values()) {
    const count = tokenCount(part.text, part.tokenizer.encoding, part.tokenizer.library)
    if (part.type === "text") output += count
    else reasoning += count
  }
  return { output, reasoning, requests }
}
