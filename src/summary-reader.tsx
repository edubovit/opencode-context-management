/** @jsxImportSource @opentui/solid */
import { inputBlocked, type InspectorUI } from "./ui.ts"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { createSignal, onCleanup, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { ModelChoice } from "./controller.ts"
import { SummaryEditor } from "./summary-editor.ts"
import { tokenCount } from "./tokens.ts"
import { Hotkeys, type HotkeyLine } from "./tui-help.tsx"

export function SummaryReader(props: {
  api: InspectorUI; editor: SummaryEditor; choice: () => ModelChoice | undefined
  modalOpen: () => boolean; pick: (kind: "model" | "effort") => void; close: () => Promise<void>
}) {
  const [mode, setMode] = createSignal<"read" | "edit" | "request">("read")
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal("Read-only. Model changes are reviewed before application.")
  const [help, setHelp] = createSignal(false)
  const [epoch, setEpoch] = createSignal(0)
  const [buffer, setBuffer] = createSignal("")
  const [instruction, setInstruction] = createSignal("")
  const text = () => { epoch(); return props.editor.text }
  let scroll: ScrollBoxRenderable | undefined
  let textarea: TextareaRenderable | undefined
  let request: TextareaRenderable | undefined
  onCleanup(() => { void props.editor.dispose().catch((error) => props.api.ui.toast.show({ message: String(error), variant: "warning" })) })
  const run = async (task: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    try { await task() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const apply = async (value?: string) => {
    const warning = await props.editor.apply(value)
    setEpoch((value) => value + 1)
    setMode("read")
    scroll?.scrollTo(0)
    setNotice(warning ?? "Summary updated. The editing dialogue was disposed. Saved changes have no Undo.")
  }
  useKeyboard((key) => {
    if (key.defaultPrevented || inputBlocked(props.api) || props.modalOpen()) return
    if (help()) { if (key.name === "escape" || key.name === "?") { key.preventDefault(); setHelp(false) }; return }
    if (key.name === "escape") {
      key.preventDefault()
      if (busy()) { void props.editor.cancel().catch((error) => setNotice(String(error))); return }
      if (mode() !== "read") {
        setNotice(mode() === "edit" ? "Manual edits cancelled. Read-only." : "Request editor closed; proposed edits remain unapplied.")
        setMode("read")
        return
      }
      void run(props.close)
      return
    }
    if (busy()) return
    if (mode() === "edit") {
      if (key.ctrl && key.name === "s") { key.preventDefault(); void run(() => apply(buffer())) }
      return
    }
    if (mode() === "request") {
      if (key.ctrl && key.name === "s") {
        key.preventDefault()
        void run(async () => {
          const choice = props.choice()
          if (!choice) throw new Error("Choose an editing model first")
          await props.editor.request(instruction(), choice)
          setEpoch((value) => value + 1)
          setMode("read")
          setInstruction("")
          scroll?.scrollTo(0)
          setNotice("Proposed edit — not applied. Read it, request another change, or press Ctrl+S to apply.")
        })
      }
      if (key.ctrl && key.name === "o") { key.preventDefault(); props.pick("model") }
      if (key.ctrl && key.name === "t") { key.preventDefault(); props.pick("effort") }
      return
    }
    if (["up", "down", "left", "right", "pageup", "pagedown", "home", "end"].includes(key.name)) {
      key.preventDefault()
      if (key.name === "home") scroll?.scrollTo(0)
      else if (key.name === "end") scroll?.scrollTo(scroll.scrollHeight)
      else if (key.name === "pageup" || key.name === "pagedown") scroll?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport")
      else scroll?.scrollBy(key.name === "up" || key.name === "left" ? -10 : 10)
      return
    }
    if (key.ctrl && key.name === "s") { key.preventDefault(); void run(() => apply()) ; return }
    if (key.ctrl || key.meta) return
    const actions: Record<string, () => void> = {
      e: () => { setBuffer(text()); setMode("edit"); setNotice("Manual editing. Ctrl+S saves; Esc cancels.") },
      r: () => { setMode("request"); setNotice("Only the summary and this editing dialogue are sent. The response will be reviewed before applying.") },
      m: () => props.pick("model"), t: () => props.pick("effort"), "?": () => setHelp(true),
    }
    if (actions[key.name]) { key.preventDefault(); actions[key.name]() }
  })
  const hints = (): HotkeyLine[] => props.modalOpen() ? [["MODEL PICKER", { key: "Up/Down", label: "select" }, { key: "Enter", label: "confirm" }, { key: "Esc", label: "cancel" }]]
    : busy() ? [[{ key: "Esc", label: "cancels model requests; writes already in progress may finish" }]]
    : help() ? [[{ key: "Esc", label: "close help" }]]
    : mode() === "edit" ? [["MANUAL EDIT", { key: "Ctrl+S", label: "save summary" }, { key: "Esc", label: "cancel manual edits" }]]
    : mode() === "request" ? [["MODEL REQUEST", { key: "Ctrl+S", label: "send" }, { key: "Esc", label: "return to reader" }], [{ key: "Ctrl+O", label: "model" }, { key: "Ctrl+T", label: "effort — response will be reviewed, not autoapplied" }]]
    : [
      [{ key: "?", label: "help" }, { key: "Arrows", label: "10 lines" }, { key: "PgUp/PgDn", label: "page" }, { key: "r", label: "request change" }, { key: "e", label: "manual edit" }],
      [...(props.editor.draft === undefined ? [] : [{ key: "Ctrl+S", label: "apply proposed edit" }]), { key: "m", label: "model" }, { key: "t", label: "effort" }, { key: "Esc", label: "discard edits and return" }],
    ]
  return <box width="100%" height="100%" flexDirection="column" overflow="hidden" padding={1}>
    <text height={1} wrapMode="none" truncate fg={props.api.theme.text.base}>Summary reader · SUMMARY · {mode() === "read" ? "READ-ONLY" : mode().toUpperCase()}{busy() ? " · WORKING" : ""}</text>
    <text height={1} wrapMode="none" truncate>{`≈${tokenCount(text(), props.editor.view.tokenizer.encoding)} tokens · ${props.editor.draft === undefined ? "Applied summary" : "Proposed edit (not applied)"} · ${props.choice()?.providerID}/${props.choice()?.modelID} · ${props.choice()?.variant ?? "default"}`}</text>
    <text height={2} width="100%" overflow="hidden">{notice()}</text>
    <box id="cm-summary-header-rule" width="100%" height={1} flexShrink={0} border={["top"]} borderStyle="single" borderColor={props.api.theme.border.base} />
    <Show when={help()} fallback={
      <Show when={mode() === "edit"} fallback={
        <scrollbox id="cm-summary-scroll" flexGrow={1} minHeight={0} ref={(value) => { scroll = value }} focused={!busy() && !props.modalOpen() && mode() === "read"}>
          <text selectable wrapMode="word">{text()}</text>
        </scrollbox>
      }>
        <textarea id="cm-summary-edit" flexGrow={1} minHeight={0} initialValue={buffer()} ref={(value) => { textarea = value }} onContentChange={() => { if (textarea) setBuffer(textarea.plainText) }} focused={!busy() && !props.modalOpen()} />
      </Show>
    }>
      <scrollbox flexGrow={1} minHeight={0} focused={!props.modalOpen()}><text>{`SUMMARY READER\n\nArrows: scroll 10 lines. PageUp/PageDown: one viewport. Home/End: start/end.\n\ne: enter manual editing; Ctrl+S saves, Esc cancels.\nr: ask a model to revise the current summary. The first request contains only the applied summary and your instructions, not original conversation context.\nSubsequent requests use the same edit dialogue and proposed summary. Ctrl+S applies the proposed edit. Applying or leaving the reader deletes that dialogue.\n\nm/t: choose next editing model/effort.\nEsc in the reader discards proposed edits and returns to ranges.\nSaved changes have no Undo. Summary expansion restores the pre-summary context, including earlier pruning.`}</text></scrollbox>
    </Show>
    <Show when={!help() && mode() === "request"}>
      <text height={1} fg={props.api.theme.text.formfield.base}>Requested summary changes:</text>
      <textarea id="cm-summary-request" height={4} flexShrink={0} initialValue={instruction()} ref={(value) => { request = value }} onContentChange={() => { if (request) setInstruction(request.plainText) }} focused={!busy() && !props.modalOpen()} />
    </Show>
    <box id="cm-summary-footer-rule" width="100%" height={1} flexShrink={0} border={["top"]} borderStyle="single" borderColor={props.api.theme.border.base} />
    <Hotkeys api={props.api} lines={hints()} />
  </box>
}
