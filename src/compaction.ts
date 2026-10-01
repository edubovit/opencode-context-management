export type ToolPruning = "large" | "all" | "delete"
export type Pruning = { reasoning: boolean; tools?: ToolPruning }
export type Compaction = ({ kind: "prune" } & Pruning) | { kind: "summary"; mode: "compact" | "brief" }

export const COMPACTION_MODES = [
  { name: "Prune reasoning", description: "Remove reasoning; keep prompts, calls and visible responses" },
  { name: "Prune tools (large)", description: "Keep configured head/tail for large results" },
  { name: "Prune tools (all)", description: "Replace every result, including attachments, with a marker" },
  { name: "Prune tools (delete)", description: "Remove entire calls and results; requires reasoning removal" },
  { name: "Summarize (detailed)", description: "Model-written detailed summary; applies automatically" },
  { name: "Summarize (brief)", description: "Model-written brief summary; applies automatically" },
] as const

export function selectedModes(value: Compaction): number[] {
  if (value.kind === "summary") return [value.mode === "compact" ? 4 : 5]
  return [...(value.reasoning ? [0] : []), ...(value.tools ? [{ large: 1, all: 2, delete: 3 }[value.tools]] : [])]
}

export function toggleMode(value: Compaction, index: number): Compaction {
  if (index === 4 || index === 5) return { kind: "summary", mode: index === 4 ? "compact" : "brief" }
  const current: Pruning = value.kind === "prune" ? value : { reasoning: false }
  if (index === 0) return { kind: "prune", ...current, reasoning: current.tools === "delete" || !current.reasoning }
  const tools = (["large", "all", "delete"] as const)[index - 1]
  if (!tools) throw new Error("Unknown compaction mode")
  return { kind: "prune", reasoning: current.reasoning || tools === "delete", tools: current.tools === tools ? undefined : tools }
}

export function validatePruning(value: Pruning) {
  if (typeof value.reasoning !== "boolean" || (value.tools !== undefined && !["large", "all", "delete"].includes(value.tools)))
    throw new Error("Invalid pruning configuration")
  if (!value.reasoning && !value.tools) throw new Error("Select at least one compaction mode")
  if (value.tools === "delete" && !value.reasoning) throw new Error("Deleting tools requires pruning reasoning")
}
