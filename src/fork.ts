import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { activeMessages, append, emptyPolicy, hash, operation, project, type Block, type Policy } from "./context.ts"
import { transcriptView } from "./normalize.ts"
import { resolveRanges } from "./ranges.ts"

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
  const mapped = (block: Block) => block.sourceIDs.flatMap((id) => ids.has(id) ? [ids.get(id)!] : [])
  const leaves = (blocks: Block[]): Block[] => blocks.flatMap((block) => block.previous ? leaves(block.previous) : [block])
  const turnEnds = [...new Set(leaves(inherited).flatMap((block) => mapped(block).slice(-1)))]
  let policy: Policy = { ...emptyPolicy(target.id), ...(turnEnds.length ? { turnEnds } : {}) }
  const originals = new Map(original.operations.map((op) => [op.id, op]))
  const revisions = new Map(original.operations.filter((op) => op.mode === "revise").map((op) => [op.targetID!, op]))
  const retain = (block: Block) => {
    const sourceIDs = mapped(block)
    if (!sourceIDs.length) return
    const selected = () => resolveRanges(project(raw, policy), [sourceIDs])[0]
    if (block.kind === "turn") {
      for (const layer of block.pruning ?? []) {
        const prior = originals.get(layer.operationID)!
        const next = { ...operation(prior.mode, selected(), prior.rule, prior.tokenizer), created: prior.created, ...(prior.pruneReason ? { pruneReason: true as const } : {}) }
        policy = append(policy, next)
      }
      return
    }
    if (!block.previous) throw new Error("Fork transformation has no restoration state")
    block.previous.forEach(retain)
    if (sourceIDs.length !== block.sourceIDs.length) return
    const prior = originals.get((block.summaryID ?? block.deletionID)!)!
    const summary = block.summaryID ? (revisions.get(block.summaryID) ?? prior).summary : undefined
    policy = append(policy, { ...operation(prior.mode, selected(), undefined, prior.tokenizer), created: prior.created, ...(summary !== undefined ? { summary } : {}) })
  }
  inherited.forEach(retain)
  project(raw, policy)
  return policy
}
