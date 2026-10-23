import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import { activeMessages, append, emptyPolicy, historyHash, operation, project, summaryStart } from "../src/context.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest, validateNativePolicy } from "../src/projection.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { rangePreview } from "../src/range-rows.ts"
import { turnView } from "../src/turn-view.ts"

for (const background of [false, true]) test(`settled shell-led summary and exact restoration (background=${background})`, () => {
  const { session, native, canonical } = nativeFixture()
  const shell = { id: "msg_shell", type: "shell" as const, shellID: "sh_fixture", command: "echo SHELL_FACT", status: "exited" as const, time: { created: 0, completed: 1 }, metadata: { background }, output: { output: "SHELL_FACT", cursor: 0, size: 10, truncated: false } }
  const completion = { id: "msg_completion", type: "synthetic" as const, text: "Shell completed: SHELL_FACT", time: { created: 1 } }
  native.unshift(shell, ...(background ? [completion] : []))
  canonical.unshift(Message.make({ id: background ? completion.id : shell.id, role: "user", content: background ? completion.text : "Shell: echo SHELL_FACT\nSHELL_FACT" }))
  const raw = transcriptView(session, native)
  const original = JSON.stringify([native, raw, canonical])
  const legacy = structuredClone(raw)
  for (const message of legacy) if (message.info.role === "assistant") delete message.info.shell
  assert.equal(historyHash(raw), historyHash(legacy))
  const initial = emptyPolicy(session.id)
  const blocks = project(activeMessages(raw), initial)
  assert.equal(blocks[0].closed, true)
  assert.match(rangePreview(blocks[0], initial), /echo SHELL_FACT/)
  assert.match(turnView(blocks[0]).user, /echo SHELL_FACT/)
  for (const count of [1, 3]) for (const mode of ["compact", "brief"] as const) {
    const policy = append(initial, { ...operation(mode, blocks.slice(0, count)), summary: "Saved shell findings" })
    validateNativePolicy(native, raw, policy)
    const reduced = project(activeMessages(raw), policy)
    assert.equal(reduced[0].messages[0].info.role, "user")
    assert.notEqual(reduced[0].messages[0].info.id, reduced[0].messages[1].info.id)
    const request = projectRequest(native, raw, canonical, policy)
    assert.match(JSON.stringify(request), /Saved shell findings/)
    assert.ok(!JSON.stringify(request).includes("SHELL_FACT"))
    const restored = append(policy, operation("expand", [reduced[0]]))
    assert.deepEqual(projectRequest(native, raw, canonical, restored), canonical)
    assert.deepEqual(project(activeMessages(raw), restored), blocks)
  }
  assert.equal(JSON.stringify([native, raw, canonical]), original)
})

test("running shells, omitted background-only records and checkpoints cannot start summaries", () => {
  const { session } = nativeFixture()
  for (const record of [
    { id: "msg_shell", type: "shell" as const, shellID: "sh_fixture", command: "echo pending", status: "running" as const, time: { created: 0 } },
    { id: "msg_shell", type: "shell" as const, shellID: "sh_fixture", command: "echo omitted", status: "exited" as const, time: { created: 0, completed: 1 }, metadata: { background: true } },
    { id: "msg_checkpoint", type: "compaction" as const, status: "completed" as const, reason: "manual" as const, summary: "Checkpoint", time: { created: 0 } },
  ]) {
    const raw = transcriptView(session, [record])
    assert.equal(summaryStart(raw), false)
    const policy = append(emptyPolicy(session.id), { ...operation("brief", project(raw, emptyPolicy(session.id))), summary: "Invalid" })
    assert.throws(() => project(raw, policy), /visible user message/)
    if (record.type === "compaction" || record.status === "running") {
      const pruning = append(emptyPolicy(session.id), operation("prune-reason", project(raw, emptyPolicy(session.id))))
      assert.throws(() => validateNativePolicy([record], raw, pruning), /settle shell input|checkpoints are read-only/)
    }
  }
})
