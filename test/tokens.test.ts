import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { settings, KEY } from "../src/config.ts"
import { bindPruneRule, pruneText } from "../src/text.ts"
import { FALLBACK_BASIS, TOKENIZER_ID, tokenBasis, tokenCount, tokenEdges, type Encoding } from "../src/tokens.ts"
import { contentTokens, distribution, lastReportedUsage } from "../src/metrics.ts"
import { append, blockMessages, emptyPolicy, operation, project, readPolicy, replacementTokens, select, serialize, turns } from "../src/context.ts"
import { generateSummary, inputEstimate, SUMMARIZER_SYSTEM } from "../src/summarize.ts"
import { Controller } from "../src/controller.ts"
import { Storage } from "../src/storage.ts"
import { snapshot } from "../src/snapshot.ts"
import { fixtureHost, messages, model, pruneRule, session } from "./fixtures.ts"

test("tokenizer settings reject unknown encodings", () => {
  assert.throws(() => settings({ tokenizer: { fallbackEncoding: "invented" } }), /encoding|Encoding/)
  assert.throws(() => settings({ tokenizer: { overrides: { "bad/model": "invented" } } }), /overrides/)
})

test("local tokenization treats special-token-looking text literally and resolves aliases without pretending unknown models are mapped", () => {
  assert.equal(tokenCount(""), 0)
  assert.equal(tokenCount("Hello, world!"), 4)
  assert.ok(tokenCount("<|endoftext|>") > 1)
  assert.equal(tokenCount("x".repeat(10000)), 1250)
  const base = model()
  const alias = { ...base, providerID: "openai", id: "my-alias", api: { ...base.api, id: "gpt-4o" } }
  assert.equal(tokenBasis({ providerID: "openai", modelID: "my-alias" }, alias, settings().tokenizer).source, "model-name mapping")
  const unknown = tokenBasis({ providerID: "fixture", modelID: "unmapped-model" }, undefined, settings().tokenizer)
  assert.equal(unknown.source, "fallback")
  assert.equal(unknown.encoding, "o200k_base")
  const configured = settings({ tokenizer: { overrides: { "fixture/unmapped-model": "cl100k_base" } } })
  assert.equal(tokenBasis({ providerID: "fixture", modelID: "unmapped-model" }, undefined, configured.tokenizer).source, "configured override")
  assert.equal(tokenBasis({ providerID: "fixture", modelID: "unmapped-model" }, undefined, configured.tokenizer).encoding, "cl100k_base")
})

test("token-budgeted ends retain original Unicode substrings without broken surrogates or introduced replacement characters", () => {
  for (const encoding of ["o200k_base", "cl100k_base"] as Encoding[]) for (const budget of [0, 1, 2, 5, 17, 64]) {
    const text = "😀世界🌍 Привет café 家庭ABC0123__\n".repeat(100)
    const ends = tokenEdges(text, budget, budget, encoding)
    assert.ok(text.startsWith(ends.head) && text.endsWith(ends.tail))
    assert.doesNotThrow(() => encodeURIComponent(ends.head + ends.tail))
    assert.ok(!ends.head.includes("�") && !ends.tail.includes("�"))
    assert.ok(tokenCount(ends.head, encoding) <= budget)
    assert.ok(tokenCount(ends.tail, encoding) <= budget)
    assert.ok(ends.separated)
  }
  const replacement = tokenEdges("� is original text " + "😀界".repeat(100), 10, 10, "o200k_base")
  assert.ok(replacement.head.startsWith("�"), "Do not strip a genuine replacement character from original text")
})

test("token pruning has a strict token threshold, bounded head/tail and net savings including notice/link", () => {
  const text = "HEAD! " + "abc0123!? 😀世界\n".repeat(300) + " TAIL!"
  const count = tokenCount(text)
  const exact = bindPruneRule({ threshold: count, head: 50, tail: 50 }, FALLBACK_BASIS)
  assert.equal(pruneText(text, exact), text)
  const result = pruneText(text, { ...exact, threshold: count - 1 }, "/fixture/full.txt")
  const ends = tokenEdges(text, 50, 50, "o200k_base")
  assert.ok(result.startsWith(ends.head))
  assert.ok(result.includes(ends.tail))
  assert.ok(result.includes("[Full output: /fixture/full.txt]"))
  assert.ok(result.includes("tokens (o200k_base)"))
  assert.doesNotThrow(() => encodeURIComponent(result))
  assert.ok(!result.includes("�"))
  assert.ok(tokenCount(result) < count)
  const tooSmall = bindPruneRule({ threshold: 1, head: 0, tail: 0 }, FALLBACK_BASIS)
  assert.equal(pruneText("alpha beta", tooSmall), "alpha beta", "Do not grow a result just to add an omission notice")
})

test("main-context token counts ignore inspector IDs/labels, exclude media and keep skill attribution disjoint", () => {
  const raw = messages()
  const before = contentTokens(raw)
  const renamed = structuredClone(raw)
  renamed[0].info.id = "msg_" + "inspection_identifier_".repeat(1000)
  assert.equal(contentTokens(renamed), before)
  assert.notEqual(tokenCount(serialize(renamed)), tokenCount(serialize(raw)))
  const attachment = { type: "file" as const, id: "file", sessionID: "ses_test", messageID: raw[0].info.id, mime: "image/png", url: "data:image/png;base64," + "A".repeat(50000) }
  raw[0].parts.push(attachment)
  const data = distribution(turns(raw))
  assert.equal(data.total, before)
  assert.equal(data.attachments, 1)
  assert.equal(data.attachmentTokens, null)
  assert.equal(data.providerOverheadTokens, null)
  assert.equal(data.requestOverheadIncluded, false)
  assert.ok(data.counts.loadedSkills > 0)
  assert.equal(data.total, Object.values(data.counts).reduce((sum, n) => sum + n, 0))
})

test("compaction accepts a character-long draft that fits the token half-size limit", async () => {
  const blocks = turns(messages())
  const selected = select(blocks, 0, 0)
  const op = operation("compact", selected)
  let calls = 0
  const result = await generateSummary(op, blocks, selected, async () => { calls++; return "x".repeat(8000) })
  assert.ok(result.operation.summary!.length > op.beforeChars / 2)
  assert.ok(replacementTokens(result.operation, selected) <= op.beforeTokens! / 2)
  assert.equal(calls, 1)
})

test("compaction retries a character-short draft when it exceeds the token half-size limit", async () => {
  const raw = messages()
  const tool = raw[1].parts[0]
  assert.ok(tool.type === "tool" && tool.state.status === "completed")
  tool.state.output = "x".repeat(10000)
  const blocks = turns(raw)
  const selected = select(blocks, 0, 0)
  const op = operation("compact", selected)
  const text = "abcd0123!?".repeat(250)
  const calls: string[] = []
  const result = await generateSummary(op, blocks, selected, async (prompt) => { calls.push(prompt); return text })
  assert.ok(text.length < op.beforeChars / 2)
  assert.ok(replacementTokens(result.operation, selected) > op.beforeTokens! / 2)
  assert.equal(calls.length, 2)
  assert.match(calls[1], /tokens/)
  assert.equal(result.attempts, 2)
})

test("helper input estimate includes the entire conversation, system and input-overhead margin", () => {
  const history = messages().map((message) => ({ ...message, parts: message.parts.filter((part) => part.type === "text") }))
  const prompt = "Привет 世界 😀".repeat(50)
  const basis = { ...FALLBACK_BASIS, encoding: "cl100k_base" as const }
  assert.equal(inputEstimate(prompt, basis, history), contentTokens(history, basis) + tokenCount(prompt, basis.encoding) + tokenCount(SUMMARIZER_SYSTEM, basis.encoding) + 2048)
  assert.ok(inputEstimate(prompt, basis, history) > inputEstimate(prompt, basis))
})

test("old character policies replay unchanged alongside token rules and remain undoable", () => {
  const raw = messages()
  const legacyRule = { threshold: 8000, head: 2000, tail: 2000 }
  const legacy = operation("tool-prune", select(turns(raw), 0, 0), legacyRule)
  delete legacy.beforeTokens
  delete legacy.tokenizer
  const old = { version: 2 as const, sessionID: "ses_test", revision: 1, cursor: 1, operations: [legacy] }
  assert.equal(readPolicy({ ...session(), metadata: { [KEY]: old } }).version, 2)
  const oldView = project(raw, old)
  assert.ok(serialize(oldView[0].messages).includes("characters omitted"))
  const tokenOp = operation("tool-prune", select(oldView, 1, 1), pruneRule())
  const next = append(old, tokenOp)
  assert.equal(next.version, 5)
  const view = project(raw, next)
  assert.deepEqual(view[0], oldView[0])
  assert.ok(serialize(view[1].messages).includes("tokens (o200k_base)"))
  assert.deepEqual(blockMessages(project(raw, { ...next, cursor: 1 })), blockMessages(oldView))
  assert.throws(() => readPolicy({ ...session(), metadata: { [KEY]: { ...next, version: 2 } } }), /token pruning/)
  const unsupported = structuredClone(next)
  if (unsupported.operations[1].rule?.unit === "tokens") (unsupported.operations[1].rule as { library: string }).library = "future-tokenizer"
  assert.throws(() => readPolicy({ ...session(), metadata: { [KEY]: unsupported } }), /token pruning/)
})

test("the main encoding drives operations while a different helper model is selected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-token-models-"))
  const { host, data } = fixtureHost()
  const other = { ...data.model, id: "other", providerID: "alternate" }
  host.models = async () => [data.model, other]
  const config = settings({ tokenizer: { overrides: { "test/model": "cl100k_base", "alternate/other": "o200k_base" } } })
  const controller = new Controller(host, data.session.id, config, new Storage(dir, dir))
  try {
    const loaded = await controller.load()
    assert.equal(loaded.tokenizer.encoding, "cl100k_base")
    const draft = await controller.summarize("brief", loaded.blocks[0].sourceIDs, { providerID: "alternate", modelID: "other" })
    assert.equal(draft.operation.tokenizer?.encoding, "cl100k_base")
    assert.equal(draft.model.providerID, "alternate")
    await controller.apply(draft, draft.operation.summary!)
    const current = await controller.load()
    await controller.prune(current.blocks[1].sourceIDs)
    const saved = readPolicy(data.session).operations.at(-1)!.rule
    assert.ok(saved?.unit === "tokens")
    assert.equal(saved.encoding, "cl100k_base")
    assert.equal(saved.library, TOKENIZER_ID)
    const beforeSwitch = (await controller.load()).blocks
    data.session.model = { id: "other", providerID: "alternate", variant: "default" }
    const switched = await controller.load()
    assert.equal(switched.tokenizer.encoding, "o200k_base")
    assert.deepEqual(switched.blocks, beforeSwitch, "Saved token rules must not change when the active model changes")
  } finally {
    await controller.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("historical usage is separate from the current token projection and exports identify uncertainty", () => {
  const raw = messages()
  const last = raw.at(-1)!.info
  assert.ok(last.role === "assistant")
  last.tokens = { input: 100, output: 20, reasoning: 30, cache: { read: 40, write: 50 } }
  const usage = lastReportedUsage(raw)
  assert.equal(usage?.total, 240)
  const policy = append(emptyPolicy("ses_test"), operation("tool-prune", turns(raw), pruneRule()))
  const dump = snapshot("ses_test", "1.18.33", project(raw, policy), policy, undefined, FALLBACK_BASIS, usage)
  assert.equal(dump.schemaVersion, 2)
  assert.equal(dump.distribution.unit, "estimated content tokens")
  assert.equal(dump.characterDistribution.unit, "Unicode characters")
  assert.equal(dump.lastReportedUsage?.total, 240)
  assert.ok(dump.warnings.some((text) => text.includes("fallback")))
  assert.equal(dump.tokenizer.library, TOKENIZER_ID)
})
