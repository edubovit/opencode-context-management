import { test } from "node:test"
import assert from "node:assert/strict"
import { Activity } from "../src/activity.ts"
import { protectedMessages } from "../src/history.ts"
import { nativeFixture } from "./native-fixtures.ts"

test("idle observation is fresh, coalesces busy waits, and never turns a timeout into idle", async () => {
  let waiting = Promise.resolve()
  let calls = 0
  const activity = new Activity(async () => { calls++; await waiting })
  assert.equal(await activity.idle("ses_test"), true)
  let release!: () => void
  waiting = new Promise<void>((resolve) => { release = resolve })
  assert.deepEqual(await Promise.all([activity.idle("ses_test", 1), activity.idle("ses_test", 1)]), [false, false])
  assert.equal(calls, 2)
  assert.equal(await activity.idle("ses_test", 1), false)
  assert.equal(calls, 2)
  const final = activity.idle("ses_test")
  release()
  assert.equal(await final, true)
  assert.equal(await activity.idle("ses_test"), true)
  assert.equal(calls, 3)
  activity.close()
  await assert.rejects(activity.idle("ses_test"), /closed/)
})

test("idle failures and cleanup fail closed and release pending observers", async () => {
  const failure = new Activity(async () => { throw new Error("missing session") })
  await assert.rejects(failure.idle("ses_missing"), /missing session/)
  await assert.rejects(failure.idle("ses_missing", -1), /Invalid/)
  failure.close()
  let release!: () => void
  const activity = new Activity(() => new Promise((resolve) => { release = resolve }))
  const result = activity.idle("ses_test", 5000)
  await Promise.resolve()
  activity.close()
  await assert.rejects(result, /closed/)
  release()
})

test("all steered inputs since the last idle boundary are protected", () => {
  const { native } = nativeFixture()
  assert.deepEqual([...protectedMessages(native)], [])
  const user = { id: "msg_next", type: "user" as const, text: "Next", time: { created: 50 } }
  assert.deepEqual([...protectedMessages([...native, user, { ...user, id: "msg_steer" }])], ["msg_next", "msg_steer"])
  assert.deepEqual([...protectedMessages([user, ...native.slice(0, 3)])], [user.id, ...native.slice(0, 3).map((message) => message.id)])
  assert.deepEqual([...protectedMessages([{ id: "msg_synthetic", type: "synthetic", text: "Work", time: { created: 1 } }])], ["msg_synthetic"])
})
