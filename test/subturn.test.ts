import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { Message, ToolCallPart } from "@opencode/ai"
import type { SessionMessageInfo } from "@opencode/client"
import { activeMessages, append, blockMessages, emptyPolicy, hash, historyHash, operation, project, readPolicy, replacement, splitOperation, summaryRangeStart, validatePartition, type Operation } from "../src/context.ts"
import { Controller } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest, validateNativePolicy } from "../src/projection.ts"
import { FALLBACK_BASIS } from "../src/tokens.ts"
import { rememberPolicy, revertPolicy } from "../src/revert.ts"
import { retainPolicy } from "../src/retention.ts"
import { nativeSession } from "./native-fixtures.ts"
import { setupController } from "./controller-fixture.ts"

function fixture() {
  const session = nativeSession("ses_test")
  const native: SessionMessageInfo[] = [
    { id: "user", type: "user", text: "ORIGINAL_PROMPT_ONLY_ONCE", time: { created: 1 } },
    ...Array.from({ length: 5 }, (_, index): Extract<SessionMessageInfo, { type: "assistant" }> => ({
      id: `batch_${index}`, type: "assistant", agent: "build", model: session.model!,
      time: { created: index * 10 + 2, completed: index * 10 + 3 }, finish: index === 4 ? "stop" : "tool-calls",
      content: [
        { type: "reasoning", text: `REASON_${index}`, native: { signature: `signed_${index}` } },
        { type: "tool", id: `call_${index}`, name: "read", time: { created: 1, completed: 2 }, state: {
          status: "completed", input: { index }, content: [{ type: "text", text: `OUTPUT_${index} ${"detail ".repeat(100)}` }], metadata: {},
        } },
        { type: "text", text: `ANSWER_${index}` },
      ],
    })),
  ]
  const raw = activeMessages(transcriptView(session, native))
  const canonical = native.flatMap((message): Message[] => {
    if (message.type === "user") return [Message.make({ id: message.id, role: "user", content: message.text })]
    assert.equal(message.type, "assistant")
    const tool = message.content.find(part => part.type === "tool")!
    assert.equal(tool.state.status, "completed")
    return [
      Message.make({ id: message.id, role: "assistant", content: message.content.map(part => part.type === "tool"
        ? ToolCallPart.make({ id: part.id, name: part.name, input: tool.state.input })
        : part.type === "reasoning" ? { type: "reasoning", text: part.text, providerMetadata: { fixture: part.native! } } : Message.text(part.text)) }),
      Message.tool({ id: tool.id, name: tool.name, result: { type: "content", value: tool.state.content } }),
    ]
  })
  let policy = emptyPolicy(session.id)
  const blocks = () => project(raw, policy)
  const save = (op: Operation) => { policy = append(policy, op) }
  const partition = (cuts = ["batch_0", "batch_2"]) => save({ ...operation("partition", blocks()), cuts })
  return { session, native, raw, canonical, blocks, save, partition, get policy() { return policy } }
}

async function controllerFixture(t: TestContext) {
  const base = await setupController(t)
  const data = fixture()
  base.data.messages = data.raw
  const controller = new Controller(base.host, base.data.session.id, settings({ subturns: { minTokens: 1, minSplitTokens: 2 } }), base.storage)
  t.after(() => controller.dispose())
  return { ...base, controller, fixture: data, ids: data.raw.map(message => message.info.id) }
}

test("splitting uses the supplied main tokenizer, reduces infeasible counts and preserves content", () => {
  const f = fixture()
  const basis = { ...FALLBACK_BASIS, source: "configured override" as const, providerID: "main", modelID: "main-model" }
  const result = splitOperation(f.blocks()[0], 100, basis, { minTokens: 1, minSplitTokens: 2 })
  assert.equal(result.parts, 5)
  assert.equal(result.operation.mode, "partition")
  assert.deepEqual(result.operation.tokenizer, basis)
  assert.deepEqual(result.operation.cuts, ["batch_0", "batch_1", "batch_2", "batch_3"])
  f.save(result.operation)
  assert.equal(f.blocks().length, 5)
  assert.ok(f.blocks().every(block => block.subturn?.originID === "user" && block.closed))
  assert.deepEqual(blockMessages(f.blocks()), f.raw)
  assert.throws(() => splitOperation(f.blocks()[0], 2, basis, { minTokens: 10_000, minSplitTokens: 50_000 }), /at least|Cannot split/)
})

test("structural canonical projection is an exact no-op including opaque provider state and missing pairs", () => {
  const f = fixture()
  f.partition()
  const opaque = f.canonical.map(message => Message.make({ ...message, native: { provider: "opaque" }, providerMetadata: { fixture: { signed: true } } }))
  for (const incoming of [opaque, opaque.filter(message => message.role !== "tool"), [Message.system("host-only context")]]) {
    const before = hash(incoming)
    const projected = projectRequest(f.native, f.raw, incoming, f.policy)
    assert.deepEqual(projected, incoming)
    assert.ok(projected.every((message, index) => message === incoming[index]))
    assert.equal(hash(incoming), before)
  }
  validateNativePolicy(f.native, f.raw, f.policy)
  f.partition([])
  assert.deepEqual(projectRequest(f.native, f.raw, opaque, f.policy), opaque)
  const pruned = append(f.policy, operation("prune-reason", f.blocks()))
  assert.throws(() => projectRequest(f.native, f.raw, opaque, pruned), /Opaque/)
  assert.throws(() => projectRequest(f.native, f.raw, f.canonical.filter(message => message.role !== "tool"), pruned), /absent/)
})

test("continuation summary has distinct synthetic IDs, no repeated original prompt, and reversible canonical pairs", () => {
  const f = fixture()
  f.partition()
  const continuation = f.blocks()[1]
  assert.equal(continuation.messages[0].info.role, "assistant")
  assert.equal(summaryRangeStart([continuation]), true)
  const op = { ...operation("brief", [continuation]), summary: "CONTINUATION_FACT" }
  const replaced = replacement(op, [continuation])
  const ids = replaced.messages.map(message => message.info.id)
  assert.equal(new Set(ids).size, 2)
  assert.ok(ids.every(id => !f.raw.some(message => message.info.id === id)))
  assert.doesNotMatch(JSON.stringify(replaced.messages), /ORIGINAL_PROMPT_ONLY_ONCE/)
  assert.equal(replaced.subturn?.originID, "user")
  f.save(op)
  const request = projectRequest(f.native, f.raw, f.canonical, f.policy)
  assert.equal(JSON.stringify(request).match(/ORIGINAL_PROMPT_ONLY_ONCE/g)?.length, 1)
  assert.match(JSON.stringify(request), /CONTINUATION_FACT/)
  assert.doesNotMatch(JSON.stringify(request), /call_1|call_2|OUTPUT_1|OUTPUT_2/)
  f.save(operation("expand", [f.blocks()[1]]))
  assert.deepEqual(projectRequest(f.native, f.raw, f.canonical, f.policy), f.canonical)
})

test("synthetic summary users never establish a new original turn identity", () => {
  const f = fixture()
  f.partition()
  f.save({ ...operation("brief", [f.blocks()[1]]), summary: "SUMMARY" })
  const summary = f.blocks()[1]
  assert.throws(() => splitOperation(summary, 2, FALLBACK_BASIS, { minTokens: 1, minSplitTokens: 2 }), /ordinary/)
  assert.throws(() => project(f.raw, append(f.policy, { ...operation("partition", [summary]), cuts: ["batch_1"] })), /ordinary siblings/)
  assert.throws(() => project(f.raw, append(f.policy, { ...operation("partition", f.blocks()), cuts: [] })), /expand summaries/)
  const { subturn: _subturn, ...unverified } = f.blocks()[2]
  assert.equal(summaryRangeStart([unverified]), false)
  assert.throws(() => replacement({ ...operation("brief", [unverified]), summary: "UNVERIFIED" }, [unverified]), /verified subturn/)
})

test("canonical leaf restoration remains exact after prune, merge, resplit, delete and summary", () => {
  const f = fixture()
  f.partition(["batch_0", "batch_1", "batch_2", "batch_3"])
  f.save(operation("prune-reason", [f.blocks()[0]]))
  f.save({ ...operation("tool-delete", [f.blocks()[1]]), pruneReason: true })
  f.save(operation("tool-prune-all", [f.blocks()[2]]))
  f.save({ ...operation("partition", f.blocks().slice(0, 4)), cuts: [] })
  f.save({ ...operation("partition", [f.blocks()[0]]), cuts: ["batch_1"] })
  const before = projectRequest(f.native, f.raw, f.canonical, f.policy)
  const topology = f.blocks().map(block => block.sourceIDs)
  f.save({ ...operation("brief", f.blocks().slice(1)), summary: "LATER_SUMMARY" })
  f.save(operation("delete", f.blocks()))
  assert.deepEqual(projectRequest(f.native, f.raw, f.canonical, f.policy), [])
  f.save(operation("expand", f.blocks()))
  f.save(operation("expand", f.blocks()))
  assert.deepEqual(f.blocks().map(block => block.sourceIDs), topology)
  assert.notDeepEqual(projectRequest(f.native, f.raw, f.canonical, f.policy), before)
  for (let count = 0; count < 4; count++) {
    const op = operation("expand", f.blocks())
    if (!op.pruneTargets?.length) break
    f.save(op)
  }
  assert.deepEqual(projectRequest(f.native, f.raw, f.canonical, f.policy), f.canonical)
  assert.deepEqual(blockMessages(f.blocks()), f.raw)
})

test("manual split and merge use checked writes without generation or metadata reset", async t => {
  const { host, data, controller, ids } = await controllerFixture(t)
  const initial = hash(data.messages)
  const update = host.update
  const expected: unknown[] = []
  host.update = async (id, metadata, check) => { expected.push(check); return update(id, metadata, check) }
  assert.equal(await controller.splitTurn(ids, 100), 5)
  assert.equal((await controller.load()).blocks.length, 5)
  await controller.mergeSubturns(ids)
  const loaded = await controller.load()
  assert.equal(loaded.blocks.length, 1)
  assert.deepEqual(loaded.policy.operations.map(op => op.mode), ["partition", "partition"])
  assert.deepEqual(loaded.policy.operations.at(-1)!.cuts, [])
  assert.equal(data.session.metadata?.unrelated, "keep")
  assert.equal(hash(data.messages), initial)
  assert.equal(data.jobs, 0)
  assert.equal(data.calls.length, 0)
  assert.equal(expected.length, 2)
  assert.ok(expected.every(check => Object.keys(check as object).sort().join() === "fingerprint,revision"))
})

test("manual split/merge reject invalid selection, busy, reverted and read-only state", async t => {
  const { host, data, controller, storage, ids } = await controllerFixture(t)
  await assert.rejects(controller.mergeSubturns(ids), /at least two/)
  await assert.rejects(controller.splitTurn(ids, 1), /at least 2/)
  await assert.rejects(controller.splitTurn(ids.slice(1), 2), /inclusive|Selection/)
  data.idle = false
  await assert.rejects(controller.splitTurn(ids, 2), /idle/)
  data.idle = true
  data.session.revert = { messageID: "batch_4" }
  await assert.rejects(controller.splitTurn(ids, 2), /undo\/unrevert/)
  delete data.session.revert
  const observer = new Controller({ ...host, readOnly: true }, data.session.id, controller.config, storage)
  await assert.rejects(observer.splitTurn(ids, 2), /read-only/)
  assert.equal(readPolicy(data.session).revision, 0)
})

test("protected active turns allow only validated structural no-content writes", async t => {
  const { host, data, controller, ids } = await controllerFixture(t)
  host.auto = {
    state: async () => ({ strategy: "MANUAL", pause: { id: "pause", userID: "user", protectedIDs: ids, phase: "manual", tokens: 1, threshold: 1, inputLimit: 1, derived: false, message: "paused" } }),
    command: async () => ({ strategy: "MANUAL" }), commit: async () => {},
  }
  assert.equal(await controller.splitTurn(ids, 2), 2)
  const loaded = await controller.load()
  const expected = { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }
  const structural = { ...operation("partition", loaded.blocks), cuts: [] }
  await assert.rejects(controller.applyOperations([{ ...structural, summary: "FORGED_CONTENT" }], expected), /content|partitions/)
  await assert.rejects(controller.applyOperations([operation("prune-reason", loaded.blocks)], expected), /protected/)
  assert.equal(readPolicy(data.session).revision, 1)
  await controller.mergeSubturns(ids)
  assert.equal(readPolicy(data.session).revision, 2)
})

for (const change of ["source", "revision", "revert", "busy"] as const) test(`structural commit rechecks ${change} at the final write`, async t => {
  const { host, data, controller, ids } = await controllerFixture(t)
  const loaded = await controller.load()
  const op = splitOperation(loaded.blocks[0], 2, loaded.tokenizer, controller.config.subturns).operation
  const read = host.session
  let calls = 0
  host.session = async (...args) => {
    if (++calls === 2) {
      if (change === "source") data.messages[0].parts = []
      if (change === "revision") data.session.metadata = { ...data.session.metadata, opencode_context_manager: append(loaded.policy, { ...op, id: "racing" }) }
      if (change === "revert") data.session.revert = { messageID: ids[0] }
      if (change === "busy") data.idle = false
    }
    return read(...args)
  }
  if (change === "busy") {
    const idle = host.idle
    let reads = 0
    host.idle = async id => { if (++reads === 2) data.idle = false; return idle(id) }
  }
  await assert.rejects(controller.applyOperations([op], { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }), /changed|undo\/unrevert|idle/)
  assert.equal(readPolicy(data.session).operations.some(saved => saved.id === op.id), false)
})

test("source payload changes remain rejected after a structural-only ledger", () => {
  const f = fixture()
  f.partition()
  const changed = structuredClone(f.raw)
  changed[1].parts = []
  assert.notEqual(historyHash(changed), historyHash(f.raw))
  assert.throws(() => project(changed, f.policy), /content changed/)
  assert.throws(() => projectRequest(f.native, changed, f.canonical, f.policy), /content changed/)
})

test("new partition admission rejects forged basis, source count, small source and actual undersized parts", () => {
  const f = fixture()
  const selected = f.blocks()
  const op = { ...operation("partition", selected), cuts: ["batch_0"] }
  const low = { minTokens: 1, minSplitTokens: 2 }
  validatePartition(op, selected, FALLBACK_BASIS, low)
  assert.throws(() => validatePartition({ ...op, tokenizer: { ...FALLBACK_BASIS, source: "configured override" } }, selected, FALLBACK_BASIS, low), /main-session token basis/)
  assert.throws(() => validatePartition({ ...op, beforeTokens: 1 }, selected, FALLBACK_BASIS, low), /source size/)
  assert.throws(() => validatePartition(op, selected, FALLBACK_BASIS, { minTokens: 1, minSplitTokens: op.beforeTokens + 1 }), /at least/)
  const minimum = Math.floor(op.beforeTokens / 3)
  assert.throws(() => validatePartition(op, selected, FALLBACK_BASIS, { minTokens: minimum, minSplitTokens: 2 }), /Each new subturn/)
  assert.throws(() => validatePartition({ ...op, cuts: ["user"] }, selected, FALLBACK_BASIS, low), /native assistant/)
  f.save(op)
  assert.equal(f.blocks().length, 2)
  const merge = { ...operation("partition", f.blocks()), cuts: [] }
  validatePartition(merge, f.blocks(), FALLBACK_BASIS, { minTokens: 100_000, minSplitTokens: 500_000 })
  f.save(merge)
  assert.deepEqual(blockMessages(f.blocks()), f.raw)
})

test("Controller rejects crafted split below configured minima while replay remains independent", async t => {
  const { host, data, storage, controller, ids } = await controllerFixture(t)
  const strict = new Controller(host, data.session.id, settings(), storage)
  t.after(() => strict.dispose())
  const loaded = await strict.load()
  const forged = { ...operation("partition", loaded.blocks, undefined, loaded.tokenizer), cuts: ["batch_0"] }
  await assert.rejects(strict.applyOperations([forged], { revision: loaded.policy.revision, fingerprint: loaded.fingerprint }), /at least/)
  assert.equal(readPolicy(data.session).revision, 0)
  await controller.splitTurn(ids, 2)
  assert.equal((await strict.load()).blocks.length, 2)
  await strict.mergeSubturns(ids)
  assert.equal((await strict.load()).blocks.length, 1)
})

test("mixed structural ledgers retain topology and exact leaf restoration across cold replay and clipped prefixes", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const f = fixture()
    let state = seed
    const choose = (size: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % size }
    f.partition(["batch_0", "batch_1", "batch_2", "batch_3"])
    for (let step = 0; step < 18; step++) {
      const blocks = f.blocks()
      const index = choose(blocks.length)
      const block = blocks[index]
      switch (choose(6)) {
        case 0: {
          if (block.kind !== "turn") break
          f.save(operation(choose(2) ? "prune-reason" : "tool-prune-all", [block]))
          break
        }
        case 1: {
          const next = blocks[index + 1]
          if (block.kind === "turn" && next?.kind === "turn") f.save({ ...operation("partition", [block, next]), cuts: [] })
          break
        }
        case 2: {
          if (block.kind !== "turn") break
          const cuts = block.sourceIDs.slice(0, -1).filter(id => id.startsWith("batch_"))
          if (cuts.length) f.save({ ...operation("partition", [block]), cuts: [cuts[choose(cuts.length)]] })
          break
        }
        case 3: {
          if (summaryRangeStart([block])) f.save({ ...operation("brief", [block]), summary: `FACT_${seed}_${step}` })
          break
        }
        case 4: {
          if (block.kind !== "deleted") f.save(operation("delete", [block]))
          break
        }
        case 5: {
          const op = operation("expand", [block])
          if (op.pruneTargets?.length || op.summaryIDs?.length || op.deletedIDs?.length) f.save(op)
          break
        }
      }
    }
    const original = rememberPolicy(f.raw, f.policy)
    const identity = new Map(f.raw.map(message => [message.info.id, message.info.id]))
    const retained = retainPolicy(f.raw, f.blocks(), original, identity, f.session.id)
    assert.deepEqual(project(f.raw, retained).map(block => block.sourceIDs), f.blocks().map(block => block.sourceIDs), `topology ${seed}`)
    const comparable = (messages: Message[]) => messages.map(message => ({ ...message, ...(message.id?.startsWith("msg_cm_") ? { id: "remapped-summary" } : {}) }))
    assert.deepEqual(comparable(projectRequest(f.native, f.raw, f.canonical, retained)), comparable(projectRequest(f.native, f.raw, f.canonical, original)), `canonical ${seed}`)
    for (const boundary of f.raw.slice(1)) {
      const prefix = f.raw.slice(0, f.raw.indexOf(boundary))
      let policy = revertPolicy(prefix, original)
      assert.deepEqual(policy, revertPolicy(f.raw, original, boundary.info.id), `revert ${seed}/${boundary.info.id}`)
      for (let layer = 0; layer < 30; layer++) {
        const blocks = project(prefix, policy)
        const op = operation("expand", blocks)
        if (!op.summaryIDs?.length && !op.deletedIDs?.length && !op.pruneTargets?.length) break
        policy = append(policy, op)
      }
      assert.deepEqual(blockMessages(project(prefix, policy)), prefix, `restore ${seed}/${boundary.info.id}`)
    }
  }
})
