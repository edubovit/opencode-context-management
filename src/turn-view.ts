import type { Block, Envelope } from "./context.ts"

export function messageText(message: Envelope) {
  return message.parts.flatMap((part) => {
    if (part.type === "text") return [part.text]
    if (part.type === "file") return [`[Attachment: ${part.filename ?? part.id} (${part.mime})]`]
    return []
  }).join("\n\n")
}

export function turnView(block: Block) {
  if (block.kind !== "turn") throw new Error("Use the summary reader for compacted blocks")
  const first = block.messages[0]
  const last = block.messages.findLast((message) => ["user", "assistant"].includes(message.info.kind))
  const user = first?.info.role === "user" ? messageText(first) || "[No user text recorded.]" : first?.info.kind === "assistant" ? "[Continuation after a saved range boundary; see preceding context for the user request.]" : "[No user message in this turn.]"
  if (last?.info.role === "assistant" && last.info.error)
    return { user, assistant: "[No successful final response: the assistant ended with an error.]" }
  if (!block.closed || last?.info.role !== "assistant")
    return { user, assistant: "[No completed final assistant response yet. Reopen this turn after it finishes.]" }
  const response = messageText(last) || "[No final response text recorded.]"
  const stopped = last.info.finish === "length" ? "[Response stopped at the output limit.]\n\n"
    : last.info.finish === "content-filter" ? "[Response stopped by the provider content filter.]\n\n" : ""
  return { user, assistant: stopped + response }
}
