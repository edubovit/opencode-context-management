import { append, emptyPolicy, hash, operation, project, splitAfter, type Block, type Envelope, type Policy } from "./context.ts"
import { resolveRanges } from "./ranges.ts"
import { FALLBACK_BASIS } from "./tokens.ts"

export function retainPolicy(raw: Envelope[], inherited: Block[], original: Policy, ids: Map<string, string>, sessionID: string): Policy {
  if (original.subturnOrigins?.length || original.operations.some(op => op.mode === "partition")) return retainPartitions(raw, inherited, original, ids, sessionID)
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

function retainPartitions(raw: Envelope[], inherited: Block[], original: Policy, ids: Map<string, string>, sessionID: string): Policy {
  const mapped = (block: Block) => block.sourceIDs.flatMap(id => ids.has(id) ? [ids.get(id)!] : [])
  const leaves = (blocks: Block[]): Block[] => blocks.flatMap(block => block.previous ? leaves(block.previous) : block.segments ? leaves(block.segments) : [block])
  const subturnOrigins = [...new Set(leaves(inherited).flatMap(block => {
    const originID = block.subturn?.originID
    return originID && ids.has(originID) && mapped(block).length ? [ids.get(originID)!] : []
  }))]
  const endpoints = new Set(leaves(inherited).flatMap(block => mapped(block).slice(-1)))
  const retained = new Set(ids.values())
  const initial = project(raw, emptyPolicy(sessionID))
  for (const block of initial) {
    const last = block.sourceIDs.findLast(id => retained.has(id))
    if (last) endpoints.delete(last)
  }
  const safe = (message: Envelope) => {
    const tools = message.parts.filter(part => part.type === "tool")
    return message.info.kind === "assistant" && message.info.role === "assistant" && message.info.time.completed !== undefined &&
      tools.length > 0 && tools.every(part => part.state.status === "completed" || part.state.status === "error")
  }
  const turnEnds = raw.filter(message => endpoints.has(message.info.id) && !safe(message)).map(message => message.info.id)
  let policy: Policy = { ...emptyPolicy(sessionID), ...(turnEnds.length ? { turnEnds } : {}), ...(subturnOrigins.length ? { subturnOrigins } : {}) }
  const basis = original.operations.find(op => op.mode === "partition")?.tokenizer ?? original.operations[0]?.tokenizer ?? FALLBACK_BASIS
  const topology = (selected: Block[], cuts: string[]) => {
    const op = operation("partition", selected, undefined, basis)
    policy = append(policy, { ...op, id: hash([sessionID, "partition", policy.revision, op.sourceIDs, cuts]), created: 0, cuts })
  }
  for (const block of project(raw, policy)) {
    const cuts = block.sourceIDs.slice(0, -1).filter(id => endpoints.has(id) && !turnEnds.includes(id))
    if (cuts.length) topology([block], cuts)
  }
  const originals = new Map(original.operations.map(op => [op.id, op]))
  const revisions = new Map(original.operations.filter(op => op.mode === "revise").map(op => [op.targetID!, op]))
  const retain = (block: Block) => {
    const sourceIDs = mapped(block)
    if (!sourceIDs.length) return
    const selected = () => resolveRanges(splitAfter(project(raw, policy), sourceIDs.at(-1)!), [sourceIDs])[0]
    if (block.kind === "turn") {
      if (block.segments) {
        block.segments.forEach(retain)
        const current = selected()
        if (current.length > 1) topology(current, [])
      } else for (const layer of block.pruning ?? []) {
        const prior = originals.get(layer.operationID)!
        policy = append(policy, {
          ...operation(prior.mode, selected(), prior.rule, prior.tokenizer), id: hash([sessionID, prior.id, sourceIDs]), created: prior.created,
          ...(prior.pruneReason ? { pruneReason: true as const } : {}),
        })
      }
      return
    }
    if (!block.previous) throw new Error("Retained transformation has no restoration state")
    block.previous.forEach(retain)
    if (sourceIDs.length !== block.sourceIDs.length) return
    const prior = originals.get((block.summaryID ?? block.deletionID)!)!
    const summary = block.summaryID ? (revisions.get(block.summaryID) ?? prior).summary : undefined
    policy = append(policy, {
      ...operation(prior.mode, selected(), undefined, prior.tokenizer), id: hash([sessionID, prior.id, sourceIDs]), created: prior.created,
      ...(summary !== undefined ? { summary } : {}),
    })
  }
  inherited.forEach(retain)
  project(raw, policy)
  return policy
}
