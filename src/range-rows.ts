import type { Block, Policy } from "./context.ts"
import { messageText } from "./turn-view.ts"
import type { toolStatus } from "./status.ts"

export type RangeRow = { title: string; stats?: string; preview: string }

export function rangePreview(block: Block, policy: Policy) {
  return previewText(block, policy).replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim()).join("\n") || "[No text recorded]"
}

function previewText(block: Block, policy: Policy) {
  if (block.kind !== "turn") {
    const op = policy.operations.slice(0, policy.cursor).findLast((op) =>
      op.id === block.summaryID || (op.mode === "revise" && op.targetID === block.summaryID))
    return op?.summary ?? "[Summary text unavailable]"
  }
  const first = block.messages[0]
  return first?.info.role === "user" ? messageText(first) || "[No user text recorded]" : "[Native checkpoint / continuation]"
}

export function rangeToolStats(status: ReturnType<typeof toolStatus>) {
  return [
    `tools:${status.total}`,
    ...(status.pruned ? [`pruned:${status.pruned}`] : []),
    ...(status.eligible ? [`eligible:${status.eligible}`] : []),
    ...(status.fileBacked ? [`files:${status.fileBacked}`] : []),
    ...(status.pending ? [`pending:${status.pending}`] : []),
    ...(status.nativeCleared ? [`native-cleared:${status.nativeCleared}`] : []),
  ].join(" · ")
}
