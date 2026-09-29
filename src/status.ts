import { hash, toolText, turns, type Block, type Envelope, type Operation } from "./context.ts"
import { chars, pruneText, type PruneRule } from "./text.ts"
import { FALLBACK_BASIS, tokenCount, type TokenBasis } from "./tokens.ts"

export function toolStatus(blocks: Block[], rule: PruneRule, basis: TokenBasis = FALLBACK_BASIS) {
  const result = { total: 0, pruned: 0, eligible: 0, pending: 0, fileBacked: 0, nativeCleared: 0, summaries: 0, pruneDelta: 0, pruneCharDelta: 0 }
  const signature = hash(rule)
  for (const block of blocks) {
    if (block.summaryID) result.summaries++
    for (const message of block.messages) for (const part of message.parts) {
      if (part.type !== "tool") continue
      result.total++
      const prior = block.pruned && Object.hasOwn(block.pruned, part.id) ? block.pruned[part.id] : undefined
      if (prior) result.pruned++
      if (part.state.status === "pending" || part.state.status === "running") { result.pending++; continue }
      const outputPath = typeof part.state.metadata?.outputPath === "string" ? part.state.metadata.outputPath : undefined
      if (outputPath) result.fileBacked++
      if (part.state.status === "completed" && part.state.time.compacted) result.nativeCleared++
      const before = toolText(part)
      const after = prior === signature ? before : pruneText(before, rule, outputPath)
      if (before !== after) {
        result.eligible++
        result.pruneDelta += tokenCount(after, basis.encoding) - tokenCount(before, basis.encoding)
        result.pruneCharDelta += chars(after) - chars(before)
      }
    }
  }
  return result
}

export function turnIndex(active: Envelope[]) {
  return new Map(turns(active).flatMap((block, index) => block.sourceIDs.map((id) => [id, index + 1] as const)))
}

export function rangeLabel(sourceIDs: string[], index: ReadonlyMap<string, number>) {
  const numbers = sourceIDs.flatMap((id) => index.has(id) ? [index.get(id)!] : [])
  if (!numbers.length) return `${sourceIDs.length} messages`
  const first = Math.min(...numbers)
  const last = Math.max(...numbers)
  return first === last ? `Turn ${first}` : `Turns ${first}–${last}`
}

export function operationLabel(op: Operation | undefined, index: ReadonlyMap<string, number>) {
  if (!op) return "nothing"
  const name = op.mode === "expand" ? "expand summaries" : op.mode === "revise" ? "edit summary" : op.mode
  return `${name}: ${rangeLabel(op.sourceIDs, index)}`
}
