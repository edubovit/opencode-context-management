import { append, emptyPolicy, hash, operation, project, type Block, type Envelope, type Policy } from "./context.ts"
import { resolveRanges } from "./ranges.ts"

export function retainPolicy(raw: Envelope[], inherited: Block[], original: Policy, ids: Map<string, string>, sessionID: string): Policy {
  const mapped = (block: Block) => block.sourceIDs.flatMap((id) => ids.has(id) ? [ids.get(id)!] : [])
  const leaves = (blocks: Block[]): Block[] => blocks.flatMap((block) => block.previous ? leaves(block.previous) : [block])
  const turnEnds = [...new Set(leaves(inherited).flatMap((block) => mapped(block).slice(-1)))]
  let policy: Policy = { ...emptyPolicy(sessionID), ...(turnEnds.length ? { turnEnds } : {}) }
  const originals = new Map(original.operations.map((op) => [op.id, op]))
  const revisions = new Map(original.operations.filter((op) => op.mode === "revise").map((op) => [op.targetID!, op]))
  const retain = (block: Block) => {
    const sourceIDs = mapped(block)
    if (!sourceIDs.length) return
    const selected = () => resolveRanges(project(raw, policy), [sourceIDs])[0]
    if (block.kind === "turn") {
      for (const layer of block.pruning ?? []) {
        const prior = originals.get(layer.operationID)!
        const next = { ...operation(prior.mode, selected(), prior.rule, prior.tokenizer), id: hash([sessionID, prior.id, sourceIDs]), created: prior.created, ...(prior.pruneReason ? { pruneReason: true as const } : {}) }
        policy = append(policy, next)
      }
      return
    }
    if (!block.previous) throw new Error("Retained transformation has no restoration state")
    block.previous.forEach(retain)
    if (sourceIDs.length !== block.sourceIDs.length) return
    const prior = originals.get((block.summaryID ?? block.deletionID)!)!
    const summary = block.summaryID ? (revisions.get(block.summaryID) ?? prior).summary : undefined
    policy = append(policy, { ...operation(prior.mode, selected(), undefined, prior.tokenizer), id: hash([sessionID, prior.id, sourceIDs]), created: prior.created, ...(summary !== undefined ? { summary } : {}) })
  }
  inherited.forEach(retain)
  project(raw, policy)
  return policy
}
