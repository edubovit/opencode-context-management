import { append, blockMessages, emptyPolicy, hash, activeMessages, operation, project, splitAfter, type Policy } from "../src/context.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest } from "../src/projection.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { TOKENIZER_ID } from "../src/tokens.ts"

export function persistenceFixture(checkpoint = false) {
  const { session, native, canonical } = nativeFixture()
  const raw = transcriptView(session, native)
  let policy = emptyPolicy(session.id)
  const states: { source: string; request: string }[] = []
  const save = (mode: Parameters<typeof operation>[0], selected: ReturnType<typeof project>, extra: Partial<Policy["operations"][number]> = {}) => {
    const op = { ...operation(mode, selected, mode === "tool-prune" ? { unit: "tokens", threshold: 200, head: 10, tail: 10, encoding: "o200k_base", library: TOKENIZER_ID } : undefined), id: `saved-${states.length}`, created: 100 + states.length, ...extra }
    policy = append(policy, op)
    states.push({ source: op.beforeHash, request: hash(projectRequest(native, raw, canonical, policy)) })
  }
  const blocks = () => project(activeMessages(raw), policy)
  save("tool-prune", [blocks()[0]], { pruneReason: true })
  save("compact", checkpoint ? splitAfter(blocks(), "msg_u1").slice(0, 2) : blocks().slice(0, 2), { summary: "Saved detailed findings", ...(checkpoint ? { checkpoint: true } : {}) })
  save("revise", [blocks()[0]], { summary: "Corrected detailed findings", targetID: "saved-1" })
  save("brief", blocks(), { summary: "Outer summary" })
  save("expand", blocks())
  save("expand", [blocks()[0]])
  return { session, native, canonical, raw, policy, states, effective: hash(blockMessages(blocks())) }
}
