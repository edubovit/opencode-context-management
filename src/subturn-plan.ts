import { contentTokens } from "./metrics.ts"
import type { Envelope } from "./model.ts"
import type { TokenBasis } from "./tokens.ts"

export function planSubturns(messages: Envelope[], requested: number, basis: TokenBasis, minimum: number, minimumSource: number): { ends: string[]; sizes: number[] } {
  if (!Number.isSafeInteger(requested) || requested < 2) throw new Error("Requested subturn count must be a safe integer of at least 2")
  if (!Number.isSafeInteger(minimum) || minimum < 1) throw new Error("Minimum subturn tokens must be a positive safe integer")
  if (!Number.isSafeInteger(minimumSource) || minimumSource < 1) throw new Error("Minimum split source tokens must be a positive safe integer")

  const prefix = [0]
  const boundaries: number[] = []
  for (const [index, message] of messages.entries()) {
    const { info, parts } = message
    if (info.kind === "compaction") throw new Error("Cannot split a source containing a native checkpoint or compaction")
    if (info.kind === "shell" && (info.role !== "assistant" || info.shell?.settled !== true))
      throw new Error("Cannot split a source containing an unsettled shell")
    const tools = parts.filter(part => part.type === "tool")
    if (tools.some(part => part.state.status !== "completed" && part.state.status !== "error"))
      throw new Error("Cannot split a source containing pending or running tool calls")
    prefix.push(prefix[index] + contentTokens([message], basis))
    if (index < messages.length - 1 && info.kind === "assistant" && info.role === "assistant" && info.time.completed !== undefined && tools.length)
      boundaries.push(index + 1)
  }

  const total = prefix[messages.length]
  if (total < minimumSource) throw new Error(`Split source has ${total} content tokens; at least ${minimumSource} are required`)

  const latest: number[] = []
  let end = total
  for (let index = boundaries.length - 1; index >= 0; index--) {
    const tokens = prefix[boundaries[index]]
    if (tokens < minimum) break
    if (end - tokens < minimum) continue
    latest.push(index)
    end = tokens
  }

  const count = Math.min(requested, latest.length + 1)
  if (count < 2) throw new Error(`Cannot split into two subturns of at least ${minimum} content tokens at completed native tool-batch boundaries`)

  const ends: string[] = []
  const sizes: number[] = []
  let previous = 0
  let boundary = 0
  for (let remaining = count; remaining > 1; remaining--) {
    const limit = latest[remaining - 2]
    while (prefix[boundaries[boundary]] - previous < minimum) boundary++
    const target = previous + (total - previous) / remaining
    while (boundary < limit && Math.abs(prefix[boundaries[boundary + 1]] - target) <= Math.abs(prefix[boundaries[boundary]] - target)) boundary++
    const cut = boundaries[boundary++]
    ends.push(messages[cut - 1].info.id)
    sizes.push(prefix[cut] - previous)
    previous = prefix[cut]
  }
  sizes.push(total - previous)
  return { ends, sizes }
}
