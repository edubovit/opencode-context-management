import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import { activeMessages, append, blockMessages, emptyPolicy, hash, operation, project, readPolicy, type Operation } from "../src/context.ts"
import { transcriptView } from "../src/normalize.ts"
import { projectRequest, validateNativePolicy } from "../src/projection.ts"
import { rememberPolicy, revertPolicy } from "../src/revert.ts"
import { inheritFork } from "../src/fork.ts"
import { KEY } from "../src/config.ts"
import { nativeFixture } from "./native-fixtures.ts"
import { pruneRule } from "./fixtures.ts"

function fixture() {
  const f = nativeFixture()
  let policy = emptyPolicy(f.session.id)
  const raw = () => transcriptView(f.session, f.native)
  const blocks = () => project(activeMessages(raw()), policy)
  return {
    ...f, raw, blocks,
    get policy() { return policy },
    save(op: Operation) { policy = rememberPolicy(raw(), append(policy, op)) },
    request: (incoming = f.canonical) => projectRequest(f.native, raw(), incoming, policy),
    arrival(n: number) {
      const note = { id: `msg_notice${n}`, type: "synthetic" as const, text: `CHILD_RESULT_${n}`, time: { created: 100 + n }, metadata: { source: "subagent", childID: `ses_child${n}`, state: "completed" } }
      f.native.push(note)
      const message = Message.make({ id: note.id, role: "user", content: note.text })
      f.canonical.push(message)
      return message
    },
  }
}

for (const mode of ["tool-prune", "tool-prune-all", "tool-delete", "prune-reason", "compact", "brief", "delete"] as const) {
  test(`${mode} keeps its saved endpoint when background completions extend the last user turn`, () => {
    const f = fixture()
    f.save({ ...operation(mode, f.blocks(), mode === "tool-prune" ? pruneRule({ threshold: 200, head: 10, tail: 10 }) : undefined),
      ...(mode === "tool-delete" ? { pruneReason: true as const } : {}), ...(["compact", "brief"].includes(mode) ? { summary: "SAVED_SUMMARY" } : {}) })
    const saved = JSON.stringify(f.policy)
    const reduced = f.request()
    const previousBlocks = f.blocks()
    const previous = blockMessages(previousBlocks)
    const first = f.arrival(1)
    const inputs = hash({ native: f.native, raw: f.raw(), canonical: f.canonical, policy: f.policy })
    assert.deepEqual(f.request(), [...reduced, first])
    assert.deepEqual(blockMessages(f.blocks()).slice(0, previous.length), previous)
    assert.deepEqual(f.blocks().slice(0, -1), previousBlocks)
    const tail = f.blocks().at(-1)!
    assert.deepEqual(tail.sourceIDs, [first.id])
    assert.equal(tail.pruning, undefined)
    validateNativePolicy(f.native, f.raw(), f.policy)
    assert.equal(hash({ native: f.native, raw: f.raw(), canonical: f.canonical, policy: f.policy }), inputs)
    const second = f.arrival(2)
    assert.deepEqual(f.request(), [...reduced, first, second])
    const decoded = readPolicy({ id: f.session.id, metadata: { [KEY]: JSON.parse(saved) } })
    assert.deepEqual(projectRequest(f.native, f.raw(), f.canonical, decoded), f.request())
    assert.equal(JSON.stringify(f.policy), saved, "reading and projecting must not rewrite saved operations or provenance")
    const native = hash(f.native)
    f.save(operation("expand", f.blocks().slice(0, -1)))
    assert.deepEqual(f.request(), f.canonical)
    const third = f.arrival(3)
    assert.equal(f.request().at(-1), third)
    assert.deepEqual(f.request(), f.canonical)
    assert.equal(hash(f.native.slice(0, -1)), native)
  })
}

test("successive continuation edits, nested summaries and restoration stay scoped to their saved sources", () => {
  const f = fixture()
  f.save(operation("tool-prune-all", f.blocks()))
  const first = f.arrival(1)
  f.save(operation("delete", [f.blocks().at(-1)!]))
  const second = f.arrival(2)
  const pruned = f.request()
  assert.equal(pruned.at(-1), second)
  assert.ok(!pruned.includes(first))
  f.save({ ...operation("brief", f.blocks()), summary: "OUTER_SUMMARY" })
  f.save({ ...operation("revise", f.blocks()), targetID: f.blocks()[0].summaryID, summary: "REVISED_SUMMARY" })
  const third = f.arrival(3)
  assert.match(JSON.stringify(f.request()), /REVISED_SUMMARY/)
  f.save(operation("expand", [f.blocks()[0]]))
  assert.deepEqual(f.request(), [...pruned, third])
  f.save(operation("expand", f.blocks()))
  assert.deepEqual(f.request(), f.canonical)
})

test("restoration after a continuation keeps current-hook redactions and new messages unchanged", () => {
  const f = fixture()
  f.save({ ...operation("tool-delete", f.blocks()), pruneReason: true })
  const note = f.arrival(1)
  f.save(operation("expand", f.blocks().slice(0, -1)))
  const incoming = f.canonical.map(message => message.role === "tool"
    ? Message.tool({ id: message.content.find(p => p.type === "tool-result")!.id, name: "fixture", result: { type: "text", value: "EARLIER_HOOK_REDACTED" } })
    : message)
  assert.deepEqual(f.request(incoming), incoming)
  assert.equal(f.request(incoming).at(-1), note)
  assert.doesNotMatch(JSON.stringify(f.request(incoming)), /HEAD_0|HEAD_1|HEAD_2/)
})

test("continuation boundary recovery still rejects source drift, gaps, order changes and partial hidden ranges", () => {
  const f = fixture()
  f.save(operation("tool-prune-all", f.blocks()))
  f.arrival(1)
  const raw = f.raw()
  for (const changed of [raw.filter(m => m.info.id !== "msg_a1"), [raw[2], raw[1], raw[0], ...raw.slice(3)], raw.map(m => m.info.id === "msg_a2" ? { ...m, info: { ...m.info, sourceHash: "changed" } } : m)])
    assert.throws(() => project(activeMessages(changed), f.policy), /Saved range/)
  const inserted = [...raw]
  inserted.splice(3, 0, ...transcriptView(f.session, [{ id: "msg_inserted", type: "synthetic", text: "Unexpected interior input", time: { created: 50 } }]))
  assert.throws(() => project(activeMessages(inserted), f.policy), /Saved range/)
  assert.throws(() => f.request(f.canonical.filter(m => m.id !== "msg_a2")), /absent/)
  f.save({ ...operation("brief", f.blocks().slice(0, 3)), summary: "INDIVISIBLE" })
  const partial = { ...operation("delete", [f.blocks()[0]]), sourceIDs: ["msg_u0", "msg_a0"] }
  assert.throws(() => project(activeMessages(raw), append(f.policy, partial)), /range|split/)
})

test("fork and revert retain the pruned prefix independently of appended completion history", () => {
  const f = fixture()
  f.save(operation("tool-prune-all", f.blocks()))
  const note = f.arrival(1)
  const parent = { ...f.session, metadata: { ...f.session.metadata, [KEY]: f.policy } }
  const fork = { ...parent, id: "ses_copy", fork: { sessionID: parent.id, boundary: { type: "through" as const, messageID: note.id! } } }
  const copied = f.native.map(m => ({ ...structuredClone(m), id: `${m.id}_copy` }))
  const inherited = inheritFork(parent, f.native, fork, copied, f.policy)
  const copyRaw = transcriptView(fork, copied)
  const blocks = project(activeMessages(copyRaw), inherited)
  assert.equal(blocks.at(-1)!.pruning, undefined)
  const restored = project(activeMessages(copyRaw), append(inherited, operation("expand", blocks)))
  assert.deepEqual(blockMessages(restored), activeMessages(copyRaw))
  const staged = revertPolicy(f.raw(), f.policy, note.id)
  assert.equal(staged, f.policy)
  const retained = f.raw().filter(m => m.info.id !== note.id)
  assert.doesNotThrow(() => project(activeMessages(retained), staged))
  const crossing = revertPolicy(f.raw(), f.policy, "msg_u2")
  assert.equal(project(activeMessages(f.raw()).slice(0, 4), crossing).length, 2)
  assert.deepEqual(f.request().at(-1), note)
})
