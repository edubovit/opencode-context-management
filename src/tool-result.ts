import type { ToolResultPart } from "@opencode/ai"
import type { SessionMessageInfo } from "@opencode/client"
import { pruneText, type PruneRule } from "./text.ts"
import { TOOL_OUTPUT_PRUNED } from "./context.ts"

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { type: "tool" }>

export function pruneResult(part: ToolResultPart, mode: "large" | "all", rule: PruneRule | undefined, tool: Tool): ToolResultPart {
  if (mode === "all") return {
    ...part, metadata: undefined, providerMetadata: undefined,
    result: part.result.type === "error"
      ? { type: "error", value: { error: { type: "tool.execution", message: TOOL_OUTPUT_PRUNED }, content: [] } }
      : { type: "text", value: TOOL_OUTPUT_PRUNED },
  }
  const outputPath = tool.state.status !== "streaming" && typeof tool.state.metadata?.outputPath === "string" ? tool.state.metadata.outputPath : undefined
  const prune = (text: string) => pruneText(text, rule!, outputPath)
  if (part.result.type === "text" && typeof part.result.value === "string") {
    const value = prune(part.result.value)
    return value === part.result.value ? part : { ...part, result: { type: "text", value } }
  }
  if (part.result.type === "content") {
    const original = part.result.value.filter((item) => item.type === "text").map((item) => item.text).join("\n\n")
    const value = prune(original)
    return value === original ? part : { ...part, result: { type: "content", value: [{ type: "text", text: value }, ...part.result.value.filter((item) => item.type !== "text")] } }
  }
  if (part.result.type === "error") {
    const value = part.result.value
    if (!record(value) || !record(value.error) || typeof value.error.message !== "string" || !Array.isArray(value.content) ||
        !value.content.every((item: unknown) => record(item) && (item.type === "text" ? typeof item.text === "string" : item.type === "file" && typeof item.uri === "string" && typeof item.mime === "string")))
      throw new Error("Unsupported error-result shape; refusing to reconstruct it from stored history")
    const content: Record<string, unknown>[] = value.content
    const original = [value.error.message, ...content.flatMap((item) => item.type === "text" ? [String(item.text)] : [])].join("\n\n")
    const text = prune(original)
    if (text === original) return part
    return { ...part, result: { type: "error", value: { ...value, error: { ...value.error, message: text }, content: content.filter((item) => item.type !== "text") } } }
  }
  throw new Error("Unsupported tool-result shape; refusing lossy conversion")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
