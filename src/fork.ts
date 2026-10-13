import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { activeMessages, hash, project, type Policy } from "./context.ts"
import { transcriptView } from "./normalize.ts"
import { retainPolicy } from "./retention.ts"

export function inheritFork(source: SessionInfo, native: readonly SessionMessageInfo[], target: SessionInfo, copied: readonly SessionMessageInfo[], original: Policy): Policy {
  if (target.fork?.sessionID !== source.id || original.sessionID !== source.id) throw new Error("Fork ledger provenance does not match its source")
  const boundary = native.findIndex((message) => message.id === target.fork!.boundary.messageID)
  if (boundary < 0) throw new Error("Fork boundary is outside the source's available history")
  const prefix = native.slice(0, boundary + (target.fork.boundary.type === "through" ? 1 : 0)).filter((message) =>
    message.type === "assistant" ? message.time.completed !== undefined : message.type === "shell" || message.type === "compaction" ? message.status !== "running" : true)
  const identity = ({ id: _id, ...message }: SessionMessageInfo) => hash(message)
  if (copied.length < prefix.length || prefix.some((message, index) => identity(message) !== identity(copied[index])))
    throw new Error("Fork history differs from its source; original data is preserved")
  const ids = new Map(prefix.map((message, index) => [message.id, copied[index].id]))
  const inherited = project(activeMessages(transcriptView(source, native)), original)
  const raw = activeMessages(transcriptView(target, copied))
  return retainPolicy(raw, inherited, original, ids, target.id)
}
