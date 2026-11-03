import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout } from "node:timers/promises"
import type { Controller } from "../src/controller.ts"
import { historyHash } from "../src/context.ts"
import { contentTokens } from "../src/metrics.ts"
import type { fixture } from "./host-fixture.ts"
import { terminal } from "./terminal.ts"

type Fixture = Awaited<ReturnType<typeof fixture>>

function open(test: Fixture, controller: Controller, executable: string, name: string) {
  const child = terminal({ executable, url: test.url, sessionID: controller.sessionID, project: test.project, env: test.env, output: path.join(test.root, `${name}.log`) })
  child.resize(120, 40)
  const seen = (text: string) => test.until(async () => (await child.text()).includes(text), `${name}: ${text}`)
  const keys = async (text: string) => { child.keys(text); await setTimeout(80) }
  const capture = async (stage: string) => {
    const text = await child.text()
    await writeFile(path.join(test.root, `${name}-${stage}.screen.txt`), text)
    return text
  }
  const inspector = async () => {
    const session = await test.client.session.get({ sessionID: controller.sessionID })
    assert.ok(session.title)
    await seen(session.title)
    await keys("/context-manager")
    await test.until(async () => /\/context-manager\s+Context manager/.test(await child.text()), `${name}: slash command registration`)
    await keys("\r")
    await seen("Local text")
    await seen("Ready.")
    return session.title
  }
  return { child, seen, keys, capture, inspector }
}

export async function verifySubturnControls(test: Fixture, controller: Controller, executable: string, verifyNextWire: () => Promise<void>) {
  const ui = open(test, controller, executable, "subturn-controls-tui")
  let completed = false
  try {
    const before = await controller.load()
    const raw = await test.client.session.context({ sessionID: controller.sessionID })
    let calls = test.calls.length
    assert.equal(before.blocks.length, 1)
    const title = await ui.inspector()
    await ui.keys(" ")
    await ui.seen("Selected (0 + open)")
    await ui.keys(" ")
    await ui.seen("Selected (1)")
    await ui.keys("c")
    await ui.seen("Compaction configuration")
    await ui.keys("\x1b[H" + "\x1b[B".repeat(9))
    await ui.seen("Split one ordinary turn/subturn")
    await ui.keys(" ")
    await ui.seen("[+] Split into subturns")
    await ui.keys("\r")
    await ui.seen("Desired count (whole number, at least 2)")
    await ui.keys("10")
    await ui.capture("count-before-cancel")
    await ui.keys("\x1b")
    await ui.seen("Split cancelled; context unchanged.")
    await ui.seen("Compaction configuration")
    assert.deepEqual((await controller.load()).policy, before.policy, "Cancelling the real count input cannot write a grouping")
    assert.deepEqual(await test.client.session.context({ sessionID: controller.sessionID }), raw)
    assert.equal(test.calls.length, calls)
    await ui.capture("cancelled")
    await ui.keys("\r")
    await ui.seen("Desired count (whole number, at least 2)")
    await ui.keys("10")
    await ui.capture("count-before-apply")
    await ui.keys("\r")
    const split = await test.until(async () => {
      const value = await controller.load()
      return value.policy.revision === before.policy.revision + 1 && value.blocks.length === 5 ? value : undefined
    }, "ConPTY requested ten subturns, committed five")
    await ui.seen("Split into 5 subturns; requested 10.")
    assert.deepEqual(split.blocks.flatMap(block => block.sourceIDs), before.blocks[0].sourceIDs)
    assert.equal(historyHash(split.blocks.flatMap(block => block.messages)), historyHash(before.blocks[0].messages))
    assert.ok(split.blocks.every(block => block.subturn?.originID === before.blocks[0].sourceIDs[0] && contentTokens(block.messages, split.tokenizer) >= controller.config.subturns.minTokens))
    assert.deepEqual(await test.client.session.context({ sessionID: controller.sessionID }), raw)
    assert.equal(test.calls.length, calls, "Actual terminal split must not invoke a model")
    await ui.capture("split-five")
    await verifyNextWire()
    calls = test.calls.length
    await ui.keys(" ")
    await ui.seen("No selection")
    await ui.keys("\x1b[H")
    await ui.keys(" ")
    await ui.seen("Selected (0 + open)")
    await ui.keys("\x1b[F")
    await ui.keys(" ")
    await ui.seen("Selected (1)")
    await ui.keys("c")
    await ui.seen("Compaction configuration")
    await ui.keys("\x1b[H" + "\x1b[B".repeat(10))
    await ui.seen("Join one contiguous range")
    await ui.keys(" ")
    await ui.seen("[+] Merge subturns")
    await ui.keys("\r")
    const merged = await test.until(async () => {
      const value = await controller.load()
      return value.policy.revision === split.policy.revision + 1 && value.blocks.length === 1 ? value : undefined
    }, "ConPTY sibling merge committed")
    await ui.seen("Subturns merged. No model call")
    assert.deepEqual(merged.blocks[0].sourceIDs, before.blocks[0].sourceIDs)
    assert.equal(historyHash(merged.blocks[0].messages), historyHash(before.blocks[0].messages))
    assert.deepEqual(await test.client.session.context({ sessionID: controller.sessionID }), raw)
    assert.equal(test.calls.length, calls, "Actual terminal merge must not invoke a model")
    await ui.capture("merged")
    await verifyNextWire()
    await ui.keys("\x1b")
    await ui.seen(title)
    await test.until(async () => !(await ui.child.text()).includes("Local text"), "ConPTY returned to original session")
    completed = true
    return { requested: 10, actual: split.blocks.length, revisions: [before.policy.revision, split.policy.revision, merged.policy.revision] }
  } finally {
    const code = await ui.child.close()
    if (completed) assert.equal(code, 0, "Owned subturn-controls TUI must stop cleanly")
  }
}

export async function watchFallbackToast(test: Fixture, controller: Controller, executable: string) {
  const ui = open(test, controller, executable, "subturn-warning-tui")
  let title: string
  try {
    title = await ui.inspector()
    await ui.keys("\x1b")
    await ui.seen(title)
    await test.until(async () => !(await ui.child.text()).includes("Local text"), "warning observer returned to the original session")
    await ui.capture("before")
  } catch (error) {
    await ui.child.close()
    throw error
  }
  let closed = false
  const captured = (async () => {
    for (let attempt = 0; attempt < 1500 && !closed; attempt++) {
      const screen = await ui.child.text()
      if (screen.includes("Last-resort context cleanup")) {
        await writeFile(path.join(test.root, "subturn-warning-tui-pending.screen.txt"), screen)
        assert.ok(screen.includes(title), "The warning must leave the original session visible")
        assert.ok(!screen.includes("Local text") && !screen.includes("Conversation · tokens"), "An AUTO warning must not steal navigation into the inspector")
        assert.match(screen, /Normal automatic cleanup/)
        const state = await controller.host.auto!.state(controller.sessionID)
        assert.equal(state.pause?.phase, "auto", "The actual toast must be visible while AUTO is still pending")
        return { pauseID: state.pause.id, title, phase: state.pause.phase }
      }
      await setTimeout(30)
    }
    throw new Error("No last-resort toast was observed while the original AUTO request was held")
  })()
  void captured.catch(() => {})
  return {
    verify: async (pauseID: string) => {
      const observed = await captured
      assert.equal(observed.pauseID, pauseID)
      return observed
    },
    close: async (completed: boolean) => {
      closed = true
      await captured.catch(() => {})
      const code = await ui.child.close()
      if (completed) assert.equal(code, 0, "Owned warning TUI must stop cleanly")
    },
  }
}
