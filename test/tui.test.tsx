/** @jsxImportSource @opentui/solid */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { KeyCodes } from "@opentui/core/testing"
import { RGBA, type ScrollBoxRenderable, type TextRenderable } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Inspector, watchSuspensions } from "../src/tui.tsx"
import { Controller } from "../src/controller.ts"
import { Storage } from "../src/storage.ts"
import { KEY, settings } from "../src/config.ts"
import { append, emptyPolicy, operation, readPolicy, select, turns } from "../src/context.ts"
import { fixtureHost, messages, pruneRule } from "./fixtures.ts"
import { distribution } from "../src/metrics.ts"
import { Hotkeys } from "../src/tui-help.tsx"
import { AUTO_KEY, type AutoCommand, type AutoControl, type AutoState } from "../src/auto-state.ts"

async function setup(t: { after(fn: () => Promise<void>): void }, width = 140, height = 40, prepare?: (fixture: ReturnType<typeof fixtureHost>) => void, options: unknown = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-tui-"))
  const fixture = fixtureHost()
  prepare?.(fixture)
  const { data, host } = fixture
  const controller = new Controller(host, data.session.id, settings(options), new Storage(dir, dir))
  const navigations: string[] = []
  const api = {
    app: { version: "1.18.33" }, mode: { push: () => () => {} }, route: { navigate: (name: string) => { navigations.push(name) } },
    theme: { current: { primary: "#aaccff", textMuted: "#8899aa" } }, ui: { toast: () => {} },
  } as unknown as TuiPluginApi
  const screen = await testRender(() => <Inspector api={api} controller={controller} sessionID={data.session.id} />, { width, height })
  t.after(async () => { screen.renderer.destroy(); await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  const frame = () => screen.captureCharFrame()
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 150; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await screen.renderOnce()
      if (check()) return
    }
    assert.fail(frame())
  }
  const key: typeof screen.mockInput.pressKey = (name, modifiers) => screen.mockInput.pressKey(
    name === "return" ? KeyCodes.RETURN : name === "pageup" ? "\u001b[5~" : name === "pagedown" ? "\u001b[6~" : name, modifiers)
  return { ...fixture, controller, screen, frame, until, navigations, type: screen.mockInput.typeText, key, esc: screen.mockInput.pressEscape }
}

test("Space ranges prune/undo and compaction autoapplies without a preview", async (t) => {
  const { data, frame, until, type, key } = await setup(t)
  await until(() => frame().includes("Ready."))
  assert.ok(frame().includes("WHOLE EFFECTIVE CONTEXT"))
  await type("n")
  await until(() => /Total categorized text: .* chars/.test(frame()))
  await type("n ")
  key(KeyCodes.ARROW_DOWN)
  await type(" p")
  await until(() => readPolicy(data.session).cursor === 1 && frame().includes("Ready."))
  assert.equal(readPolicy(data.session).operations[0].sourceIDs.length, 4)
  await type("u")
  await until(() => readPolicy(data.session).cursor === 0 && frame().includes("Ready."))
  await type("   c")
  await until(() => frame().includes("Summaries applied automatically"))
  assert.equal(readPolicy(data.session).cursor, 1)
  assert.equal(data.calls.length, 2)
  assert.match(data.calls[1].text, /too short/)
  assert.equal(data.removed.length, 1)
  assert.ok(!frame().includes("Review/edit") && !frame().includes("apply ALL drafts"))
})

test("fullscreen summary is read-only until manual edit, save is undoable", async (t) => {
  const { data, controller, frame, until, type, key, esc } = await setup(t)
  await until(() => frame().includes("Ready."))
  await type("  b")
  await until(() => frame().includes("Summaries applied automatically"))
  key("return")
  await until(() => frame().includes("Summary reader"))
  assert.ok(frame().includes("READ-ONLY"))
  assert.ok(!frame().includes("WHOLE EFFECTIVE CONTEXT"))
  await type("m")
  await until(() => frame().includes("Choose compaction model"))
  esc()
  await until(() => !frame().includes("Choose compaction model"))
  assert.ok(frame().includes("Summary reader"), "Closing a picker must not also close the reader")
  await type("xyz")
  assert.equal(readPolicy(data.session).cursor, 1)
  await type("e")
  await until(() => frame().includes("MANUAL EDIT"))
  await type("MANUAL_KEEP ")
  key("s", { ctrl: true })
  await until(() => frame().includes("Summary updated"))
  const id = readPolicy(data.session).operations[0].id
  assert.match((await controller.summary(id)).text, /MANUAL_KEEP/)
  assert.equal(readPolicy(data.session).cursor, 2)
  assert.equal(data.jobs, 1, "Manual editing must not call a model")
  esc()
  await until(() => frame().includes("Ready."))
  await type("u")
  await until(() => readPolicy(data.session).cursor === 1 && frame().includes("Ready."))
  assert.doesNotMatch((await controller.summary(id)).text, /MANUAL_KEEP/)
})

test("model edits use fresh summary-only dialogue, review/revise before apply, then dispose", async (t) => {
  const { data, frame, until, type, key, esc } = await setup(t, 150, 42, ({ data, host }) => {
    host.models = async () => [data.model, { ...data.model, providerID: "alternate", id: "other", name: "Alternate", variants: { low: {} } }]
    data.responses = ["APPLIED_ONLY", "FIRST_PROPOSAL", "SECOND_PROPOSAL"]
  })
  await until(() => frame().includes("Ready."))
  await type("  b")
  await until(() => frame().includes("Summaries applied automatically"))
  key("return")
  await until(() => frame().includes("Summary reader"))
  await type("m")
  await until(() => frame().includes("Choose compaction model"))
  await type("alternate")
  key("return")
  await until(() => frame().includes("alternate/other"))
  await type("t")
  await type("low")
  key("return")
  await type("r")
  await until(() => frame().includes("Requested summary changes"))
  await type("Clarify the summary")
  key("s", { ctrl: true })
  await until(() => frame().includes("FIRST_PROPOSAL"))
  assert.equal(readPolicy(data.session).cursor, 1)
  assert.equal(data.jobs, 2)
  assert.deepEqual(data.calls[1].choice, { providerID: "alternate", modelID: "other", variant: "low" })
  assert.match(data.calls[1].text, /APPLIED_ONLY/)
  assert.doesNotMatch(data.calls[1].text, /Question 2|selected_range/)
  await type("r")
  await type("Another change")
  key("s", { ctrl: true })
  await until(() => frame().includes("SECOND_PROPOSAL"))
  assert.equal(data.calls[1].sessionID, data.calls[2].sessionID)
  assert.equal(data.removed.length, 1)
  key("s", { ctrl: true })
  await until(() => frame().includes("Summary updated"))
  assert.equal(readPolicy(data.session).cursor, 2)
  assert.equal(data.removed.length, 2)
  esc()
  await until(() => frame().includes("Ready."))
})

test("reader separators frame scrolling content and keep footer reserved at narrow size", async (t) => {
  const { data, screen, frame, until, type, key, esc } = await setup(t, 80, 24, ({ data }) => {
    const op = { ...operation("brief", select(turns(data.messages), 0, 0)), summary: Array.from({ length: 160 }, (_, n) => `LINE_${String(n).padStart(3, "0")}`).join("\n") }
    data.session.metadata![KEY] = append(emptyPolicy(data.session.id), op)
  })
  await until(() => frame().includes("Ready."))
  key("return")
  await until(() => frame().includes("LINE_000"))
  const scroll = screen.renderer.root.findDescendantById("cm-summary-scroll") as ScrollBoxRenderable
  assert.ok(scroll)
  const headerRule = screen.renderer.root.findDescendantById("cm-summary-header-rule")!
  const footerRule = screen.renderer.root.findDescendantById("cm-summary-footer-rule")!
  assert.ok(headerRule && footerRule)
  assert.equal(headerRule.height, 1)
  assert.equal(footerRule.height, 1)
  assert.ok(headerRule.y + headerRule.height <= scroll.y)
  assert.ok(scroll.y + scroll.height <= footerRule.y)
  const ruleRows = [headerRule.y, footerRule.y]
  const assertRulesVisible = () => {
    for (const rule of [headerRule, footerRule]) assert.ok(frame().split("\n")[rule.y].includes("─".repeat(70)), "Full-width horizontal separator must be visible")
  }
  assertRulesVisible()
  key(KeyCodes.ARROW_DOWN)
  await until(() => scroll.scrollTop === 10)
  key("pagedown")
  await until(() => scroll.scrollTop === 10 + scroll.viewport.height)
  assert.deepEqual([headerRule.y, footerRule.y], ruleRows, "Separators must not scroll with the summary")
  assertRulesVisible()
  key("pageup")
  await until(() => scroll.scrollTop === 10)
  key(KeyCodes.ARROW_UP)
  await until(() => scroll.scrollTop === 0)
  const footer = screen.renderer.root.findDescendantById("cm-hotkeys")!
  assert.ok(footer.y >= footerRule.y + footerRule.height)
  assert.ok(footer.y + footer.height <= 24)
  await type("e")
  await type("UNSAVED ")
  await until(() => frame().includes("UNSAVED"))
  assertRulesVisible()
  esc()
  await until(() => frame().includes("READ-ONLY"))
  assert.ok(!frame().includes("UNSAVED"))
  await type("r")
  await until(() => frame().includes("Requested summary changes"))
  const request = screen.renderer.root.findDescendantById("cm-summary-request")!
  assert.ok(request.y + request.height <= footerRule.y)
  assertRulesVisible()
  assert.equal(readPolicy(data.session).cursor, 1)
})

test("multi-range statistics stay visible and failed batches autoapply only after retry", async (t) => {
  const { data, controller, frame, until, type, key } = await setup(t, 160, 44, ({ host }) => {
    const generate = host.generate
    let failed = false
    host.generate = async (...args) => {
      const target = args[2].split(/<selected_range_[^>]+>/)[1]?.split("</selected_range_")[0]
      if (!failed && target?.includes("Question 2")) { failed = true; throw new Error("Fixture range failed") }
      return generate(...args)
    }
  })
  await until(() => frame().includes("Ready."))
  await type("  ")
  key(KeyCodes.ARROW_DOWN)
  key(KeyCodes.ARROW_DOWN)
  await type(" ")
  await until(() => frame().includes("SELECTED RANGES (1 + open)"))
  await type(" ")
  const blocks = turns(data.messages)
  await until(() => frame().includes("SELECTED RANGES (2)"))
  assert.ok(frame().includes(`≈${distribution(blocks).total.toLocaleString()} tokens`))
  assert.ok(frame().includes(`≈${distribution([blocks[0], blocks[2]]).total.toLocaleString()} tokens`))
  await type("b")
  await until(() => frame().includes("Fixture range failed") && frame().includes("Batch incomplete"))
  assert.equal(readPolicy(data.session).cursor, 0)
  assert.ok(!frame().includes("APPLIED_ONLY"))
  await type("g")
  await until(() => frame().includes("Summaries applied automatically"))
  assert.equal(readPolicy(data.session).cursor, 2)
  assert.equal(data.jobs, 3)
  assert.equal(data.removed.length, 3)
  assert.deepEqual((await controller.load()).blocks[1].messages, data.messages.slice(2, 4))
})

test("range restore confirmation and contextual help do not overlap the content", async (t) => {
  const { data, screen, frame, until, type, key, esc } = await setup(t, 120, 32)
  await until(() => frame().includes("Ready."))
  await type("?")
  await until(() => frame().includes("RANGE MENU HOTKEYS"))
  esc()
  await until(() => !frame().includes("RANGE MENU HOTKEYS"))
  await type("  p")
  await until(() => readPolicy(data.session).cursor === 1 && frame().includes("Ready."))
  key("u", { ctrl: true })
  await until(() => frame().includes("Restore preview"))
  assert.ok(frame().includes("Ctrl+S confirm restore"))
  assert.ok(frame().includes("WHOLE EFFECTIVE CONTEXT"))
  key("s", { ctrl: true })
  await until(() => readPolicy(data.session).cursor === 2)
  const footer = screen.renderer.root.findDescendantById("cm-hotkeys")!
  assert.ok(footer.y + footer.height <= 32)
})

test("secondary undo remains usable when projection fails before rows load", async (t) => {
  const { data, frame, until, type } = await setup(t, 140, 35, ({ data }) => {
    const op = operation("tool-prune", select(turns(data.messages), 0, 0), pruneRule())
    data.session.metadata![KEY] = append(emptyPolicy(data.session.id), { ...op, beforeHash: "invalid" })
  })
  await until(() => frame().includes("Saved range content changed"))
  assert.ok(frame().includes("Undo latest action"))
  await type("u")
  await until(() => readPolicy(data.session).cursor === 0 && frame().includes("Ready."))
})

test("hotkey keys use the theme primary color while labels, separators and notes stay muted", async () => {
  const primary = "#aaccff"
  const muted = "#8899aa"
  const api = { theme: { current: { primary, textMuted: muted } } } as unknown as TuiPluginApi
  const screen = await testRender(() => <Hotkeys api={api} lines={[
    [{ key: "p", label: "prune" }, { key: "Ctrl+U", label: "unprune" }, "read-only note"],
  ]} />, { width: 80, height: 6 })
  try {
    await screen.renderOnce()
    const footer = screen.renderer.root.findDescendantById("cm-hotkeys")!
    const line = footer.getChildren()[0] as TextRenderable
    assert.equal(line.plainText, "p prune · Ctrl+U unprune · read-only note")
    const chunks = line.textNode.toChunks()
    for (const key of ["p", "Ctrl+U"]) {
      const chunk = chunks.find((chunk) => chunk.text === key)
      assert.ok(chunk, `Missing styled key: ${key}`)
      assert.ok(chunk.fg?.equals(RGBA.fromHex(primary)), `Wrong key color: ${key}`)
    }
    for (const text of ["prune", " · ", "read-only note"]) {
      const chunk = chunks.find((chunk) => chunk.text.includes(text) && chunk.text !== "p" && chunk.text !== "Ctrl+U")
      assert.ok(chunk)
      assert.ok((chunk.fg ?? line.fg).equals(RGBA.fromHex(muted)))
    }
    assert.equal(footer.height, 2)
  } finally { screen.renderer.destroy() }
})

test("Enter on an ordinary turn opens user/final response fullscreen and preserves cursor and open selection", async (t) => {
  const { data, screen, frame, until, type, key, esc } = await setup(t, 120, 32)
  const original = structuredClone(data.messages)
  await until(() => frame().includes("Ready."))
  key(KeyCodes.ARROW_DOWN)
  await type(" ")
  key(KeyCodes.ARROW_DOWN)
  key("return")
  await until(() => frame().includes("Turn reader · Turn 3"))
  assert.ok(frame().includes("Question 2") && frame().includes("Answer 2"))
  assert.ok(!frame().includes("Question 1") && !frame().includes("WHOLE EFFECTIVE CONTEXT"))
  assert.ok(!frame().includes("Visible reasoning") && !frame().includes("HEAD_2") && !frame().includes("echo original input"))
  const rule = screen.renderer.root.findDescendantById("cm-turn-message-rule")!
  assert.ok(frame().split("\n")[rule.y].includes("─".repeat(100)))
  await type("epcrmu ")
  key("s", { ctrl: true })
  assert.equal(data.jobs, 0)
  assert.equal(readPolicy(data.session).cursor, 0)
  assert.deepEqual(data.messages, original)
  esc()
  await until(() => frame().includes("SELECTED RANGES (0 + open)"))
  await type(" p")
  await until(() => readPolicy(data.session).cursor === 1 && frame().includes("Ready."))
  assert.deepEqual(readPolicy(data.session).operations[0].sourceIDs, original.slice(2).map((message) => message.info.id))
})

test("turn reader scrolls long user/final messages with fixed header/footer at 80x24", async (t) => {
  const { data, screen, frame, until, key } = await setup(t, 80, 24, ({ data }) => {
    for (const [index, message] of data.messages.slice(0, 2).entries()) {
      const part = message.parts.find((part) => part.type === "text")!
      if (part.type === "text") part.text = Array.from({ length: 100 }, (_, n) => `${index ? "FINAL" : "USER"}_${n}`).join("\n")
    }
  })
  await until(() => frame().includes("Ready."))
  key("return")
  await until(() => frame().includes("Turn reader"))
  const scroll = screen.renderer.root.findDescendantById("cm-turn-scroll") as ScrollBoxRenderable
  const header = screen.renderer.root.findDescendantById("cm-turn-header-rule")!
  const footerRule = screen.renderer.root.findDescendantById("cm-turn-footer-rule")!
  const footer = screen.renderer.root.findDescendantById("cm-hotkeys")!
  assert.ok(header.y + header.height <= scroll.y)
  assert.ok(scroll.y + scroll.height <= footerRule.y && footerRule.y + footerRule.height <= footer.y)
  assert.ok(footer.y + footer.height <= 24)
  key(KeyCodes.ARROW_DOWN)
  await until(() => scroll.scrollTop === 10)
  key("pagedown")
  await until(() => scroll.scrollTop === 10 + scroll.viewport.height)
  key(KeyCodes.END)
  await until(() => frame().includes("FINAL_99"))
  key(KeyCodes.HOME)
  await until(() => scroll.scrollTop === 0 && frame().includes("USER_0"))
  assert.equal(data.jobs, 0)
})

test("unfinished busy turns can be inspected without treating partial text as the final response", async (t) => {
  const { data, frame, until, key } = await setup(t, 120, 32, ({ data }) => {
    data.idle = false
    const last = data.messages.at(-1)!.info
    if (last.role === "assistant") { last.finish = undefined; last.time.completed = undefined }
  })
  await until(() => frame().includes("Ready."))
  key(KeyCodes.ARROW_DOWN)
  key(KeyCodes.ARROW_DOWN)
  key("return")
  await until(() => frame().includes("Turn reader · Turn 3"))
  assert.ok(frame().includes("Question 2"))
  assert.ok(frame().includes("No completed final assistant response yet"))
  assert.ok(!frame().includes("Answer 2"))
  assert.equal(data.jobs, 0)
})

test("rows use the default four-line maximum, uppercase kinds and sparse stats", async (t) => {
  const { screen, frame, until, type } = await setup(t, 180, 48, ({ data }) => {
    const first = data.messages[0].parts[0]
    if (first.type === "text") first.text = "USER_FIRST\nUSER_SECOND\nUSER_THIRD\nUSER_FOURTH_HIDDEN"
    const op = { ...operation("compact", [turns(data.messages)[1]]), summary: "SUMMARY_FIRST\nSUMMARY_SECOND\nSUMMARY_THIRD\nSUMMARY_FOURTH_HIDDEN" }
    data.session.metadata![KEY] = append(emptyPolicy(data.session.id), op)
  })
  await until(() => frame().includes("Ready."))
  const find = (id: string) => screen.renderer.root.findDescendantById(id)!
  const first = find("cm-range-0")
  const summary = find("cm-range-1")
  const next = find("cm-range-2")
  assert.equal(first.height, 4)
  assert.equal(summary.height, 4)
  assert.equal(summary.y - first.y, 4)
  assert.equal(next.y - summary.y, 4)
  assert.equal(next.height, 3, "A short USER entry must not be padded to the maximum")
  assert.equal(find("cm-range-stats-0").y, first.y + 1)
  assert.equal((find("cm-range-stats-0") as TextRenderable).plainText, "tools:1 · eligible:1")
  assert.equal(find("cm-range-preview-0").y, first.y + 2)
  assert.equal(find("cm-range-preview-0").height, 2)
  assert.equal(find("cm-range-preview-1").y, summary.y + 1)
  assert.equal(screen.renderer.root.findDescendantById("cm-range-stats-1"), undefined)
  assert.match((find("cm-range-title-0") as TextRenderable).plainText, /^\[ \] Turn 1 · USER · ≈/)
  assert.match((find("cm-range-title-1") as TextRenderable).plainText, / · COMPACT · /)
  assert.ok(!frame().includes("USER_THIRD") && frame().includes("SUMMARY_THIRD"))
  assert.ok(!frame().includes("USER_FOURTH_HIDDEN") && !frame().includes("SUMMARY_FOURTH_HIDDEN"))
  assert.ok(!frame().includes("Earlier conversation range") && !frame().includes("expand one layer"))
  await type("n")
  await until(() => (find("cm-range-title-0") as TextRenderable).plainText.includes("chars"))
  assert.equal(find("cm-range-1").y - find("cm-range-0").y, 4)
})

test("content-sized list keeps wrapping previews clipped and distant cursor visible across readers", async (t) => {
  const { data, screen, frame, until, type, key, esc } = await setup(t, 80, 24, ({ data }) => {
    data.messages = messages(data.session.id, 20)
    const part = data.messages[0].parts[0]
    if (part.type === "text") part.text = "WRAPPED_PREVIEW ".repeat(100)
  })
  await until(() => frame().includes("Ready."))
  const preview = screen.renderer.root.findDescendantById("cm-range-preview-text-0") as TextRenderable
  assert.ok(preview.virtualLineCount > 3)
  preview.scrollY = 1
  assert.equal(preview.scrollY, 0, "Wheel scrolling must not change which text begins the preview")
  for (let line = 0; line < 2; line++) assert.ok(frame().split("\n")[preview.y + line].includes("WRAPPED_PREVIEW"))
  key(KeyCodes.END)
  await until(() => frame().includes("Turn 20"))
  const list = screen.renderer.root.findDescendantById("cm-ranges") as ScrollBoxRenderable
  const last = screen.renderer.root.findDescendantById("cm-range-19")!
  assert.ok(last.y >= list.viewport.y)
  assert.ok(last.y + last.height <= list.viewport.y + list.viewport.height)
  key("return")
  await until(() => frame().includes("Turn reader · Turn 20"))
  esc()
  await until(() => frame().includes("Turn 20") && !frame().includes("Turn reader"))
  const restoredList = screen.renderer.root.findDescendantById("cm-ranges") as ScrollBoxRenderable
  const restoredLast = screen.renderer.root.findDescendantById("cm-range-19")!
  assert.ok(restoredLast.y >= restoredList.viewport.y && restoredLast.y + restoredLast.height <= restoredList.viewport.y + restoredList.viewport.height)
  screen.renderer.resize(100, 28)
  await until(() => restoredList.viewport.width > 35 && restoredLast.y >= restoredList.viewport.y && restoredLast.y + restoredLast.height <= restoredList.viewport.y + restoredList.viewport.height)
  const page = Math.ceil(restoredList.viewport.height / restoredLast.height)
  key("pageup")
  key("return")
  await until(() => frame().includes(`Turn reader · Turn ${20 - page}`))
  esc()
  await until(() => !frame().includes("Turn reader"))
  key(KeyCodes.END)
  await until(() => frame().includes("Turn 20"))
  await type(" ")
  key(KeyCodes.ARROW_UP)
  await type(" p")
  await until(() => readPolicy(data.session).cursor === 1 && frame().includes("Ready."))
  assert.deepEqual(readPolicy(data.session).operations[0].sourceIDs, data.messages.slice(-4).map((message) => message.info.id))
  assert.equal(data.jobs, 0)
})

for (const limit of [3, 6]) test(`configured ${limit}-line rows shrink to content without blank padding`, async (t) => {
  const { screen, frame, until } = await setup(t, 180, 48, ({ data }) => {
    const first = data.messages[0].parts[0]
    if (first.type === "text") first.text = "One\n\nTwo\n\nThree\nFour\nFive\nSix"
    const op = { ...operation("brief", [turns(data.messages)[1]]), summary: "Short summary" }
    data.session.metadata![KEY] = append(emptyPolicy(data.session.id), op)
  }, { ui: { maxLinesPerTurn: limit } })
  await until(() => frame().includes("Ready."))
  const row = screen.renderer.root.findDescendantById("cm-range-0")!
  const summary = screen.renderer.root.findDescendantById("cm-range-1")!
  const next = screen.renderer.root.findDescendantById("cm-range-2")!
  assert.equal(row.height, limit)
  assert.equal(summary.height, 2)
  assert.equal(summary.y, row.y + row.height)
  assert.equal(next.y, summary.y + summary.height)
  assert.match((screen.renderer.root.findDescendantById("cm-range-title-1") as TextRenderable).plainText, / · BRIEF · /)
})

test("R labels identify closed/open ranges and unfinished endpoints remain selectable while busy", async (t) => {
  const { data, screen, frame, until, type, key } = await setup(t, 180, 48, ({ data }) => {
    const first = data.messages[1].info
    if (first.role === "assistant") { first.finish = "tool-calls"; first.time.completed = undefined }
    data.messages.pop()
    data.idle = false
  })
  const title = (index: number) => (screen.renderer.root.findDescendantById(`cm-range-title-${index}`) as TextRenderable).plainText
  await until(() => frame().includes("Ready."))
  await type(" ")
  await until(() => title(0).includes("R1*"))
  await type(" ")
  await until(() => title(0).includes("R1 ·"))
  assert.match(title(0), /\[\+\] R1 · Turn 1 · USER/)
  key(KeyCodes.END)
  await type(" ")
  await until(() => title(2).includes("R2*"))
  key(KeyCodes.ARROW_UP)
  await type(" ")
  await until(() => title(1).includes("R2 ·") && title(2).includes("R2 ·"))
  assert.ok(title(1).includes("R2 ·") && title(2).includes("R2 ·"))
  assert.equal((screen.renderer.root.findDescendantById("cm-range-stats-2") as TextRenderable).plainText, "tools:0")
  await type("b")
  await until(() => frame().includes("Wait for the main session to become idle"))
  assert.equal(data.calls.length, 0)
  data.idle = true
  await type("b")
  await until(() => frame().includes("Summaries applied automatically"))
  assert.equal(readPolicy(data.session).cursor, 2)
})

function pausedControl() {
  const state: AutoState = { strategy: "MANUAL", pause: { id: "pause_fixture", userID: "msg_2_u", phase: "manual", tokens: 100, threshold: 50, inputLimit: 20050, derived: false, message: "Reduce earlier context" } }
  const calls: AutoCommand[] = []
  const control: AutoControl = {
    state: async () => structuredClone(state),
    command: async (_id, command) => {
      calls.push(command)
      if (command.action === "strategy") state.strategy = command.strategy
      if (command.action === "run") state.pause!.phase = "auto"
      if (command.action === "resume" || command.action === "abort") state.pause = undefined
      return structuredClone(state)
    },
    commit: async () => { throw new Error("No test context writes expected") },
  }
  return { state, calls, control }
}

test("paused inspector saves strategy without executing and explicit Run starts it", async (t) => {
  const { state, calls, control } = pausedControl()
  const { frame, until, type, key } = await setup(t, 140, 35, ({ host }) => { host.auto = control })
  await until(() => frame().includes("PAUSED"))
  await type("a")
  await until(() => frame().includes("Autocompaction strategy"))
  assert.ok(frame().includes("MANUAL") && frame().includes("AUTO_PER_TURN") && frame().includes("AUTO_SESSION"), "All strategies must be visible together when the terminal has room")
  key(KeyCodes.ARROW_DOWN)
  key(KeyCodes.ARROW_DOWN)
  key("return")
  await until(() => frame().includes("Strategy saved"))
  assert.equal(state.strategy, "AUTO_SESSION")
  assert.deepEqual(calls.map((call) => call.action), ["strategy"])
  await type("g")
  await until(() => frame().includes("PAUSED (auto)"))
  assert.deepEqual(calls.map((call) => call.action), ["strategy", "run"])
})

test("paused exit requires confirmation, blocks over-budget resume, and stays within 80x24", async (t) => {
  const { state, calls, control } = pausedControl()
  const { frame, screen, until, type, esc, navigations } = await setup(t, 80, 24, ({ host }) => { host.auto = control })
  await until(() => frame().includes("PAUSED"))
  esc()
  await until(() => frame().includes("Leave the suspended"))
  const dialog = screen.renderer.root.findDescendantById("cm-pause-exit")!
  assert.ok(dialog.y + dialog.height <= 24)
  await type("r")
  assert.equal(calls.length, 0)
  assert.equal(navigations.length, 0)
  await type("s")
  await until(() => !frame().includes("Leave the suspended"))
  state.pause!.tokens = 40
  await until(() => frame().includes("≈40 / 50"))
  esc()
  await until(() => frame().includes("Resume and exit"))
  await type("r")
  await until(() => navigations.includes("session"))
  assert.deepEqual(calls.map((call) => call.action), ["resume"])
})

test("strategy picker fits all options at 80x24 and scrolls only when the terminal is too short", async (t) => {
  const { state, calls, control } = pausedControl()
  const { frame, screen, until, type, key } = await setup(t, 80, 24, ({ host }) => { host.auto = control })
  await until(() => frame().includes("PAUSED"))
  await type("a")
  await until(() => frame().includes("AUTO_SESSION"))
  const picker = screen.renderer.root.findDescendantById("cm-strategy-picker")!
  const options = screen.renderer.root.findDescendantById("cm-strategy-options")!
  assert.equal(picker.height, 12)
  assert.equal(options.height, 6)
  assert.ok(frame().includes("Open inspector; confirm before resume"))
  assert.ok(frame().includes("Oldest USER first, then one whole-prefix fallback"))
  assert.ok(frame().includes("One whole-prefix pass, excluding active USER"))
  screen.renderer.resize(80, 12)
  await until(() => picker.height === 9)
  assert.ok(picker.y + picker.height <= 12)
  assert.ok(options.y + options.height <= picker.y + picker.height - 2)
  key(KeyCodes.ARROW_DOWN)
  key(KeyCodes.ARROW_DOWN)
  await until(() => frame().includes("AUTO_SESSION"))
  assert.equal(calls.length, 0)
  screen.renderer.resize(80, 24)
  await until(() => picker.height === 12 && frame().includes("AUTO_PER_TURN"))
  assert.ok(frame().includes("Open inspector; confirm before resume"))
  assert.ok(frame().includes("One whole-prefix pass, excluding active USER"))
  key("return")
  await until(() => frame().includes("Strategy saved"))
  assert.equal(state.strategy, "AUTO_SESSION")
  assert.deepEqual(calls.map((call) => call.action), ["strategy"])
})

test("paused exit can abort instead of resuming above threshold", async (t) => {
  const { calls, control } = pausedControl()
  const { frame, until, type, esc, navigations } = await setup(t, 100, 30, ({ host }) => { host.auto = control })
  await until(() => frame().includes("PAUSED"))
  esc()
  await until(() => frame().includes("Leave the suspended"))
  await type("a")
  await until(() => navigations.includes("session"))
  assert.deepEqual(calls.map((call) => call.action), ["abort"])
})

test("automatic inspector opening verifies a live gate and ignores stale metadata", async () => {
  const { state, control } = pausedControl()
  const opened: string[] = []
  let handler: ((event: { type: "session.updated"; properties: { info: { id: string; metadata: Record<string, unknown> } } }) => void) | undefined
  const api = {
    event: { on: (_type: string, fn: typeof handler) => { handler = fn; return () => { handler = undefined } } },
    route: { current: { name: "session", params: { sessionID: "ses_test" } }, navigate: (name: string) => { opened.push(name) } },
    ui: { dialog: { open: false }, toast: () => {} },
  } as unknown as TuiPluginApi
  const off = watchSuspensions(api, async () => control)
  const metadata = { [AUTO_KEY]: structuredClone(state) }
  state.pause = undefined
  handler!({ type: "session.updated", properties: { info: { id: "ses_test", metadata } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(opened.length, 0)
  state.pause = pausedControl().state.pause
  handler!({ type: "session.updated", properties: { info: { id: "ses_test", metadata } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(opened, ["context-manager"])
  off()
  assert.equal(handler, undefined)
})
