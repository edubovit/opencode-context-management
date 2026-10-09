import { test } from "node:test"
import assert from "node:assert/strict"
import { activeMessages, append, emptyPolicy, hash, operation, project, readPolicy } from "../src/context.ts"
import { projectRequest, validateNativePolicy } from "../src/projection.ts"
import { transcriptView } from "../src/normalize.ts"
import { KEY } from "../src/config.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { pruneRule } from "./fixtures.ts"

test("200 deterministic mixed ledgers preserve source, round-trip replay, and exact nested expansion", () => {
  for (let seed = 1; seed <= 200; seed++) {
    let state = seed
    const choose = (length: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % length }
    const { session, native, canonical } = nativeFixture()
    const original = hash({ native, canonical })
    const raw = transcriptView(session, native)
    let policy = emptyPolicy(session.id)
    const blocks = () => project(activeMessages(raw), policy)
    const request = () => projectRequest(native, raw, canonical, policy)
    for (let step = 0; step < 16; step++) {
      const current = blocks()
      const index = choose(current.length)
      const selected = current.slice(index, index + 1 + choose(current.length - index))
      if (selected.some((block) => block.summaryID || block.pruning?.length) && choose(3) === 0) {
        policy = append(policy, operation("expand", selected))
      } else if (selected.length === 1 && selected[0].summaryID && choose(2) === 0) {
        policy = append(policy, { ...operation("revise", selected), targetID: selected[0].summaryID, summary: `Revised ${seed}/${step}` })
      } else if (choose(2) === 0) {
        const before = request()
        const summary = { ...operation(choose(2) ? "compact" : "brief", selected), summary: `Summary ${seed}/${step}` }
        policy = append(policy, summary)
        const summarized = blocks().filter((block) => block.summaryID === summary.id)
        const expanded = append(policy, operation("expand", summarized))
        assert.deepEqual(projectRequest(native, raw, canonical, expanded), before)
      } else {
        const mode = (["tool-prune", "prune-reason", "tool-prune-all", "tool-delete"] as const)[choose(4)]
        policy = append(policy, { ...operation(mode, selected, mode === "tool-prune" ? pruneRule({ threshold: 200, head: 10, tail: 10 }) : undefined), ...(mode === "tool-delete" ? { pruneReason: true as const } : {}) })
      }
      validateNativePolicy(native, raw, policy)
      const saved = readPolicy({ id: session.id, metadata: { [KEY]: JSON.parse(JSON.stringify(policy)) } })
      assert.deepEqual(projectRequest(native, raw, canonical, saved), request(), `seed ${seed}, step ${step}`)
      assert.equal(hash({ native, canonical }), original)
    }
  }
})
