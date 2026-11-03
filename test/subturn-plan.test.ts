import assert from "node:assert/strict"
import { test } from "node:test"
import { contentTokens } from "../src/metrics.ts"
import { effectiveMessages, type AssistantMessage, type Envelope, type ToolPart } from "../src/model.ts"
import { planSubturns } from "../src/subturn-plan.ts"
import { FALLBACK_BASIS, type TokenBasis } from "../src/tokens.ts"

function batch(id: string, ...sizes: number[]): Envelope & { info: AssistantMessage } {
  const sessionID = "ses_plan"
  return {
    info: {
      id, sessionID, role: "assistant", kind: "assistant", agent: "build", providerID: "test", modelID: "main",
      time: { created: 0, completed: 1 }, finish: "tool-calls", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: sizes.map((size, index): ToolPart => ({
      id: `${id}_part_${index}`, sessionID, messageID: id, type: "tool", callID: `${id}_call_${index}`, tool: "read",
      state: { status: "completed", input: {}, output: " x".repeat(size - 1), metadata: {}, time: { start: 0, end: 1 } },
    })),
  }
}

function text(id: string, tokens: number, completed = true) {
  const message = batch(id)
  message.parts = [{ id: `${id}_text`, sessionID: message.info.sessionID, messageID: id, type: "text", text: " x".repeat(tokens) }]
  message.info.finish = "stop"
  if (!completed) delete message.info.time.completed
  return message
}

function source(...sizes: number[]): Envelope[] {
  const user: Envelope = {
    info: { id: "user", sessionID: "ses_plan", role: "user", kind: "user", agent: "build", time: { created: 0 }, model: { providerID: "test", modelID: "main" } },
    parts: [],
  }
  return [user, ...sizes.map((size, index) => batch(`batch_${index}`, size))]
}

function check(messages: Envelope[], requested: number, minimum: number, minimumSource: number, basis: TokenBasis = FALLBACK_BASIS) {
  const before = structuredClone({ messages, basis })
  const plan = planSubturns(messages, requested, basis, minimum, minimumSource)
  const actual: number[] = []
  let start = 0
  for (const id of plan.ends) {
    const index = messages.findIndex(message => message.info.id === id)
    assert.ok(index >= start && index < messages.length - 1)
    const message = messages[index]
    assert.equal(message.info.kind, "assistant")
    assert.equal(message.info.role, "assistant")
    assert.notEqual(message.info.time.completed, undefined)
    assert.ok(message.parts.some(part => part.type === "tool"))
    assert.ok(message.parts.every(part => part.type !== "tool" || part.state.status === "completed" || part.state.status === "error"))
    actual.push(contentTokens(messages.slice(start, index + 1), basis))
    start = index + 1
  }
  actual.push(contentTokens(messages.slice(start), basis))
  assert.deepEqual(plan.sizes, actual)
  assert.ok(actual.length >= 2 && actual.length <= requested)
  assert.ok(actual.every(size => size >= minimum))
  assert.equal(actual.reduce((sum, size) => sum + size, 0), contentTokens(messages, basis))
  assert.deepEqual({ messages, basis }, before)
  return plan
}

test("equal batches produce balanced whole-message subturns and internal endpoints only", () => {
  assert.deepEqual(check(source(100, 100, 100, 100, 100, 100), 3, 100, 600), {
    ends: ["batch_1", "batch_3"], sizes: [200, 200, 200],
  })
})

test("unequal batches balance by content tokens rather than message count", () => {
  assert.deepEqual(check(source(20, 80, 15, 85, 35, 65), 3, 100, 300), {
    ends: ["batch_1", "batch_3"], sizes: [100, 100, 100],
  })
  assert.deepEqual(check(source(10, 10, 10, 70, 100), 2, 50, 200), {
    ends: ["batch_3"], sizes: [100, 100],
  })
})

test("balancing preserves feasible minimum-sized suffixes instead of choosing a dead end", () => {
  assert.deepEqual(check(source(60, 30, 30, 120), 3, 60, 240), {
    ends: ["batch_0", "batch_2"], sizes: [60, 60, 120],
  })
})

test("requested count reduces to the largest feasible count", () => {
  assert.deepEqual(check(source(80, 20, 80, 20, 80, 20), 10, 100, 300), {
    ends: ["batch_1", "batch_3"], sizes: [100, 100, 100],
  })
  assert.deepEqual(check(source(100, 100, 100, 100), Number.MAX_SAFE_INTEGER, 100, 400).sizes, [100, 100, 100, 100])
  assert.throws(() => planSubturns(source(70, 70, 70), 2, FALLBACK_BASIS, 100, 200), /Cannot split into two/)
})

test("source and newly created part minimums are inclusive", () => {
  const messages = source(100, 100)
  assert.deepEqual(check(messages, 2, 100, 200).sizes, [100, 100])
  assert.throws(() => planSubturns(messages, 2, FALLBACK_BASIS, 100, 201), /200 content tokens; at least 201/)
  assert.throws(() => planSubturns(messages, 2, FALLBACK_BASIS, 101, 200), /at least 101/)
  assert.throws(() => planSubturns([], 2, FALLBACK_BASIS, 1, 1), /0 content tokens/)
})

test("invalid counts and minimums refuse before planning", () => {
  for (const requested of [0, 1, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => planSubturns(source(100, 100), requested, FALLBACK_BASIS, 1, 1), /count must be a safe integer/)
  for (const minimum of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => planSubturns(source(100, 100), 2, FALLBACK_BASIS, minimum, 1), /Minimum subturn tokens/)
    assert.throws(() => planSubturns(source(100, 100), 2, FALLBACK_BASIS, 1, minimum), /Minimum split source tokens/)
  }
})

test("a huge indivisible message cannot rescue a tiny remainder and no maximum is enforced", () => {
  assert.throws(() => planSubturns(source(200000, 10), 100, FALLBACK_BASIS, 100, 200), /Cannot split into two/)
  assert.deepEqual(check(source(200000, 100), 100, 100, 200).sizes, [200000, 100])
  assert.throws(() => planSubturns(source(200000), 2, FALLBACK_BASIS, 100, 200), /Cannot split into two/)
})

test("failed terminal tools are valid boundaries", () => {
  const failed = batch("failed", 100)
  const part = failed.parts[0] as ToolPart
  part.state = { status: "error", input: {}, error: " x".repeat(99) }
  assert.deepEqual(check([failed, batch("after", 100)], 2, 100, 200), { ends: ["failed"], sizes: [100, 100] })
})

test("multi-call assistant messages remain atomic including text, reasoning and attachments", () => {
  const first = batch("multi", 40, 60)
  first.parts.push(
    { id: "reason", sessionID: "ses_plan", messageID: "multi", type: "reasoning", text: " x".repeat(10) },
    { id: "text", sessionID: "ses_plan", messageID: "multi", type: "text", text: " x".repeat(20) },
    { id: "file", sessionID: "ses_plan", messageID: "multi", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
  )
  assert.deepEqual(check([first, batch("after", 130)], 4, 40, 260), { ends: ["multi"], sizes: [130, 130] })
})

test("pending and running tools anywhere in the source refuse even if other cuts are feasible", () => {
  for (const status of ["pending", "running"] as const) for (const index of [0, 1, 2]) {
    const messages = [batch("first", 100), batch("middle", 100, 100), batch("last", 100)]
    const part = messages[index].parts.at(-1) as ToolPart
    part.state = { status, input: {} }
    const before = structuredClone(messages)
    assert.throws(() => planSubturns(messages, 2, FALLBACK_BASIS, 1, 1), /pending or running tool calls/)
    assert.deepEqual(messages, before)
  }
})

test("an unfinished tool-free final assistant stays intact in the last part", () => {
  const messages = [batch("first", 100), batch("second", 60), text("unfinished", 40, false)]
  assert.deepEqual(check(messages, 3, 100, 200), { ends: ["first"], sizes: [100, 100] })
  assert.deepEqual(check([batch("first", 100), text("unfinished", 100, false)], 2, 100, 200), { ends: ["first"], sizes: [100, 100] })
})

test("completed text-only assistants and unfinished tool assistants are not cut positions", () => {
  const unfinished = batch("unfinished", 100)
  delete unfinished.info.time.completed
  assert.throws(() => planSubturns([unfinished, text("tail", 100)], 2, FALLBACK_BASIS, 1, 1), /completed native tool-batch boundaries/)
  assert.deepEqual(check([text("plain", 100), batch("tools", 100), text("tail", 100)], 3, 100, 300), { ends: ["tools"], sizes: [200, 100] })
  const completedAtZero = batch("zero", 100)
  completedAtZero.info.time.completed = 0
  assert.deepEqual(check([completedAtZero, text("tail", 100)], 2, 100, 200).ends, ["zero"])
})

test("only native-kind assistants can supply internal tool-batch boundaries", () => {
  for (const kind of ["synthetic", "skill", "shell", "system", "idle", "user"] as const) {
    const other = batch("other", 100)
    other.info.kind = kind
    if (kind === "shell") other.info.shell = { settled: true, background: false }
    assert.deepEqual(check([other, batch("native", 100), batch("last", 100)], 3, 100, 300), { ends: ["native"], sizes: [200, 100] })
  }
  const messages = source(100, 100)
  messages[0].parts = batch("user", 100).parts
  assert.deepEqual(check(messages, 3, 100, 300), { ends: ["batch_0"], sizes: [200, 100] })
})

test("native checkpoints and unsettled shells refuse throughout selected sources", () => {
  for (const kind of ["compaction", "shell"] as const) for (const index of [0, 1, 2]) {
    const messages = [batch("first", 100), batch("middle", 100), batch("last", 100)]
    messages[index].info.kind = kind
    if (kind === "shell") messages[index].info.shell = { settled: false, background: true }
    assert.throws(() => planSubturns(messages, 2, FALLBACK_BASIS, 1, 1), kind === "compaction" ? /native checkpoint or compaction/ : /unsettled shell/)
  }
  const unknownShell = batch("shell", 100)
  unknownShell.info.kind = "shell"
  assert.throws(() => planSubturns([batch("before", 100), unknownShell], 2, FALLBACK_BASIS, 1, 1), /unsettled shell/)
})

test("effective reasoning visibility controls minimums and partition sizes", () => {
  const first = batch("first", 50)
  first.parts.push({ id: "reason", sessionID: "ses_plan", messageID: "first", type: "reasoning", text: " x".repeat(1000) })
  const messages = [first, batch("last", 100)]
  assert.deepEqual(check(messages, 2, 100, 200).sizes, [1050, 100])
  first.info.omitReasoning = true
  first.info.retainReasoning = true
  assert.throws(() => planSubturns(messages, 2, FALLBACK_BASIS, 50, 200), /150 content tokens/)
  assert.throws(() => planSubturns(messages, 2, FALLBACK_BASIS, 100, 150), /Cannot split into two/)
  assert.deepEqual(check(messages, 2, 50, 150), check(effectiveMessages(messages), 2, 50, 150))
})

test("planning uses current pruned content without retaining a minimum invariant after split time", () => {
  const messages = source(500, 500)
  const plan = check(messages, 2, 500, 1000)
  const pruned = messages.map(message => ({ ...message, parts: message.parts.map(part => part.type === "tool" && part.state.status === "completed"
    ? { ...part, state: { ...part.state, output: " x".repeat(49) } } : part) }))
  assert.equal(contentTokens(pruned), 100)
  assert.deepEqual(plan, { ends: ["batch_0"], sizes: [500, 500] })
  assert.deepEqual(check(pruned, 2, 50, 100), { ends: ["batch_0"], sizes: [50, 50] })
  assert.throws(() => planSubturns(pruned, 2, FALLBACK_BASIS, 500, 100), /Cannot split into two/)
  const deletedTools = pruned.map(message => ({ ...message, parts: message.parts.filter(part => part.type !== "tool") }))
  assert.throws(() => planSubturns(deletedTools, 2, FALLBACK_BASIS, 1, 1), /0 content tokens/)
})

test("supplied main encoding and pinned tokenizer library drive all measurements", () => {
  const first = batch("first", 1)
  const last = batch("last", 1)
  for (const message of [first, last]) message.parts.push({
    id: `${message.info.id}_text`, sessionID: "ses_plan", messageID: message.info.id, type: "text", text: "alpha\u0085beta\uFEFFgamma 😀\n".repeat(20),
  })
  const messages = [first, last]
  const totals = new Set<number>()
  for (const encoding of ["o200k_base", "cl100k_base"] as const) for (const library of ["gpt-tokenizer@4.0.0", "gpt-tokenizer@4.1.0"] as const) {
    const basis: TokenBasis = { ...FALLBACK_BASIS, encoding, library, source: "configured override", providerID: "main", modelID: "chosen" }
    const minimum = contentTokens([first], basis)
    totals.add(minimum)
    assert.deepEqual(check(messages, 2, minimum, minimum * 2, basis).sizes, [minimum, minimum])
    assert.throws(() => planSubturns(messages, 2, basis, minimum + 1, minimum * 2), /Cannot split into two/)
  }
  assert.ok(totals.size > 1)
})

test("already split assistant-only subturns need no original user and frozen inputs stay unchanged", () => {
  const messages = source(100, 100, 100, 100).slice(3)
  const basis = { ...FALLBACK_BASIS }
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    Object.freeze(value)
    for (const nested of Object.values(value)) freeze(nested)
  }
  freeze(messages)
  freeze(basis)
  assert.deepEqual(check(messages, 5, 100, 200, basis), { ends: ["batch_2"], sizes: [100, 100] })
})

test("many boundaries with an enormous requested count use only source-sized work", () => {
  const messages = Array.from({ length: 10000 }, (_, index) => batch(`batch_${index}`, 3))
  const plan = planSubturns(messages, Number.MAX_SAFE_INTEGER, FALLBACK_BASIS, 3, 1)
  assert.equal(plan.ends.length, messages.length - 1)
  assert.equal(plan.ends.at(-1), "batch_9998")
  assert.ok(plan.sizes.every(size => size === 3))
})

test("small exhaustive partitions agree with the maximum feasible count", () => {
  for (let code = 0; code < 81; code++) {
    let digits = code
    const weights = Array.from({ length: 4 }, () => {
      const size = [1, 4, 7][digits % 3]
      digits = Math.floor(digits / 3)
      return size
    })
    const messages = source(...weights)
    for (const minimum of [1, 5, 8]) {
      let feasible = 1
      for (let mask = 1; mask < 8; mask++) {
        const sizes = [0]
        for (const [index, weight] of weights.entries()) {
          sizes[sizes.length - 1] += weight
          if (mask & (1 << index)) sizes.push(0)
        }
        if (sizes.every(size => size >= minimum)) feasible = Math.max(feasible, sizes.length)
      }
      for (const requested of [2, 3, 5, Number.MAX_SAFE_INTEGER]) {
        if (feasible < 2) assert.throws(() => planSubturns(messages, requested, FALLBACK_BASIS, minimum, 1), /Cannot split into two/)
        else assert.equal(check(messages, requested, minimum, 1).sizes.length, Math.min(feasible, requested))
      }
    }
  }
})
