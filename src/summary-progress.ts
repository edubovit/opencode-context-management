import type { Envelope } from "./model.ts"
import { chars } from "./text.ts"

export type SummaryProgress = { output: number; reasoning: number; requests: number }

export function summaryProgress(messages: readonly Envelope[]): SummaryProgress {
  let output = 0, reasoning = 0, requests = 0
  for (const message of messages) {
    if (message.info.role === "user") requests++
    else for (const part of message.parts) {
      if (part.type === "text") output += chars(part.text)
      if (part.type === "reasoning") reasoning += chars(part.text)
    }
  }
  return { output, reasoning, requests }
}
