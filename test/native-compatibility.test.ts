import { test } from "node:test"
import assert from "node:assert/strict"
import type { SessionMessageInfo } from "@opencode/client"
import { activeMessages, append, emptyPolicy, hash, historyHash, operation, project } from "../src/context.ts"
import { transcriptView } from "../src/normalize.ts"
import { validateNativePolicy } from "../src/projection.ts"
import { nativeFixture } from "./native-fixtures.ts"

test("current native provider data preserves frozen saved fingerprints without old-host DTOs", () => {
  const { session, native } = nativeFixture()
  for (const message of native) if (message.type === "assistant") {
    message.native = { step: "proof" }
    for (const part of message.content) {
      part.native = part.type === "tool" ? { call: "proof" } : { signature: part.text }
    }
  }
  const before = hash(native)
  const raw = transcriptView(session, native)
  const savedHash = "60356252708aed99f19a8e7b4e07eca0fd5fc7dea3c90d9bc69aad408150a1ad"
  assert.equal(historyHash(activeMessages(raw)), savedHash)
  const selected = project(activeMessages(raw), emptyPolicy(session.id))
  const policy = append(emptyPolicy(session.id), { ...operation("compact", selected), beforeHash: savedHash, summary: "Saved summary" })
  assert.equal(project(activeMessages(raw), policy)[0].kind, "compact")
  const part = native.find(message => message.type === "assistant")!.content[0]
  const metadata = part.native
  part.native = { signature: "changed" }
  assert.throws(() => project(activeMessages(transcriptView(session, native)), policy), /content changed/)
  part.native = metadata
  assert.equal(hash(native), before)
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
  const tool = native.find(message => message.type === "assistant")!.content.find(part => part.type === "tool")!
  tool.native = { proof: "call", result: "opaque" }
  const raw = transcriptView(session, native)
  const policy = append(emptyPolicy(session.id), { ...operation("compact", project(activeMessages(raw), emptyPolicy(session.id))), beforeHash: "f9a89eee94503fde7266246a14747f6ebc81a0fc24c823b539dc3374ef93e442", summary: "Saved" })
  const saved = hash(policy)
  assert.throws(() => project(activeMessages(raw), policy), /content changed/)
  Object.assign(tool, { providerState: { proof: "call" }, providerResultState: { result: "opaque" } })
  assert.throws(() => project(activeMessages(transcriptView(session, native)), policy), /content changed/)
  assert.equal(hash(policy), saved)
})

test("obsolete host fields are not interpreted as current native metadata", () => {
  const { session, native } = nativeFixture()
  const assistant = native.find(message => message.type === "assistant")!
  for (const part of assistant.content) {
    delete part.native
    Object.assign(part, part.type === "tool" ? { providerState: { obsolete: true } } : { state: { obsolete: true } })
  }
  const checkpoint: SessionMessageInfo = { id: "msg_checkpoint", type: "compaction", status: "completed", reason: "manual", summary: "SUMMARY", metadata: { recent: "CURRENT" }, time: { created: 1 } }
  Object.assign(checkpoint, { recent: "OBSOLETE" })
  const raw = transcriptView(session, [assistant, checkpoint])
  assert.ok(raw[0].parts.every(part => !("metadata" in part)))
  assert.equal(raw[1].parts[0].type === "context" && raw[1].parts[0].text, "SUMMARY\nCURRENT")
})
