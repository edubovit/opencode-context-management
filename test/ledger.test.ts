import { test } from "node:test"
import assert from "node:assert/strict"
import { append, emptyPolicy, hash, operation, project, readPolicy, activeMessages } from "../src/context.ts"
import { policySchema } from "../src/ledger.ts"
import { ContextManager } from "../src/rpc.ts"
import { projectRequest } from "../src/projection.ts"
import { KEY } from "../src/config.ts"
import { persistenceFixture } from "./persistence-fixture.ts"
import { messages, pruneRule, session } from "./fixtures.ts"

const sourceHashes = [
  ["cace141d423d57c5b8077de5a0cb0b5f8e2081653250e406102387e08bb1c5f4", "1dc5d478bc877128a963196df9b3631e50138e2fbc694e8fc5f48a08cfaf19f4", "a34aecdf2a45754cb940d4fbbb259ea131a10c6107c3e9f7efa10769ba202dfb", "b308875007e49418a658baaad308979ea6764b0f201272717d070007f2ee752a", "3f77527e3d16432aebe177a65f43612c9597e481741ee9da1780da58568bfa40", "b982ba78d9e2def13c069a50587a038d1b46e5b47f453542e2999d40ed399471"],
  ["cace141d423d57c5b8077de5a0cb0b5f8e2081653250e406102387e08bb1c5f4", "0d573e4e55dcf4656016fff7a43ae9a98e4ef543735d79a87d8d2a6f8b1b8778", "3a03be4ef8a637e212b146a4241422390df7dfcb9546c685dc4a5e45d647ab0d", "47243d9194fd16187d31110bcd3bbb14b1d1eb7b263e998f020ec924d74cf171", "3f77527e3d16432aebe177a65f43612c9597e481741ee9da1780da58568bfa40", "535694597a850d5d7abbc57a921ecb2864020dbae83822de4b33e2c4af486c24"],
]
const requestHashes = [
  ["e1d21f474c9bb4fc221a27a4446cf39c8d26edd8c20bcfc404f0982e70786989", "db14790c9051afa2d0337d2cc29b4f87b0ce67be83eb859085a246b483196226", "8aa823b8723677d1642decca940e6aa1b79f424dc920a9ae1cba3753f9ffe32d", "a94497ac5edf3dca9d75ec7ff172d1cfb3beb67dcab37245d3b19a304309a484", "8aa823b8723677d1642decca940e6aa1b79f424dc920a9ae1cba3753f9ffe32d", "e1d21f474c9bb4fc221a27a4446cf39c8d26edd8c20bcfc404f0982e70786989"],
  ["e1d21f474c9bb4fc221a27a4446cf39c8d26edd8c20bcfc404f0982e70786989", "f8c6ab46e36011948b7f82dc603d5b766c14b1f4af75d93791e24fdc172db979", "d01bffe43edda53bf02710ebe96a8d92def2723793997babf84e23a335e1837c", "a94497ac5edf3dca9d75ec7ff172d1cfb3beb67dcab37245d3b19a304309a484", "d01bffe43edda53bf02710ebe96a8d92def2723793997babf84e23a335e1837c", "e1d21f474c9bb4fc221a27a4446cf39c8d26edd8c20bcfc404f0982e70786989"],
]

for (const version of [7, 8]) test(`format ${version} fingerprints and requests match the frozen 3.2.0 baseline through every operation`, () => {
  const index = version - 7
  const fixture = persistenceFixture(version === 8)
  assert.deepEqual(fixture.states.map((state) => state.source), sourceHashes[index])
  assert.deepEqual(fixture.states.map((state) => state.request), requestHashes[index])
  for (let length = 1; length <= fixture.policy.operations.length; length++) {
    const saved = { ...fixture.policy, version, revision: length, cursor: length, operations: fixture.policy.operations.slice(0, length).map((op, i) => ({ ...op, beforeHash: sourceHashes[index][i] })) }
    const before = structuredClone(saved)
    const policy = readPolicy({ id: fixture.session.id, metadata: { [KEY]: saved } })
    assert.equal(policy.version, 10)
    assert.equal("cursor" in policy, false)
    assert.deepEqual(saved, before)
    assert.equal(hash(projectRequest(fixture.native, fixture.raw, fixture.canonical, policy)), requestHashes[index][length - 1])
    assert.deepEqual(readPolicy({ id: fixture.session.id, metadata: { [KEY]: JSON.parse(JSON.stringify(policy)) } }), policy)
    const next = append(policy, operation("prune-reason", [project(activeMessages(fixture.raw), policy).at(-1)!]))
    assert.deepEqual(next.operations.slice(0, length), policy.operations)
    assert.equal(next.version, 10)
  }
})

test("unsupported, foreign and damaged ledgers are refused without resetting metadata", () => {
  const valid = emptyPolicy("ses_test")
  const values: unknown[] = [null, [], {}, ...[1, 2, 3, 4, 5, 6, 11, "10"].map((version) => ({ ...valid, version })), { ...valid, sessionID: "ses_other" }, { ...valid, revision: 1 }, { ...valid, cursor: 0 }]
  for (const version of [7, 8]) for (const cursor of [-1, 1, 0.5]) values.push({ ...valid, version, cursor })
  for (const value of values) {
    const metadata = { unrelated: "keep", [KEY]: value }
    const original = structuredClone(metadata)
    assert.throws(() => readPolicy({ id: "ses_test", metadata }))
    assert.deepEqual(metadata, original)
  }
})

test("only append-only token operations enter the ledger or RPC commit", () => {
  const raw = messages()
  const op = operation("tool-prune", project(raw, emptyPolicy("ses_test")), pruneRule())
  const valid = append(emptyPolicy("ses_test"), op)
  for (const edit of [
    { mode: "unprune" }, { id: "" }, { sourceIDs: [] }, { sourceIDs: ["same", "same"] }, { created: -1 }, { beforeTokens: NaN },
    { rule: { threshold: 8000, head: 2000, tail: 2000 } }, { rule: { ...op.rule, head: 5000 } },
    { mode: "tool-delete", rule: undefined }, { mode: "brief", rule: undefined, summary: " " }, { checkpoint: true },
  ]) {
    const policy = { ...valid, operations: [{ ...op, ...edit }] }
    assert.throws(() => readPolicy({ ...session(), metadata: { [KEY]: policy } }))
    assert.equal(policySchema.safeParse(policy).success, false)
    assert.equal(ContextManager.methods.commit.input.safeParse({ sessionID: "ses_test", policy, expected: { revision: 0, fingerprint: "source" } }).success, false)
  }
  assert.throws(() => readPolicy({ ...session(), metadata: { [KEY]: { ...valid, revision: 2, operations: [op, op] } } }), /identity/)
})
