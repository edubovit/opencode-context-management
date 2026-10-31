import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import { activeMessages, append, blockMessages, emptyPolicy, historyHash, operation, project, serialize } from "../src/context.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest, validateNativePolicy } from "../src/projection.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { contentTokens } from "../src/metrics.ts"

for (const interrupted of [false, true]) test(`reasoning pruning retains the ${interrupted ? "interrupted" : "failed"} attempt but prunes its successful retry`, () => {
  const { session, native, canonical } = nativeFixture()
  const retry = native.find((message) => message.type === "assistant")!
  assert.equal(retry.type, "assistant")
  const failed = structuredClone(retry)
  failed.id = "msg_failed_attempt"
  failed.content = [{ type: "reasoning", text: "RETAIN_FAILED_REASONING", time: { created: 1, ...(interrupted ? {} : { completed: 2 }) } }, { type: "text", text: "RETAIN_FAILED_TEXT" }]
  if (!interrupted) failed.error = { type: "provider.transport", message: "Synthetic websocket failure" }
  native.splice(native.indexOf(retry), 0, failed)
  const incoming = Message.make({ id: failed.id, role: "assistant", content: [{ type: "text", text: "EARLIER_HOOK_REDACTED_REASONING" }, { type: "text", text: "RETAIN_FAILED_TEXT" }] })
  canonical.splice(canonical.findIndex((message) => message.id === retry.id), 0, incoming)
  const raw = transcriptView(session, native)
  const sourceHash = historyHash(raw)
  const legacy = structuredClone(raw)
  for (const message of legacy) if (message.info.role === "assistant") delete message.info.retainReasoning
  assert.equal(historyHash(legacy), sourceHash)
  const original = JSON.stringify({ native, raw, canonical })
  const empty = emptyPolicy(session.id)
  const policy = append(empty, operation("prune-reason", project(activeMessages(raw), empty)))
  validateNativePolicy(native, raw, policy)
  const blocks = project(activeMessages(raw), policy)
  assert.ok(blocks.every((block) => block.reasonPruned))
  const effective = blockMessages(blocks)
  assert.doesNotMatch(serialize(effective), /RETAIN_FAILED_REASONING/)
  assert.match(JSON.stringify(effective.find(message => message.info.id === failed.id)?.parts), /RETAIN_FAILED_REASONING/)
  assert.ok(effective.filter((message) => message.info.id !== failed.id).every((message) => message.parts.every((part) => part.type !== "reasoning")))
  assert.ok(contentTokens(effective, policy.operations[0].tokenizer) < contentTokens(activeMessages(raw), policy.operations[0].tokenizer))
  const output = projectRequest(native, raw, canonical, policy)
  assert.equal(output.find((message) => message.id === failed.id), incoming)
  assert.ok(output.every((message) => message.content.every((part) => part.type !== "reasoning")))
  const restored = append(policy, operation("expand", blocks))
  assert.deepEqual(projectRequest(native, raw, canonical, restored), canonical)
  assert.deepEqual(blockMessages(project(activeMessages(raw), restored)), activeMessages(raw))
  assert.equal(historyHash(raw), sourceHash)
  assert.equal(JSON.stringify({ native, raw, canonical }), original)
})
