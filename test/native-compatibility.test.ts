import { test } from "node:test"
import assert from "node:assert/strict"
import type { SessionMessageInfo } from "@opencode/client"
import { activeMessages, append, emptyPolicy, hash, historyHash, operation, project } from "../src/context.ts"
import { transcriptView } from "../src/normalize.ts"
import { validateNativePolicy } from "../src/projection.ts"
import { nativeFixture } from "./native-fixtures.ts"

test("native provider-data renames preserve legacy source fingerprints and saved reductions", () => {
  const { session, native } = nativeFixture()
  const legacy = JSON.parse(JSON.stringify(native))
  const modern = JSON.parse(JSON.stringify(native))
  for (const message of legacy) if (message.type === "assistant") {
    message.providerState = { step: "proof" }
    for (const part of message.content) {
      if (part.type === "tool") part.providerState = { call: "proof" }
      else { part.state = { signature: part.text }; delete part.native }
    }
  }
  for (let i = 0; i < modern.length; i++) {
    const message = modern[i] = structuredClone(legacy[i])
    if (message.type !== "assistant") continue
    message.native = message.providerState; delete message.providerState
    for (const part of message.content) {
      const key = part.type === "tool" ? "providerState" : "state"
      part.native = part[key]; delete part[key]
    }
  }
  const before = hash([legacy, modern])
  const raw = transcriptView(session, legacy)
  const current = transcriptView(session, modern)
  assert.equal(historyHash(current), historyHash(raw))
  const selected = project(activeMessages(raw), emptyPolicy(session.id))
  const policy = append(emptyPolicy(session.id), { ...operation("compact", selected), summary: "Saved summary" })
  assert.deepEqual(project(activeMessages(current), policy), project(activeMessages(raw), policy))
  modern.find((message: { type: string }) => message.type === "assistant").content[0].native.signature = "changed"
  assert.throws(() => project(activeMessages(transcriptView(session, modern)), policy), /content changed/)
  modern.find((message: { type: string }) => message.type === "assistant").content[0].native.signature = legacy.find((message: { type: string }) => message.type === "assistant").content[0].state.signature
  assert.equal(hash([legacy, modern]), before)
})

test("provider-executed native tool state remains guarded before a pruning write", () => {
  const { session, native } = nativeFixture()
  const assistant = native.find(message => message.type === "assistant")!
  const tool = assistant.content.find(part => part.type === "tool")!
  tool.executed = true
  tool.native = { opaque: "hosted-result" }
  const raw = transcriptView(session, native)
  const policy = append(emptyPolicy(session.id), operation("tool-prune-all", project(activeMessages(raw), emptyPolicy(session.id))))
  assert.throws(() => validateNativePolicy(native, raw, policy), /Opaque provider-executed/)
})

test("current native checkpoint recent context is readable but not editable", () => {
  const { session } = nativeFixture()
  const checkpoint: SessionMessageInfo = { id: "msg_checkpoint", type: "compaction", status: "completed", reason: "manual", summary: "SUMMARY", metadata: { recent: "KEPT" }, time: { created: 1 } }
  const raw = transcriptView(session, [checkpoint])
  assert.equal(raw[0].parts[0].type === "context" && raw[0].parts[0].text, "SUMMARY\nKEPT")
  const policy = append(emptyPolicy(session.id), operation("prune-reason", project(raw, emptyPolicy(session.id))))
  assert.throws(() => validateNativePolicy([checkpoint], raw, policy), /checkpoints are read-only/)
})

test("lossy tool-state merges and conflicting legacy aliases cannot bypass saved fingerprints", () => {
  const { session, native } = nativeFixture()
  const legacy = JSON.parse(JSON.stringify(native))
  const tool = legacy.find((message: { type: string }) => message.type === "assistant").content.find((part: { type: string }) => part.type === "tool")
  tool.providerState = { proof: "call" }
  tool.providerResultState = { result: "opaque" }
  const raw = transcriptView(session, legacy)
  const policy = append(emptyPolicy(session.id), { ...operation("compact", project(activeMessages(raw), emptyPolicy(session.id))), summary: "Saved" })
  const saved = hash(policy)
  tool.native = { ...tool.providerState, ...tool.providerResultState }
  delete tool.providerState
  delete tool.providerResultState
  assert.throws(() => project(activeMessages(transcriptView(session, legacy)), policy), /content changed/)
  tool.providerState = { proof: "call" }
  tool.providerResultState = { result: "opaque" }
  assert.throws(() => project(activeMessages(transcriptView(session, legacy)), policy), /content changed/)
  assert.equal(hash(policy), saved)
})
