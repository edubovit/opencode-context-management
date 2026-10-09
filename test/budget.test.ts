import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import type { SessionMessageInfo } from "@opencode/client"
import { budgetScope, budgetUnits, estimateBudget, localTokens, prepareBudget, recordRequest, budgetStateSchema, type BudgetIdentity, type BudgetState } from "../src/budget.ts"
import { FALLBACK_BASIS } from "../src/tokens.ts"
import { settings } from "../src/config.ts"

const identity: BudgetIdentity = { scope: "scope", agent: "build", model: { providerID: "fixture", id: "model" } }
const system = [{ text: "System instructions" }]
const tools = { tool: { description: "Tool", input: { type: "object" } } }
const user: SessionMessageInfo = { id: "msg_user", type: "user", text: "Question", time: { created: 1 } }
const prompt = Message.make({ id: user.id, role: "user", content: "Question" })
function reply(): Extract<SessionMessageInfo, { type: "assistant" }> {
  return { id: "msg_reply", type: "assistant", agent: "build", model: { providerID: "fixture", id: "model" }, time: { created: 2, completed: 3 }, finish: "stop", content: [{ type: "text", text: "Answer" }], tokens: { input: 500, cache: { read: 100, write: 70 }, output: 20, reasoning: 30 } }
}
function paired() {
  const response = reply()
  const messages = [prompt, Message.make({ id: response.id, role: "assistant", content: "Answer" })]
  const pending = recordRequest({ version: 1, scope: "scope" }, [user], budgetUnits([prompt], system, tools, FALLBACK_BASIS), "policy0")
  const state = prepareBudget(identity, [user, response], messages, system, tools, FALLBACK_BASIS, "policy0", pending)
  return { response, messages, state, pending }
}

test("provider matching adds cache subsets and output/reasoning exactly once", () => {
  const { state, messages } = paired()
  const budget = estimateBudget(budgetUnits(messages, system, tools, FALLBACK_BASIS), state, 1.3)
  assert.equal(budget.source, "provider-matched")
  assert.deepEqual(budget.reported, { messageID: "msg_reply", input: 670, output: 50 })
  assert.equal(budget.tokens, 720)
  assert.equal(budget.added, 0)
  assert.equal(budget.removed, 0)
})

test("670k provider versus 530k local exceeds a 600k threshold; reduction and expansion recount", () => {
  const state: BudgetState = { version: 1, scope: "scope", anchor: { reportID: "msg_report", prefix: { length: 0, hash: "" }, policy: "original", input: 670000, output: 0, inputLocal: 530000, matched: true, units: [{ key: "history", tokens: 530000 }] } }
  const original = estimateBudget([{ key: "history", tokens: 530000 }], state, 1.3)
  assert.equal(original.tokens, 670000)
  assert.ok(original.local < 600000 && original.tokens > 600000)
  const compacted = estimateBudget([{ key: "summary", tokens: 100000 }], state, 1.3)
  assert.equal(compacted.tokens, 270000)
  assert.ok(compacted.tokens < 600000)
  assert.equal(estimateBudget([{ key: "history", tokens: 530000 }], state, 1.3).tokens, original.tokens)
  assert.equal(state.anchor?.policy, "original", "Candidate measurements cannot mutate their common anchor")
})

test("growth is charged separately from removals, not cancelled out in a net local delta", () => {
  const { state } = paired()
  const units = state.anchor!.units
  const changed = units.map((item) => ({ ...item, key: "new-" + item.key }))
  const old = estimateBudget(units, state, 1.3)
  const next = estimateBudget(changed, state, 1.3)
  assert.equal(next.local, old.local)
  assert.ok(next.tokens > old.tokens)
  assert.ok(next.multiplier >= 1.3)
})

test("duplicate identical units retain multiplicity and reductions never push below local count", () => {
  const { state } = paired()
  const unit = { key: "duplicate", tokens: 10 }
  state.anchor!.units = [unit, unit]
  const reduced = estimateBudget([unit], state, 1.3)
  assert.equal(reduced.removed, 10)
  assert.equal(reduced.added, 0)
  state.anchor!.input = 1; state.anchor!.output = 0
  assert.equal(estimateBudget([unit], state, 1).tokens, 10)
})

test("current assistant output is covered by usage; local tool results and new input are additions", () => {
  const { state, messages } = paired()
  const result = Message.tool({ id: "call_new", name: "read", result: "Local result never seen by the previous provider request" })
  const next = Message.make({ id: "msg_next", role: "user", content: "New user input" })
  const baseline = estimateBudget(budgetUnits(messages, system, tools, FALLBACK_BASIS), state, 1.3)
  const added = estimateBudget(budgetUnits([...messages, result, next], system, tools, FALLBACK_BASIS), state, 1.3)
  assert.ok(added.added > 0)
  assert.equal(added.tokens, Math.ceil(720 + added.added * added.multiplier))
  assert.equal(baseline.tokens, 720)
})

test("tool-call inputs in the response are not counted twice alongside measured output", () => {
  const { pending } = paired()
  const response = reply()
  response.content = [{ type: "tool", id: "call", name: "read", time: { created: 2, completed: 3 }, state: { status: "completed", input: { path: "fixture" }, content: [{ type: "text", text: "Result" }] } }]
  const messages = [prompt, Message.make({ id: response.id, role: "assistant", content: [{ type: "tool-call", id: "call", name: "read", input: { path: "fixture" } }] }), Message.tool({ id: "call", name: "read", result: "Result" })]
  const state = prepareBudget(identity, [user, response], messages, system, tools, FALLBACK_BASIS, "policy0", pending)
  const budget = estimateBudget(budgetUnits(messages, system, tools, FALLBACK_BASIS), state, 1.3)
  assert.equal(budget.added, localTokens(budgetUnits([messages[2]], [], {}, FALLBACK_BASIS)) - localTokens(budgetUnits([], [], {}, FALLBACK_BASIS)))
  assert.equal(budget.removed, 0)
})

test("old sessions bootstrap from compatible usage without pretending the request was paired", () => {
  const { response, messages } = paired()
  const next: SessionMessageInfo = { ...user, id: "msg_new", text: "New input" }
  const current = [...messages, Message.make({ id: next.id, role: "user", content: next.text })]
  const state = prepareBudget(identity, [user, response, next], current, system, tools, FALLBACK_BASIS, "current-policy")
  const budget = estimateBudget(budgetUnits(current, system, tools, FALLBACK_BASIS), state, 1.3)
  assert.equal(budget.source, "provider-unpaired")
  assert.ok(budget.tokens > 720)
  const persisted = budgetStateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(prepareBudget(identity, [user, response, next], current, system, tools, FALLBACK_BASIS, "edited-policy", persisted).anchor, state.anchor)
})

test("a policy edit after the sampled request keeps the original measured anchor and credits only local removals", () => {
  const { pending, response, messages } = paired()
  const current = [Message.make({ id: user.id, role: "user", content: "Replacement summary" }), messages[1]]
  const state = prepareBudget(identity, [user, response], current, system, tools, FALLBACK_BASIS, "new-policy", pending)
  assert.equal(state.anchor?.matched, true)
  assert.equal(state.anchor?.policy, "policy0")
  const budget = estimateBudget(budgetUnits(current, system, tools, FALLBACK_BASIS), state, 1.3)
  assert.ok(budget.added > 0 && budget.removed > 0)
})

test("bootstrap after a pre-upgrade edit uses the pre-edit reference, not a stale floor on tiny current context", () => {
  const { response, messages } = paired()
  const long = Message.make({ id: user.id, role: "user", content: "Earlier useful facts. ".repeat(1000) })
  const current = [Message.make({ id: user.id, role: "user", content: "Summary" })]
  response.tokens = { input: 5000, output: 100, reasoning: 100, cache: { read: 0, write: 0 } }
  const state = prepareBudget(identity, [user, response], current, system, tools, FALLBACK_BASIS, "new-policy", undefined, () => ({ messages: [long, messages[1]], policy: "historical-policy" }))
  const budget = estimateBudget(budgetUnits(current, system, tools, FALLBACK_BASIS), state, 1.3)
  assert.equal(budget.source, "provider-unpaired")
  assert.equal(state.anchor?.policy, "historical-policy")
  assert.ok(budget.tokens < 2000, JSON.stringify(budget))
})

test("changed model or endpoint invalidates the anchor and suppresses historical bootstrap", () => {
  const { state, response, messages } = paired()
  const changed = { ...identity, scope: "different-endpoint" }
  const reset = prepareBudget(changed, [user, response], messages, system, tools, FALLBACK_BASIS, "policy0", state)
  assert.equal(reset.anchor, undefined)
  assert.equal(prepareBudget(changed, [user, response], messages, system, tools, FALLBACK_BASIS, "policy0", reset).anchor, undefined)
  const fresh = { ...response, id: "msg_fresh", time: { created: 4, completed: 5 } }
  const pending = recordRequest(reset, [user, response], budgetUnits(messages, system, tools, FALLBACK_BASIS), "policy0")
  const updated = prepareBudget(changed, [user, response, fresh], [...messages, Message.make({ id: fresh.id, role: "assistant", content: "Answer" })], system, tools, FALLBACK_BASIS, "policy0", pending)
  assert.equal(updated.anchor?.reportID, fresh.id)
  assert.equal(updated.anchor?.matched, true)
})

test("model/variant/agent mismatches, failed replies and malformed usage cannot calibrate a request", () => {
  for (const change of [
    (value: ReturnType<typeof reply>) => { value.model.id = "other" },
    (value: ReturnType<typeof reply>) => { value.model.providerID = "other" },
    (value: ReturnType<typeof reply>) => { value.model.variant = "high" },
    (value: ReturnType<typeof reply>) => { value.agent = "helper" },
    (value: ReturnType<typeof reply>) => { value.error = { type: "aborted", message: "Stopped" } },
    (value: ReturnType<typeof reply>) => { value.tokens = undefined },
    (value: ReturnType<typeof reply>) => { value.tokens!.input = -1 },
    (value: ReturnType<typeof reply>) => { value.tokens!.input = NaN },
    (value: ReturnType<typeof reply>) => { value.tokens!.input = Infinity },
    (value: ReturnType<typeof reply>) => { value.time.completed = undefined },
  ]) {
    const { pending, response, messages } = paired()
    change(response)
    const state = prepareBudget(identity, [user, response], messages, system, tools, FALLBACK_BASIS, "policy0", pending)
    assert.equal(state.anchor, undefined)
  }
})

test("interrupted or retried requests cannot falsely pair a later response with a cancelled sample", () => {
  const { pending, response, messages } = paired()
  const idle: SessionMessageInfo = { id: "msg_idle", type: "idle", outcome: "interrupted", time: { created: 2 } }
  const newer = { ...user, id: "msg_newer", time: { created: 3 } }
  const state = prepareBudget(identity, [user, idle, newer, response], messages, system, tools, FALLBACK_BASIS, "policy0", pending)
  assert.equal(state.anchor?.matched, false)
})

test("native checkpoints and changed raw history invalidate old prefix evidence", () => {
  const { state, response, messages } = paired()
  const checkpoint: SessionMessageInfo = { id: "msg_compact", type: "compaction", status: "completed", reason: "manual", summary: "Summary", recent: "", time: { created: 4 } }
  assert.equal(prepareBudget(identity, [user, response, checkpoint], messages, system, tools, FALLBACK_BASIS, "policy0", state).anchor, undefined)
  const changed = prepareBudget(identity, [{ ...user, text: "Changed" }, response], messages, system, tools, FALLBACK_BASIS, "policy0", state)
  assert.equal(changed.anchor?.matched, false)
})

test("missing usage has a visible configurable safety uplift, including invalid multiplier rejection", () => {
  const state: BudgetState = { version: 1, scope: "scope" }
  assert.deepEqual(estimateBudget([{ key: "one", tokens: 100 }], state, 1.3), { source: "local-fallback", tokens: 130, local: 100, multiplier: 1.3, added: 100, removed: 0 })
  assert.equal(settings().autocompaction.estimateMultiplier, 1.3)
  assert.equal(settings({ autocompaction: { estimateMultiplier: 1.6 } }).autocompaction.estimateMultiplier, 1.6)
  for (const invalid of [0, -1, NaN, Infinity, "1.3", null]) assert.throws(() => settings({ autocompaction: { estimateMultiplier: invalid } }), /estimateMultiplier/)
  assert.throws(() => estimateBudget([{ key: "one", tokens: 100 }], state, Number.MAX_VALUE), /numeric bounds/)
})

test("scope hashing covers route/model/tokenizer configuration without persisting credentials or prompt text", () => {
  const configuration = { endpoint: "http://fixture", secret: "PRIVATE_CREDENTIAL" }
  const first = budgetScope(identity, FALLBACK_BASIS, configuration)
  assert.notEqual(first, budgetScope(identity, FALLBACK_BASIS, { ...configuration, endpoint: "http://other" }))
  assert.notEqual(first, budgetScope(identity, { ...FALLBACK_BASIS, encoding: "cl100k_base" }, configuration))
  assert.equal(first, budgetScope({ ...identity, model: { ...identity.model, variant: "default" } }, FALLBACK_BASIS, configuration))
  const { pending } = paired()
  const saved = JSON.stringify({ ...pending, scope: first })
  for (const secret of ["PRIVATE_CREDENTIAL", "Question", "System instructions"]) assert.ok(!saved.includes(secret))
  assert.throws(() => budgetStateSchema.parse({ ...pending, version: 99 }))
  assert.throws(() => budgetStateSchema.parse({ ...pending, pending: { ...pending.pending, units: [{ key: "corrupt", tokens: -1 }] } }))
})
