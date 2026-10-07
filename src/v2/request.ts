import { Message, type ContentPart, type ToolResultPart } from "@opencode/ai"
import type { SessionMessageInfo } from "@opencode/client"
import { validatePruning, type Pruning } from "../compaction.ts"
import { pruneText, type PruneRule } from "../text.ts"
import { fingerprint, type Transcript } from "./history.ts"

export type RequestPruning = {
  sourceIDs: readonly string[]
  fingerprint: string
  modes: Pruning
  rule?: PruneRule
  protectedIDs?: ReadonlySet<string>
}

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { type: "tool" }>
const marker = "[Tool output pruned]"

export function pruneRequest(transcript: Transcript, messages: readonly Message[], input: RequestPruning): Message[] {
  validatePruning(input.modes)
  if (input.fingerprint !== fingerprint(transcript)) throw new Error("Session source changed before request projection")
  if (!input.sourceIDs.length || new Set(input.sourceIDs).size !== input.sourceIDs.length) throw new Error("Invalid pruning selection")
  if (input.modes.tools === "large" && !input.rule) throw new Error("Large-output pruning requires a saved rule")
  if (transcript.some((message) => message.type === "compaction" && message.status === "completed") || messages.some((message) => message.content.some((part) => part.type === "compaction")))
    throw new Error("Native checkpoints are not supported by the V2 request adapter yet")
  const source = new Map(transcript.map((message) => [message.id, message]))
  if (source.size !== transcript.length) throw new Error("Duplicate transcript message identity")
  const selected = new Set(input.sourceIDs)
  for (const id of selected) {
    if (!source.has(id)) throw new Error("Selected message no longer exists")
    if (input.protectedIDs?.has(id)) throw new Error("The active execution turn is protected")
  }
  const tools = new Map<string, { owner: string; tool: Tool }>()
  for (const message of transcript) {
    if (message.type !== "assistant") continue
    if (selected.has(message.id) && input.modes.reasoning && message.error && message.content.some((part) => part.type === "reasoning"))
      throw new Error("Failed-assistant reasoning can become visible text; refusing ambiguous reasoning removal")
    for (const tool of message.content) {
      if (tool.type !== "tool") continue
      if (tools.has(tool.id)) throw new Error("Ambiguous tool call identity in transcript")
      tools.set(tool.id, { owner: message.id, tool })
    }
  }
  const seenMessages = new Set<string>()
  const calls = new Set<string>()
  const results = new Set<string>()
  const output = messages.flatMap((message) => {
    if (message.id) {
      if (seenMessages.has(message.id)) throw new Error("Duplicate request message identity")
      seenMessages.add(message.id)
    }
    if (message.id && selected.has(message.id) && (message.native || message.providerMetadata))
      throw new Error("Cannot safely prune a message with opaque message-level provider state")
    if (message.id && selected.has(message.id)) {
      const original = source.get(message.id)!
      if ((original.type === "assistant" && message.role !== "assistant") || (original.type === "user" && message.role !== "user"))
        throw new Error("Request role does not match selected transcript message")
    }
    const content = message.content.flatMap((part): ContentPart[] => {
      if (part.type === "reasoning" && message.id && selected.has(message.id) && input.modes.reasoning) {
        if (source.get(message.id)?.type !== "assistant" || message.role !== "assistant") throw new Error("Reasoning owner does not match transcript")
        return []
      }
      if (part.type !== "tool-call" && part.type !== "tool-result") return [part]
      const owner = tools.get(part.id)
      if (!owner && message.id && selected.has(message.id)) throw new Error("Unexpected tool in selected request message")
      if (!owner || !selected.has(owner.owner)) return [part]
      if (message.native || message.providerMetadata) throw new Error("Cannot safely prune a tool wrapper with opaque message-level provider state")
      if (owner.tool.name !== part.name || (message.id && message.id !== owner.owner)) throw new Error("Tool identity does not match transcript")
      const seen = part.type === "tool-call" ? calls : results
      if (seen.has(part.id)) throw new Error("Duplicate selected tool call or result")
      seen.add(part.id)
      if (input.modes.tools === "delete") return []
      if (part.type !== "tool-result" || !input.modes.tools) return [part]
      if (part.providerExecuted) throw new Error("Provider-executed result pruning needs provider-specific validation")
      if (owner.tool.state.status !== "completed" && owner.tool.state.status !== "error") throw new Error("Unsettled tool has an unexpected saved result")
      return [pruneResult(part, input.modes.tools, input.rule, owner.tool)]
    })
    if (content.length === message.content.length && content.every((part, index) => part === message.content[index])) return [message]
    if (content.length === 0 && (message.role === "assistant" || message.role === "tool")) return []
    return [Message.make({ ...message, content })]
  })
  for (const id of selected) {
    const message = source.get(id)!
    if ((message.type === "user" && (message.text || message.files?.length || message.skills?.length)) || (message.type === "assistant" && message.content.some((part) => part.type !== "text" || part.text))) {
      if (!seenMessages.has(id)) throw new Error("Selected transcript message is absent from model context")
    }
  }
  for (const [id, { owner, tool }] of tools) {
    if (!selected.has(owner)) continue
    if (!calls.has(id)) throw new Error("Selected tool call is absent from model context")
    if ((tool.state.status === "completed" || tool.state.status === "error") && !results.has(id)) throw new Error("Selected tool result is absent from model context")
  }
  return output
}

export function pruneResult(part: ToolResultPart, mode: "large" | "all", rule: PruneRule | undefined, tool: Tool): ToolResultPart {
  if (mode === "all") return {
    ...part,
    metadata: undefined,
    providerMetadata: undefined,
    result: part.result.type === "error"
      ? { type: "error", value: { error: { type: "tool.execution", message: marker }, content: [] } }
      : { type: "text", value: marker },
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
