import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { pluginHost } from "../src/host.ts"
import { activeMessages, append, emptyPolicy, hash, operation, project, readPolicy, splitAfter, type Policy } from "../src/context.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest } from "../src/projection.ts"
import { KEY } from "../src/config.ts"
import { AUTO_KEY } from "../src/auto-state.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { mockContext } from "./host-mock.ts"

function setup() {
  const mock = mockContext()
  const source = nativeFixture()
  mock.sessions.set(source.session.id, source.session)
  mock.messages.set(source.session.id, source.native)
  let policy = emptyPolicy(source.session.id)
  const blocks = () => project(activeMessages(transcriptView(source.session, source.native)), policy)
  const save = (op: Policy["operations"][number]) => {
    policy = append(policy, op)
    source.session.metadata = JSON.parse(JSON.stringify({ unrelated: "keep", [KEY]: policy, [AUTO_KEY]: { strategy: "MANUAL", pause: { id: "stale" } } }))
  }
  const fork = (id: string, parent = source.session, before?: string) => {
    const native = mock.messages.get(parent.id)!
    const selected = before ? native.slice(0, native.findIndex((message) => message.id === before)) : native
    const info: SessionInfo = { ...structuredClone(parent), id, parentID: undefined, time: { created: 1000, updated: 1000 }, fork: { sessionID: parent.id, boundary: { type: before ? "before" : "through", messageID: before ?? native.at(-1)!.id } } }
    const messages = selected.map((message, index) => ({ ...structuredClone(message), id: `msg_${id}_${index}` }))
    mock.sessions.set(id, info)
    mock.messages.set(id, messages)
    return { info, messages, ids: new Map(selected.map((message, index) => [message.id, messages[index].id])) }
  }
  return { mock, source, blocks, save, fork, get policy() { return policy }, adapter: pluginHost(mock.context) }
}

test("a full fork inherits summaries, deletion and pruning as independent reversible layers", async () => {
  const f = setup()
  f.save({ ...operation("tool-prune-all", [f.blocks()[0]]), pruneReason: true })
  f.save({ ...operation("compact", f.blocks().slice(0, 2)), summary: "PARENT_SUMMARY" })
  f.save(operation("delete", [f.blocks()[1]]))
  const original = hash({ session: f.source.session, native: f.source.native })
  const fork = f.fork("ses_fork")
  const session = await f.adapter.host.session(fork.info.id)
  let policy = readPolicy(session)
  const raw = await f.adapter.host.messages(session.id)
  const blocks = () => project(activeMessages(raw), policy)
  assert.equal(policy.sessionID, session.id)
  assert.deepEqual(blocks().map((block) => block.kind), ["compact", "deleted"])
  assert.equal(session.metadata?.unrelated, "keep")
  assert.deepEqual(session.metadata?.[AUTO_KEY], { strategy: "MANUAL" })
  policy = append(policy, operation("expand", blocks()))
  assert.deepEqual(blocks().map((block) => block.kind), ["turn", "turn", "turn"])
  assert.equal(blocks()[0].allToolsPruned, true)
  policy = append(policy, operation("expand", [blocks()[0]]))
  const incoming = f.source.canonical.map((message) => message.id ? Message.make({ ...message, id: fork.ids.get(message.id) }) : message)
  assert.deepEqual(projectRequest(fork.messages, raw, incoming, policy), incoming)
  await f.adapter.host.update(session.id, { ...session.metadata, [KEY]: policy })
  assert.equal(hash({ session: f.source.session, native: f.source.native }), original)
  f.mock.sessions.delete(f.source.session.id)
  assert.equal(readPolicy(await f.adapter.host.session(session.id)).revision, policy.revision)
  await f.adapter.close()
})

test("fork before a turn retains earlier summaries and expands only a boundary-crossing summary", async () => {
  const f = setup()
  f.save({ ...operation("brief", [f.blocks()[0]]), summary: "EARLIER_SUMMARY" })
  f.save(operation("prune-reason", [f.blocks()[1]]))
  f.save({ ...operation("compact", f.blocks().slice(1)), summary: "CROSSES_CUTOFF" })
  const fork = f.fork("ses_partial", undefined, "msg_u2")
  const session = await f.adapter.host.session(fork.info.id)
  const raw = await f.adapter.host.messages(session.id)
  const policy = readPolicy(session)
  const blocks = project(activeMessages(raw), policy)
  assert.deepEqual(blocks.map((block) => block.kind), ["brief", "turn"])
  assert.equal(blocks[1].reasonPruned, true)
  assert.ok(!JSON.stringify(blocks).includes("CROSSES_CUTOFF"))
  assert.ok(!JSON.stringify(blocks).includes("QUESTION_2"))
  const restored = project(activeMessages(raw), append(policy, operation("expand", blocks)))
  assert.equal(restored[1].reasonPruned, undefined)
  assert.equal(f.blocks()[1].kind, "compact")
  await f.adapter.close()
})

for (const mode of ["tool-prune-all", "tool-delete"] as const) test(`partial forks retain ${mode} across the cutoff and restore each retained turn independently`, async () => {
  const f = setup()
  f.save({ ...operation(mode, f.blocks()), pruneReason: true })
  const original = hash({ session: f.source.session, native: f.source.native })
  const fork = f.fork("ses_pruned_prefix", undefined, "msg_u2")
  const session = await f.adapter.host.session(fork.info.id)
  const raw = await f.adapter.host.messages(session.id)
  let policy = readPolicy(session)
  const blocks = () => project(activeMessages(raw), policy)
  assert.equal(blocks().length, 2)
  assert.ok(blocks().every((block) => block.reasonPruned && block.pruning?.length === 1))
  const incoming = f.source.canonical.slice(0, f.source.canonical.findIndex((message) => message.id === "msg_u2"))
    .map((message) => message.id ? Message.make({ ...message, id: fork.ids.get(message.id) }) : message)
  assert.doesNotMatch(JSON.stringify(projectRequest(fork.messages, raw, incoming, policy)), /HEAD_0|HEAD_1|REASON_0|REASON_1/)
  policy = append(policy, operation("expand", [blocks()[0]]))
  const partial = JSON.stringify(projectRequest(fork.messages, raw, incoming, policy))
  assert.match(partial, /HEAD_0/)
  assert.match(partial, /REASON_0/)
  assert.doesNotMatch(partial, /HEAD_1|REASON_1|QUESTION_2/)
  policy = append(policy, operation("expand", [blocks()[1]]))
  assert.deepEqual(projectRequest(fork.messages, raw, incoming, policy), incoming)
  const saved = readPolicy({ id: session.id, metadata: { [KEY]: JSON.parse(JSON.stringify(policy)) } })
  assert.deepEqual(projectRequest(fork.messages, raw, incoming, saved), incoming)
  assert.equal(hash({ session: f.source.session, native: f.source.native }), original)
  await f.adapter.close()
})

test("a boundary-crossing deleted range opens only its retained content and preserves earlier pruning", async () => {
  const f = setup()
  f.save({ ...operation("brief", [f.blocks()[0]]), summary: "KEEP_EARLIER_SUMMARY" })
  f.save({ ...operation("tool-prune-all", f.blocks().slice(1)), pruneReason: true })
  f.save(operation("delete", f.blocks().slice(1)))
  const original = hash({ session: f.source.session, native: f.source.native })
  const fork = f.fork("ses_deleted_prefix", undefined, "msg_u2")
  const session = await f.adapter.host.session(fork.info.id)
  const raw = await f.adapter.host.messages(session.id)
  const policy = readPolicy(session)
  const blocks = project(activeMessages(raw), policy)
  assert.deepEqual(blocks.map((block) => block.kind), ["brief", "turn"])
  assert.equal(blocks[1].allToolsPruned, true)
  assert.equal(blocks[1].reasonPruned, true)
  assert.doesNotMatch(JSON.stringify(blocks), /QUESTION_2/)
  const restored = project(activeMessages(raw), append(policy, operation("expand", [blocks[1]])))
  assert.equal(restored[0].kind, "brief")
  assert.match(JSON.stringify(restored[1].messages), /HEAD_1/)
  assert.match(JSON.stringify(restored[1].messages), /REASON_1/)
  assert.equal(hash({ session: f.source.session, native: f.source.native }), original)
  await f.adapter.close()
})

test("forks preserve nested revisions, prior pruning, and last-resort split boundaries", async () => {
  const f = setup()
  f.save(operation("tool-prune-all", [f.blocks()[0]]))
  f.save({ ...operation("compact", splitAfter(f.blocks(), "msg_u0").slice(0, 1)), checkpoint: true, summary: "SPLIT_PREFIX" })
  f.save({ ...operation("revise", [f.blocks()[0]]), targetID: f.blocks()[0].summaryID, summary: "REVISED_PREFIX" })
  f.save({ ...operation("brief", f.blocks().slice(0, 3)), summary: "OUTER_SUMMARY" })
  const fork = f.fork("ses_checkpoint")
  const session = await f.adapter.host.session(fork.info.id)
  const raw = await f.adapter.host.messages(session.id)
  let policy = readPolicy(session)
  let blocks = project(activeMessages(raw), policy)
  policy = append(policy, operation("expand", [blocks[0]]))
  blocks = project(activeMessages(raw), policy)
  assert.equal(blocks[0].kind, "compact")
  assert.match(JSON.stringify(blocks[0].messages), /REVISED_PREFIX/)
  assert.deepEqual(blocks[1].sourceIDs, [fork.ids.get("msg_a0")])
  policy = append(policy, operation("expand", [blocks[1]]))
  blocks = project(activeMessages(raw), policy)
  assert.match(JSON.stringify(blocks[1].messages), /HEAD_0/)
  assert.ok(!JSON.stringify(blocks[1].messages).includes("QUESTION_0"))
  assert.equal(blocks[0].kind, "compact")
  await f.adapter.close()
})

test("fork initialization uses its copied snapshot, coalesces writes and leaves later input intact", async () => {
  const f = setup()
  f.save({ ...operation("brief", [f.blocks()[0]]), summary: "AT_FORK" })
  const fork = f.fork("ses_concurrent")
  f.save({ ...operation("revise", [f.blocks()[0]]), targetID: f.blocks()[0].summaryID, summary: "PARENT_CHANGED_LATER" })
  fork.messages.push({ id: "msg_new_input", type: "user", text: "FORK_ONLY", time: { created: 1001 } })
  let writes = 0
  const update = f.mock.context.session.update
  f.mock.context.session.update = async (...args) => { writes++; await update(...args) }
  const [first, second] = await Promise.all([f.adapter.host.session(fork.info.id), f.adapter.host.session(fork.info.id)])
  assert.deepEqual(first, second)
  assert.equal(writes, 1)
  const blocks = project(activeMessages(await f.adapter.host.messages(first.id)), readPolicy(first))
  assert.match(JSON.stringify(blocks[0].messages), /AT_FORK/)
  assert.doesNotMatch(JSON.stringify(blocks), /PARENT_CHANGED_LATER/)
  assert.match(JSON.stringify(blocks.at(-1)), /FORK_ONLY/)
  await f.adapter.close()
})

test("a fork of an uninitialized fork inherits the original snapshot without writing either ancestor", async () => {
  const f = setup()
  f.save({ ...operation("compact", [f.blocks()[0]]), summary: "NESTED_FORK_SUMMARY" })
  const first = f.fork("ses_first")
  const second = f.fork("ses_second", first.info)
  const original = hash([...f.mock.sessions].filter(([id]) => id !== second.info.id))
  const session = await f.adapter.host.session(second.info.id)
  const blocks = project(activeMessages(await f.adapter.host.messages(session.id)), readPolicy(session))
  assert.match(JSON.stringify(blocks[0].messages), /NESTED_FORK_SUMMARY/)
  assert.equal(hash([...f.mock.sessions].filter(([id]) => id !== second.info.id)), original)
  await f.adapter.close()
})

test("empty-boundary forks get an empty own policy without resetting malformed or foreign snapshots", async () => {
  const f = setup()
  f.save({ ...operation("brief", f.blocks()), summary: "ALL_HISTORY" })
  const fork = f.fork("ses_empty", undefined, "msg_u0")
  const session = await f.adapter.host.session(fork.info.id)
  assert.equal(readPolicy(session).sessionID, session.id)
  assert.equal(readPolicy(session).operations.length, 0)
  for (const value of [{ ...f.policy, sessionID: "ses_foreign" }, { ...f.policy, revision: -1 }]) {
    const invalid = f.fork(`ses_bad${String(value.revision)}`)
    invalid.info.metadata = JSON.parse(JSON.stringify({ [KEY]: value }))
    const before = hash(invalid.info)
    await assert.rejects(f.adapter.host.session(invalid.info.id))
    assert.equal(hash(f.mock.sessions.get(invalid.info.id)), before)
  }
  await f.adapter.close()
})

test("fork payload drift fails closed instead of rebasing onto unrelated history", async () => {
  const f = setup()
  f.save({ ...operation("brief", [f.blocks()[0]]), summary: "SAVED" })
  const fork = f.fork("ses_changed")
  const user = fork.messages[0] as Extract<SessionMessageInfo, { type: "user" }>
  user.text = "CHANGED_COPY"
  const before = hash(fork.info)
  await assert.rejects(f.adapter.host.session(fork.info.id), /fork|Fork/)
  assert.equal(hash(f.mock.sessions.get(fork.info.id)), before)
  await f.adapter.close()
})
