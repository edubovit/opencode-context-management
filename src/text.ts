import type { Settings } from "./config.ts"
import type { ToolPart } from "./model.ts"
import { TOKENIZER_ID, tokenCount, tokenEdges, type Encoding, type TokenBasis } from "./tokens.ts"

export type PruneRule = { threshold: number; head: number; tail: number; unit: "tokens"; encoding: Encoding; library: typeof TOKENIZER_ID }

export function bindPruneRule(rule: Settings["prune"], basis: TokenBasis): PruneRule {
  return { ...rule, unit: "tokens", encoding: basis.encoding, library: basis.library }
}

export function chars(value: string) {
  return Array.from(value).length
}

export function pruneText(value: string, rule: PruneRule, outputPath?: string) {
  if (rule.unit !== "tokens" || rule.library !== TOKENIZER_ID) throw new Error("Saved token pruning rule is unsupported")
  const original = tokenCount(value, rule.encoding)
  if (original <= rule.threshold) return value
  const ends = tokenEdges(value, rule.head, rule.tail, rule.encoding)
  if (!ends.separated) return value
  const result = [
    ends.head,
    `[Context manager: middle omitted from tool output; original ${original} tokens (${rule.encoding}).]`,
    ends.tail,
    outputPath ? `[Full output: ${outputPath}]` : "",
  ].filter(Boolean).join("\n\n")
  return tokenCount(result, rule.encoding) < original ? result : value
}

export function toolText(part: ToolPart) {
  if (part.state.status === "completed") return part.state.output
  if (part.state.status === "error") return part.state.error
  return `[${part.state.status}]`
}

export function spills(value: string, limits: Settings["spill"]) {
  return value.split("\n").length > limits.maxLines || Buffer.byteLength(value, "utf8") > limits.maxBytes
}

export function spillPreview(value: string, limits: Settings["spill"], outputPath: string) {
  const headLines = Math.floor(limits.maxLines * limits.headShare)
  const headBytes = Math.floor(limits.maxBytes * limits.headShare)
  const head = endBudget(value, headLines, headBytes, false)
  const tail = endBudget(value, limits.maxLines - headLines, limits.maxBytes - headBytes, true)
  return [
    head,
    `[Context manager: middle omitted; full output has ${chars(value)} characters.]`,
    tail,
    `[Full output: ${outputPath}]`,
  ].filter(Boolean).join("\n\n")
}

function endBudget(value: string, lines: number, bytes: number, tail: boolean) {
  if (lines === 0 || bytes === 0) return ""
  const selected = tail ? value.split("\n").slice(-lines).join("\n") : value.split("\n").slice(0, lines).join("\n")
  const points = Array.from(selected)
  const result: string[] = []
  let used = 0
  for (const point of tail ? points.reverse() : points) {
    const size = Buffer.byteLength(point, "utf8")
    if (used + size > bytes) break
    result.push(point)
    used += size
  }
  return (tail ? result.reverse() : result).join("")
}
