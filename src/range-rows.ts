import type { Block, Policy } from "./context.ts"
import { messageText } from "./turn-view.ts"
import type { toolStatus } from "./status.ts"

export type RangeRow = { title: string; size: string; stats?: string; preview: string }

export function rangePreview(block: Block, policy: Policy) {
  return previewText(block, policy).replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim()).join("\n") || "[No text recorded]"
}

function previewText(block: Block, policy: Policy) {
  if (block.kind !== "turn") {
    const op = policy.operations.findLast((op) =>
      op.id === block.summaryID || (op.mode === "revise" && op.targetID === block.summaryID))
    return op?.summary ?? "[Summary text unavailable]"
  }
  const first = block.messages[0]
  return first?.info.role === "user" ? messageText(first) || "[No user text recorded]" : "[Native checkpoint / continuation]"
}

export function rangeToolStats(status: ReturnType<typeof toolStatus>) {
  return [
    status.noTools ? "Tools removed" : status.allPruned ? `${status.pruned} pruned` : `${status.total} tool${status.total === 1 ? "" : "s"}`,
    ...(!status.allPruned && status.pruned ? [`${status.pruned} pruned`] : []),
    ...(status.eligible ? [`${status.eligible} large`] : []),
    ...(status.fileBacked ? [`${status.fileBacked} file${status.fileBacked === 1 ? "" : "s"}`] : []),
    ...(status.pending ? [`${status.pending} pending`] : []),
    ...(status.noReason ? ["reasoning removed"] : []),
  ].join(" · ")
}
