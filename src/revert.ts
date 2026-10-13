import { activeMessages, hash, historyHash, project, type Envelope, type Policy } from "./context.ts"
import { retainPolicy } from "./retention.ts"

const references = (policy: Policy) => [...policy.operations.flatMap((op) => op.sourceIDs), ...policy.turnEnds ?? []]

export function rememberPolicy(raw: Envelope[], policy: Policy): Policy {
  const active = activeMessages(raw)
  if (policy.sources?.some((source) => source.created === undefined) && policy.sources.some((source, index) => {
    const message = active[index]
    return !message || source.id !== message.info.id || source.hash !== historyHash([message]) || source.user !== (message.info.role === "user")
  })) throw new Error("Saved source history changed; cannot recover missing timestamps")
  project(active, policy)
  const selected = new Set(references(policy))
  const end = active.findLastIndex((message) => selected.has(message.info.id))
  const { sources: _sources, ...saved } = policy
  if (end < 0) return saved
  return { ...saved, sources: active.slice(0, end + 1).map((message) => ({ id: message.info.id, hash: historyHash([message]), user: message.info.role === "user", created: message.info.time.created })) }
}

export function revertPolicy(raw: Envelope[], policy: Policy, boundary?: string): Policy {
  const active = activeMessages(raw)
  const index = boundary === undefined ? -1 : raw.findIndex((message) => message.info.id === boundary)
  if (boundary !== undefined && index < 0) throw new Error("Revert boundary is outside the available history")
  const retained = boundary === undefined ? active : activeMessages(raw.slice(0, index))
  const present = new Set(retained.map((message) => message.info.id))
  if (references(policy).every((id) => present.has(id))) return policy
  const signatures = new Map(policy.sources?.map((source) => [source.id, source.hash]))
  for (const message of retained) if (signatures.has(message.info.id) && signatures.get(message.info.id) !== historyHash([message]))
    throw new Error("Retained history prefix changed; original data is preserved")
  let original = active
  let unavailable: Set<string> | undefined
  if (boundary === undefined) {
    if (!policy.sources) throw new Error("Revert source provenance is unavailable. Restore the original host history before continuing.")
    const known = new Set(policy.sources.map((source) => source.id))
    if (active.some((message) => message.info.kind === "compaction" && !known.has(message.info.id))) throw new Error("Native checkpoint history changed; original data is preserved")
    if (references(policy).some((id) => !known.has(id))) throw new Error("Saved source manifest is incomplete; original data is preserved")
    const cut = policy.sources.findIndex((source, at) => source.id !== active[at]?.info.id)
    if (cut < 0) throw new Error("Saved source range is missing from the verified prefix")
    if (active.slice(cut).some((message) => known.has(message.info.id))) throw new Error("History is not an intact retained prefix; original data is preserved")
    const latest = policy.sources.reduce((time, source) => {
      if (source.created === undefined) throw new Error("Revert source timestamps are unavailable. Restore the original host history before continuing.")
      return Math.max(time, source.created)
    }, 0)
    if (active.slice(cut).some((message) => message.info.time.created < latest)) throw new Error("History after the retained prefix is not new input; original data is preserved")
    for (let at = 0; at < cut; at++) if (policy.sources[at].hash !== historyHash([active[at]])) throw new Error("Retained history prefix changed; original data is preserved")
    const missing = policy.sources.slice(cut)
    unavailable = new Set(missing.map((source) => source.id))
    const placeholders: Envelope[] = missing.map((source) => ({
      info: source.user
        ? { id: source.id, sessionID: policy.sessionID, role: "user", kind: "user", agent: "", model: { providerID: "", modelID: "" }, time: { created: 0 } }
        : { id: source.id, sessionID: policy.sessionID, role: "assistant", kind: "assistant", agent: "", providerID: "", modelID: "", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0 } },
      parts: [],
    }))
    original = [...active.slice(0, cut), ...placeholders]
  }
  const inherited = project(original, policy, undefined, unavailable)
  const ids = new Map(original.filter((message) => present.has(message.info.id) && !unavailable?.has(message.info.id)).map((message) => [message.info.id, message.info.id]))
  const next = retainPolicy(retained, inherited, policy, ids, policy.sessionID)
  return rememberPolicy(retained, { ...next, epoch: hash([policy.epoch, policy.operations, policy.turnEnds, [...ids]]) })
}
