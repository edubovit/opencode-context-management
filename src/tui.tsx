/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Model } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Controller, type Loaded, type ModelChoice, type MultiRestorePreview } from "./controller.ts"
import { blockMessages, nativeActive, serialize, type Block, type RestoreMode } from "./context.ts"
import { SummaryBatch } from "./batch.ts"
import { SummaryEditor } from "./summary-editor.ts"
import { SummaryReader } from "./summary-reader.tsx"
import { TurnReader } from "./turn-reader.tsx"
import { RangeList } from "./range-list.tsx"
import { rangePreview, rangeToolStats } from "./range-rows.ts"
import { Hotkeys, type HotkeyLine } from "./tui-help.tsx"
import { anchorRanges, pressSpace, rangeIDs, rangeTag, selectedBlocks, visibleRanges, type Selection } from "./ranges.ts"
import { bindPruneRule } from "./text.ts"
import { distribution } from "./snapshot.ts"
import { sdkHost } from "./sdk-host.ts"
import { Storage } from "./storage.ts"
import { settings, VERSION } from "./config.ts"
import { operationLabel, rangeLabel, toolStatus, turnIndex } from "./status.ts"
import { FALLBACK_BASIS, tokenLabel } from "./tokens.ts"
import { AUTO_KEY, STRATEGIES, type AutoState, type AutoControl } from "./auto-state.ts"
import { controlClient } from "./control.ts"

export function Inspector(props: { api: TuiPluginApi; sessionID: string; controller: Controller }) {
  const api = props.api
  const dimensions = useTerminalDimensions()
  const [loaded, setLoaded] = createSignal<Loaded>()
  const [cursor, setCursor] = createSignal(0)
  const [selection, setSelection] = createSignal<Selection>({ ranges: [] })
  const [busy, setBusy] = createSignal(false)
  const [pane, setPane] = createSignal<"list" | "content">("list")
  const [notice, setNotice] = createSignal("Loading full session history…")
  const [view, setView] = createSignal<"distribution" | "content" | "runtime">("distribution")
  const summaries = new SummaryBatch(props.controller)
  const [runningBatch, setRunningBatch] = createSignal(false)
  const [reader, setReader] = createSignal<{ kind: "summary"; editor: SummaryEditor } | { kind: "turn"; block: Block; label: string }>()
  const [help, setHelp] = createSignal(false)
  const [epoch, setEpoch] = createSignal(0)
  const [models, setModels] = createSignal<Model[]>([])
  const [choice, setChoice] = createSignal<ModelChoice>()
  const [picker, setPicker] = createSignal<"model" | "effort">()
  const [query, setQuery] = createSignal("")
  const [pickerIndex, setPickerIndex] = createSignal(0)
  const [restoring, setRestoring] = createSignal<MultiRestorePreview>()
  const [unit, setUnit] = createSignal<"tokens" | "characters">("tokens")
  const [auto, setAuto] = createSignal<AutoState>({ strategy: "MANUAL" })
  const [strategyPicker, setStrategyPicker] = createSignal(false)
  const [strategyIndex, setStrategyIndex] = createSignal(0)
  const [exitDialog, setExitDialog] = createSignal(false)
  const automatic = () => auto().pause?.phase === "auto"
  const canResume = () => auto().pause?.phase === "manual" && auto().pause!.tokens <= auto().pause!.threshold
  const basis = () => loaded()?.tokenizer ?? FALLBACK_BASIS
  const rule = () => loaded()?.pruneRule ?? bindPruneRule(props.controller.config.prune, basis())
  const size = (value: number) => unit() === "tokens" ? `≈${value.toLocaleString()} tokens` : `${value.toLocaleString()} chars`
  const popMode = api.mode.push("context-manager")
  onCleanup(() => { popMode(); void Promise.all([summaries.dispose(), props.controller.dispose()]).catch((error) => api.ui.toast({ message: String(error), variant: "warning" })) })
  const blocks = () => loaded()?.blocks ?? []
  const sourceTurns = createMemo(() => turnIndex(nativeActive(loaded()?.raw ?? [], loaded()?.session.revert)))
  const ranges = () => visibleRanges(selection(), cursor())
  const inspected = () => selectedBlocks(blocks(), ranges())
  const selectedIDs = () => rangeIDs(blocks(), selection())
  const touch = () => setEpoch((value) => value + 1)
  const refresh = async (anchor?: string[][], focus?: string[]) => {
    const next = await props.controller.load()
    setLoaded(next)
    if (next.auto) setAuto(next.auto)
    setModels(next.models)
    if (!choice()) setChoice(props.controller.defaultModel(next))
    const selected = anchor ? anchorRanges(next.blocks, anchor) : { ranges: [] }
    setSelection(selected)
    const focused = focus ? next.blocks.findIndex((block) => block.sourceIDs[0] === focus[0]) : -1
    setCursor(focused >= 0 ? focused : selected.ranges[0]?.start ?? 0)
    setNotice("Ready. Context counts are local estimates; missing overhead is not zero.")
  }
  const run = async (task: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    try { await task() }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  onMount(() => void run(refresh))
  onMount(() => {
    if (!props.controller.host.auto) return
    let alive = true
    let checking = false
    const timer = setInterval(async () => {
      if (!alive || checking || busy()) return
      checking = true
      try {
        const next = await props.controller.host.auto!.state(props.sessionID)
        if (!alive) return
        const previous = auto().pause
        setAuto(next)
        if (previous && !next.pause) { api.route.navigate("session", { sessionID: props.sessionID }); return }
        if (previous?.phase === "auto" && next.pause?.phase === "manual") await refresh()
      } catch (error) { if (alive) setNotice(`Context control unavailable: ${error instanceof Error ? error.message : String(error)}`) }
      finally { checking = false }
    }, 500)
    onCleanup(() => { alive = false; clearInterval(timer) })
  })
  const autoCommand = async (action: "run" | "resume" | "abort") => {
    const control = props.controller.host.auto
    const pause = auto().pause
    if (!control || !pause) throw new Error("There is no live suspended run")
    const next = await control.command(props.sessionID, { action, pauseID: pause.id, ...(action === "run" ? { model: choice() } : {}) })
    setAuto(next)
    if (action !== "run") { setExitDialog(false); api.route.navigate("session", { sessionID: props.sessionID }) }
  }
  const openStrategy = () => {
    if (!props.controller.host.auto) { setNotice("Restart both entrypoints to enable autocompaction controls"); return }
    setStrategyIndex(STRATEGIES.indexOf(auto().strategy))
    setStrategyPicker(true)
  }
  const saveStrategy = async () => {
    setAuto(await props.controller.host.auto!.command(props.sessionID, { action: "strategy", strategy: STRATEGIES[strategyIndex()] }))
    setStrategyPicker(false)
    setNotice("Strategy saved for this session. While paused, g explicitly runs the selected AUTO strategy.")
  }
  const finishBatch = async () => {
    touch()
    if (!summaries.ready) { setNotice("Batch incomplete or cancelled. No changes applied. Retry failed ranges or discard the batch."); return }
    const ids = summaries.entries.map((entry) => entry.ids)
    const warning = await summaries.apply()
    setRunningBatch(false)
    await refresh(ids)
    setNotice(warning ?? "Summaries applied automatically. Hover a summary and press Enter to read or edit it.")
  }
  const beginSummary = async (mode: "compact" | "brief") => {
    const ids = selectedIDs()
    await summaries.start(mode, ids, choice())
    setLoaded(summaries.snapshot)
    setSelection(anchorRanges(summaries.snapshot!.blocks, ids))
    setRunningBatch(true)
    setNotice(`Generating ${ids.length} ${mode} ranges in parallel from one frozen pre-compaction context…`)
    await summaries.generate(touch)
    await finishBatch()
  }
  const openReader = async () => {
    const block = blocks()[cursor()]
    if (!block) throw new Error("Hover a turn or summary and press Enter")
    if (block.summaryID) {
      setReader({ kind: "summary", editor: new SummaryEditor(props.controller, await props.controller.summary(block.summaryID)) })
      return
    }
    setReader({ kind: "turn", block, label: rangeLabel(block.sourceIDs, sourceTurns()) })
  }
  const closeSummary = async () => {
    const current = reader()!
    if (current.kind !== "summary") return
    const anchors = selection().ranges.map((range) => blocks().slice(range.start, range.end + 1).flatMap((block) => block.sourceIDs))
    await current.editor.dispose()
    setReader(undefined)
    await refresh(anchors, current.editor.view.block.sourceIDs)
  }
  const previewRestore = async (mode: RestoreMode) => {
    setRestoring(await props.controller.prepareRestoreRanges(mode, selectedIDs()))
  }
  const confirmRestore = async () => {
    const preview = restoring()!
    await props.controller.applyOperations(preview.operations, preview)
    setRestoring(undefined)
    await refresh(preview.ranges)
    setNotice(`${preview.mode} applied to selected ranges. Unselected gaps are unchanged.`)
  }
  const changeHistory = async (delta: -1 | 1) => {
    const policy = loaded()?.policy
    const op = policy?.operations[policy.cursor + (delta < 0 ? -1 : 0)]
    await props.controller.undo(delta)
    await refresh(op ? [op.sourceIDs] : undefined)
  }
  const pickerOptions = createMemo(() => {
    const current = choice()
    if (picker() === "model") return [...models()].sort((a, b) => `${a.providerID}/${a.name}`.localeCompare(`${b.providerID}/${b.name}`)).map((model) => ({
      name: model.name, description: `${model.providerID}/${model.id}`,
      value: { providerID: model.providerID, modelID: model.id, variant: current?.providerID === model.providerID && current.modelID === model.id ? current.variant ?? "default" : "default" },
    }))
    if (!current) return []
    const model = models().find((m) => m.providerID === current.providerID && m.id === current.modelID)
    const variants = Object.entries(model?.variants ?? {}).filter(([name, options]) => name !== "default" && options.disabled !== true).map(([name]) => name)
    return ["default", ...variants].map((variant) => ({
      name: variant === "default" ? "Default" : variant,
      description: variant === "default" ? "Provider/model default; no forced effort override" : "Model-supported reasoning / configuration variant",
      value: { ...current, variant },
    }))
  })
  const filteredOptions = createMemo(() => pickerOptions().filter((option) => `${option.name} ${option.description}`.toLowerCase().includes(query().trim().toLowerCase())))
  const openPicker = (kind: "model" | "effort") => {
    if (busy() || restoring()) return
    if (kind === "effort" && !choice()) { setNotice("Choose a compaction model first"); return }
    setQuery("")
    setPicker(kind)
    const current = choice()
    setPickerIndex(Math.max(0, pickerOptions().findIndex(({ value }) => value.providerID === current?.providerID && value.modelID === current?.modelID && (kind === "model" || value.variant === (current?.variant ?? "default")))))
  }
  const chooseOption = (index = pickerIndex()) => {
    const option = filteredOptions()[index]
    if (!option) return
    setChoice(option.value)
    if (runningBatch()) for (const entry of summaries.entries) if (!entry.draft) entry.choice = { ...option.value }
    setPicker(undefined)
  }
  useKeyboard((key) => {
    if (api.ui?.dialog?.open) return
    if (exitDialog()) {
      key.preventDefault()
      if (busy()) return
      if (key.name === "escape" || key.name === "s") setExitDialog(false)
      if (key.name === "r" && canResume()) void run(() => autoCommand("resume"))
      if (key.name === "a") void run(() => autoCommand("abort"))
      return
    }
    if (strategyPicker()) {
      key.preventDefault()
      if (busy()) return
      if (key.name === "escape") setStrategyPicker(false)
      if (key.name === "up") setStrategyIndex(Math.max(0, strategyIndex() - 1))
      if (key.name === "down") setStrategyIndex(Math.min(STRATEGIES.length - 1, strategyIndex() + 1))
      if (key.name === "return") void run(saveStrategy)
      return
    }
    if (help()) { if (key.name === "escape" || key.name === "?") { key.preventDefault(); setHelp(false) }; return }
    if (restoring()) {
      if (key.name === "escape" && !busy()) { key.preventDefault(); setRestoring(undefined) }
      if (key.ctrl && key.name === "s") { key.preventDefault(); void run(confirmRestore) }
      return
    }
    if (picker()) {
      if (key.name === "escape") { key.preventDefault(); setPicker(undefined) }
      if (key.name === "up") { key.preventDefault(); setPickerIndex(Math.max(0, pickerIndex() - 1)) }
      if (key.name === "down") { key.preventDefault(); setPickerIndex(Math.max(0, Math.min(filteredOptions().length - 1, pickerIndex() + 1))) }
      if (key.name === "return") { key.preventDefault(); chooseOption() }
      return
    }
    if (reader()) return
    if (key.name === "escape") {
      key.preventDefault()
      if (busy()) { void summaries.cancel().catch((e) => setNotice(String(e))); return }
      if (runningBatch()) {
        void run(async () => { await summaries.discard(); setRunningBatch(false); touch(); setNotice("Batch discarded; context unchanged.") })
        return
      }
      if (selection().anchor !== undefined) { setSelection({ ranges: selection().ranges }); return }
      if (auto().pause) { setExitDialog(true); return }
      api.route.navigate("session", { sessionID: props.sessionID })
      return
    }
    if (runningBatch()) {
      if (busy()) return
      if (key.name === "g") { key.preventDefault(); void run(async () => { await summaries.generate(touch); await finishBatch() }) }
      if (key.name === "m") { key.preventDefault(); openPicker("model") }
      if (key.name === "t") { key.preventDefault(); openPicker("effort") }
      return
    }
    if (busy() || automatic()) return
    if (key.ctrl && key.name === "u") { key.preventDefault(); void run(() => previewRestore("unprune")); return }
    if (key.ctrl && key.name === "e") { key.preventDefault(); void run(() => previewRestore("expand")); return }
    if (key.ctrl || key.meta) return
    if (key.name === "tab") { key.preventDefault(); setPane(pane() === "list" ? "content" : "list"); return }
    const actions: Record<string, () => void | Promise<void>> = {
      return: () => run(openReader),
      a: openStrategy,
      g: () => run(() => autoCommand("run")),
      "?": () => { setHelp(true) },
      space: () => { if (pane() !== "list") return; try { setSelection(pressSpace(selection(), cursor(), blocks())) } catch (error) { setNotice(String(error)) } },
      p: () => run(async () => { const ids = selectedIDs(); await props.controller.pruneRanges(ids); await refresh(ids) }),
      c: () => run(() => beginSummary("compact")),
      b: () => run(() => beginSummary("brief")),
      m: () => openPicker("model"),
      t: () => openPicker("effort"),
      u: () => run(() => changeHistory(-1)),
      r: () => run(() => changeHistory(1)),
      f: () => run(refresh),
      o: () => run(async () => { setNotice(`Snapshot saved: ${await props.controller.dump(api.app.version)}`) }),
      v: () => { setView(view() === "distribution" ? "content" : view() === "content" ? "runtime" : "distribution") },
      n: () => { setUnit(unit() === "tokens" ? "characters" : "tokens") },
    }
    const action = actions[key.name]
    if (action) { key.preventDefault(); void action() }
  })
  const rows = createMemo(() => blocks().map((block, index) => {
    const selected = ranges().some((range) => index >= range.start && index <= range.end)
    const tag = rangeTag(selection(), cursor(), index)
    const status = toolStatus([block], rule(), basis())
    return {
      title: `${selected ? "[+]" : "[ ]"} ${tag ? `${tag} · ` : ""}${rangeLabel(block.sourceIDs, sourceTurns())} · ${block.kind === "turn" ? "USER" : block.kind.toUpperCase()} · ${size(distribution([block], undefined, basis(), unit()).total)}${block.closed ? "" : " · unfinished"}${auto().pause && block.sourceIDs.includes(auto().pause!.userID) ? " · PROTECTED" : ""}`,
      stats: block.kind === "turn" ? rangeToolStats(status) : undefined,
      preview: rangePreview(block, loaded()!.policy),
    }
  }))
  const stats = (selected: boolean) => {
    const items = selected ? inspected() : blocks()
    const data = distribution(items, selected ? undefined : loaded()?.runtime, basis(), unit())
    const status = toolStatus(items, rule(), basis())
    const value = (key: string) => data.unavailableCategories.includes(key) ? "unavailable" : data.counts[key].toLocaleString()
    return [
      selected ? `SELECTED RANGES (${selection().ranges.length}${selection().anchor !== undefined ? " + open" : ""})` : "WHOLE EFFECTIVE CONTEXT",
      `Total categorized text: ${size(data.total)}`,
      statusLabel(status),
      `user: ${value("user")} · assistant: ${value("assistant")} · summaries: ${value("summaries")}`,
      `reasoning: ${value("reasoning")} · toolInputs: ${value("toolInputs")}`,
      `toolOutputs: ${value("toolOutputs")} · loadedSkills: ${value("loadedSkills")}`,
      ...(!selected ? [`system: ${value("systemPrompts")} · skills: ${value("advertisedSkills")}`, `toolSchemas: ${value("capturedToolDefinitions")}`] : []),
      `Attachments: ${data.attachments} (token cost unknown) · Prune delta: ${signed(unit() === "tokens" ? status.pruneDelta : status.pruneCharDelta)}`,
    ].join("\n")
  }
  const globalStats = createMemo(() => loaded() ? stats(false) : "WHOLE EFFECTIVE CONTEXT\nUnavailable: session history not loaded")
  const selectionStats = createMemo(() => stats(true))
  const panel = createMemo(() => {
    if (view() === "runtime") return limited(JSON.stringify(loaded()?.runtime ?? { unavailable: "No runtime capture yet. Send a normal session message first." }, null, 2))
    if (view() === "content") return limited(serialize(blockMessages(ranges().length ? inspected() : blocks())))
    const usage = loaded()?.usage
    return [
      `Limits: >${rule().threshold} tokens; retain up to ${rule().head} head + ${rule().tail} tail (notice/link extra).`,
      ...selection().ranges.map((range, index) => `R${index + 1}: ${rangeLabel(blocks().slice(range.start, range.end + 1).flatMap((block) => block.sourceIDs), sourceTurns())}`),
      "Runtime inventory may be stale/incomplete; missing is not zero. Session overhead is not assigned to selected ranges.",
      usage ? `Last reported usage: ${usage.total.toLocaleString()} tokens · ${usage.providerID}/${usage.modelID}` : "Last reported usage: unavailable",
      "Historical usage is not a recount. Pruned = manual; eligible = current rule; file previews are separate.",
    ].join("\n")
  })
  const historyHints = () => [
    { key: "u", label: `Undo ${loaded() ? operationLabel(loaded()!.policy.operations[loaded()!.policy.cursor - 1], sourceTurns()) : "latest action"}` },
    { key: "r", label: `Redo ${loaded() ? operationLabel(loaded()!.policy.operations[loaded()!.policy.cursor], sourceTurns()) : "latest action"}` },
  ]
  const undoLabel = () => historyHints().map((hint) => `${hint.key} ${hint.label}`).join(" · ")
  const hints = (): HotkeyLine[] => exitDialog() ? [[{ key: "s/Esc", label: "stay" }, { key: "r", label: "resume if below threshold" }, { key: "a", label: "abort run and exit" }]]
    : strategyPicker() ? [[{ key: "Up/Down", label: "strategy" }, { key: "Enter", label: "save only" }, { key: "Esc", label: "cancel" }]]
    : automatic() ? [["Automatic compaction in progress"], [{ key: "Esc", label: "exit choices / abort run" }]]
    : picker() ? [[{ key: "Up/Down", label: "select" }, { key: "Enter", label: "confirm" }, { key: "Esc", label: "cancel" }, "type to filter"]]
    : help() ? [[{ key: "Esc", label: "close help" }]]
    : busy() ? [[{ key: "Esc", label: "cancel running model requests — writes already in progress may finish" }]]
    : restoring() ? [[{ key: "Ctrl+S", label: "confirm restore" }, { key: "Esc", label: "cancel" }], ["Selected ranges only; no model call. Restoring increases context size."]]
    : runningBatch() ? [[{ key: "g", label: "retry failed ranges" }, { key: "m", label: "model" }, { key: "t", label: "effort" }, { key: "Esc", label: "discard batch" }], ["Successful results stay pending until the entire batch can autoapply."]]
    : [
      [{ key: "?", label: "help" }, { key: "Space", label: "range" }, { key: "c", label: "compact" }, { key: "b", label: "brief" }, { key: "Enter", label: "read" }],
      historyHints(),
      [{ key: "p", label: "prune" }, { key: "Ctrl+U", label: "unprune" }, { key: "Ctrl+E", label: "expand" }, { key: "m/t", label: "model/effort" }, { key: "Tab", label: "pane" }, { key: "Esc", label: "back" }],
    ]
  const batchStatus = () => { epoch(); return summaries.entries.map((entry, index) => `R${index + 1} ${rangeLabel(entry.ids, sourceTurns())}: ${entry.status}${entry.error ? `\n${entry.error}` : ""}`).join("\n\n") }
  return <box width="100%" height="100%" flexDirection="column" overflow="hidden">
    <Show when={reader()} keyed fallback={
      <box width="100%" height="100%" flexDirection="column" padding={1} overflow="hidden">
        <text height={1} wrapMode="none" truncate fg={api.theme.current.primary}>Context manager · {props.sessionID} · revision {loaded()?.policy.revision ?? "?"}{busy() ? " · WORKING" : ""}</text>
        <text height={1} wrapMode="none" truncate>{`Compaction model: ${choice() ? `${choice()!.providerID}/${choice()!.modelID}` : "not selected"} · Effort: ${choice()?.variant ?? "default"}`}</text>
        <text height={1} wrapMode="none" truncate>Context tokenizer: {tokenLabel(basis())}</text>
        <text height={1} flexShrink={0} wrapMode="none" truncate>{`Auto: ${auto().strategy} · headroom ${props.controller.config.autocompaction.headroom.toLocaleString()} · a strategy · g Run AUTO when paused`}</text>
        <Show when={auto().pause}>{(pause) => <text height={2} flexShrink={0} overflow="hidden" fg={api.theme.current.primary}>{`PAUSED (${pause().phase}) ≈${pause().tokens.toLocaleString()} / ${pause().threshold.toLocaleString()} tokens · input limit ${pause().derived ? "derived" : "advertised"}\n${pause().message}`}</text>}</Show>
        <text height={2} overflow="hidden">{notice()}</text>
        <Show when={help()} fallback={
          <box flexDirection="row" flexGrow={1} minHeight={0} gap={1} overflow="hidden">
            <box width="45%" flexDirection="column" minHeight={0} overflow="hidden">
              <Show when={restoring()} keyed fallback={
                <Show when={runningBatch()} fallback={
                  <RangeList api={api} rows={rows()} maxLines={props.controller.config.ui.maxLinesPerTurn} selectedIndex={cursor()} onChange={setCursor} focused={!busy() && !automatic() && !exitDialog() && !strategyPicker() && !picker() && pane() === "list"} />
                }>
                  <text height={1} fg={api.theme.current.primary}>Batch progress — automatic acceptance</text>
                  <scrollbox flexGrow={1} minHeight={0} focused={!busy() && !picker()}><text>{batchStatus()}</text></scrollbox>
                </Show>
              }>{(preview) => <>
                <text height={2} fg={api.theme.current.primary}>Restore preview — {preview.operations.map((op) => operationLabel(op, sourceTurns())).join("; ")}</text>
                <text height={2}>{preview.mode === "unprune" ? `Restore ${preview.outputs} visible tool outputs.` : `Expand ${preview.summaries} summaries by one layer.`}{` Context delta: ${signed(preview.afterTokens - preview.beforeTokens)} tokens`}</text>
                <scrollbox flexGrow={1} minHeight={0} focused={!busy()}><text selectable>{limited(`BEFORE\n\n${serialize(blockMessages(preview.before))}\n\nAFTER\n\n${serialize(blockMessages(preview.after))}`)}</text></scrollbox>
              </>}</Show>
            </box>
            <box width="55%" flexDirection="column" minHeight={0} overflow="hidden">
              <text height={2} flexShrink={0} wrapMode="none" truncate>{globalStats().split("\n").slice(0, 2).join("\n")}</text>
              <Show when={ranges().length}><text height={2} flexShrink={0} wrapMode="none" truncate>{selectionStats().split("\n").slice(0, 2).join("\n")}</text></Show>
              <scrollbox flexGrow={1} minHeight={0} focused={!runningBatch() && !busy() && !picker() && !restoring() && pane() === "content"}>
                <text selectable>{globalStats().split("\n").slice(2).join("\n")}{ranges().length ? `\n\nSELECTED RANGE DETAILS\n${selectionStats().split("\n").slice(2).join("\n")}` : ""}{`\n\n${panel()}`}</text>
              </scrollbox>
            </box>
          </box>
        }>
          <scrollbox flexGrow={1} minHeight={0} focused={!picker()}><text>{`RANGE MENU HOTKEYS\n\nSpace: start/finish a range; inside a closed range, remove it.\nArrows: move cursor. Esc: cancel open range, then return.\nc / b: compact / brief all selected ranges. Results autoapply together.\nEnter: read the hovered turn or summary fullscreen.\nOrdinary turns show the user message and final assistant response, without reasoning or tool activity.\np: prune selected tool outputs. Ctrl+U: unprune. Ctrl+E: expand summaries.\nu / r: undo / redo one ledger operation.\nm / t: choose next model / effort.\na: save per-session autocompaction strategy (does not execute).\ng: explicitly run selected AUTO strategy while suspended.\nPaused exit: s/Esc stays; r resumes only below threshold; a aborts.\nThe active USER turn is entirely protected while suspended.\nf: refresh. v: cycle details/content/runtime. n: tokens/characters.\nTab: switch list/details focus. o: export effective snapshot.\n\nIncomplete batch: g retries failed ranges; Esc discards.\nReaders: arrows move 10 lines; PageUp/PageDown move one screen.\nSummary reader only: e manual editing; r model edit; Ctrl+S applies an edit.\n? opens this help.\n\n${undoLabel()}`}</text></scrollbox>
        </Show>
        <Hotkeys api={api} lines={hints()} />
      </box>
    }>{(value) => value.kind === "summary"
      ? <SummaryReader api={api} editor={value.editor} choice={choice} modalOpen={() => !!picker()} pick={openPicker} close={closeSummary} />
      : <TurnReader api={api} block={value.block} label={value.label} close={() => setReader(undefined)} />}</Show>
    <Show when={picker()}>
      <box position="absolute" top={2} left={0} width={reader() ? "85%" : "45%"} height="65%" border padding={1} backgroundColor={api.theme.current.background ?? "#101014"} overflow="hidden">
        <text height={1} wrapMode="none" truncate>{picker() === "model" ? "Choose compaction model" : "Choose reasoning effort / variant"}</text>
        <input placeholder="Type to filter" onInput={(value) => { setQuery(value); setPickerIndex(0) }} focused />
        <select options={filteredOptions()} selectedIndex={pickerIndex()} onSelect={(index) => chooseOption(index)} flexGrow={1} minHeight={0} showScrollIndicator />
      </box>
    </Show>
    <Show when={strategyPicker()}>
      <box id="cm-strategy-picker" position="absolute" top={2} left={0} width="85%" height={Math.min(6 + STRATEGIES.length * 2, Math.max(0, dimensions().height - 3))} border padding={1} backgroundColor={api.theme.current.background ?? "#101014"} overflow="hidden">
        <text height={2} flexShrink={0} overflow="hidden">Autocompaction strategy — saved per session. Selection does not execute it.</text>
        <select id="cm-strategy-options" options={STRATEGIES.map((name) => ({ name, description: name === "MANUAL" ? "Open inspector; confirm before resume" : name === "AUTO_PER_TURN" ? "Oldest USER first, then one whole-prefix fallback" : "One whole-prefix pass, excluding active USER" }))} selectedIndex={strategyIndex()} flexGrow={1} minHeight={0} showScrollIndicator />
      </box>
    </Show>
    <Show when={exitDialog()}>
      <box id="cm-pause-exit" position="absolute" top={2} left={0} width="95%" height={10} border padding={1} backgroundColor={api.theme.current.background ?? "#101014"} overflow="hidden">
        <text height={2}>Leave the suspended session?</text>
        <text height={1} onMouseUp={() => setExitDialog(false)}>s / Esc — Stay in menu</text>
        <text height={2} fg={canResume() ? api.theme.current.primary : api.theme.current.textMuted} onMouseUp={() => { if (canResume()) void run(() => autoCommand("resume")) }}>{canResume() ? "r — Resume and exit (continues the agent loop)" : "Resume blocked: context is above threshold or an AUTO job is running."}</text>
        <text height={1} onMouseUp={() => void run(() => autoCommand("abort"))}>a — Abort run and exit (does not resume)</text>
      </box>
    </Show>
  </box>
}

function statusLabel(status: ReturnType<typeof toolStatus>) {
  return rangeToolStats(status)
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toLocaleString()}`
}

function limited(text: string) {
  return text.length > 120000 ? `${text.slice(0, 120000)}\n[Display limited to 120,000 UTF-16 units. Select a smaller range or export the full effective snapshot.]` : text
}

const plugin: TuiPluginModule = {
  id: "context-manager",
  tui: async (api) => {
    api.route.register([{
      name: "context-manager",
      render: ({ params }) => {
        const sessionID = typeof params?.sessionID === "string" ? params.sessionID : ""
        const [controller, setController] = createSignal<Controller>()
        const [error, setError] = createSignal("")
        onMount(async () => {
          try {
            if (!sessionID) throw new Error("Open a session first")
            const storage = new Storage(api.state.path.directory)
            const published = await storage.config()
            if (!published) throw new Error("Server plugin runtime not found. Enable both entrypoints locally, restart, and open a session.")
            if (published.version !== VERSION) throw new Error("Server/TUI plugin versions differ. Fully restart OpenCode before changing context.")
            if (!published.control) throw new Error("Server control unavailable. Restart both entrypoints.")
            setController(new Controller(sdkHost(api.client, controlClient(published.control)), sessionID, settings(published.settings), storage))
          } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        })
        useKeyboard((key) => { if (!controller() && key.name === "escape") api.route.navigate("session", { sessionID }) })
        return <Show when={controller()} keyed fallback={<text>{error() || "Loading context manager…"} · Esc back</text>}>
          {(value) => <Inspector api={api} sessionID={sessionID} controller={value} />}
        </Show>
      },
    }])
    api.keymap.registerLayer({ commands: [{
      name: "context-manager.open", title: "Context manager", namespace: "palette", category: "Session", slashName: "context-manager",
      run: () => {
        const current = api.route.current
        const sessionID = "params" in current ? current.params?.sessionID : undefined
        if (current.name !== "session" || typeof sessionID !== "string") {
          api.ui.toast({ message: "Open a session first", variant: "warning" })
          return
        }
        api.ui.dialog.clear()
        api.route.navigate("context-manager", { sessionID })
      },
    }] })
    const unsubscribe = watchSuspensions(api, async () => {
      const published = await new Storage(api.state.path.directory).config()
      return published?.control && published.version === VERSION ? controlClient(published.control) : undefined
    })
    api.lifecycle.onDispose(unsubscribe)
  },
}

export function watchSuspensions(api: TuiPluginApi, control: () => Promise<AutoControl | undefined>) {
    const seen = new Map<string, string>()
    return api.event.on("session.updated", (event) => {
      const info = event.properties.info
      const notice = (info.metadata?.[AUTO_KEY] as AutoState | undefined)?.pause
      if (!notice) { seen.delete(info.id); return }
      if (!["manual", "invalid"].includes(notice.phase) || seen.get(info.id) === notice.id) return
      void (async () => {
        const state = await (await control())?.state(info.id)
        if (state?.pause?.id !== notice.id || !["manual", "invalid"].includes(state.pause.phase)) return
        if (seen.get(info.id) === notice.id) return
        seen.set(info.id, notice.id)
        const current = api.route.current
        if (current.name === "session" && "params" in current && current.params?.sessionID === info.id && !api.ui.dialog.open)
          api.route.navigate("context-manager", { sessionID: info.id })
        else if (current.name !== "context-manager") api.ui.toast({ message: `Session paused for context reduction: ${info.id}. Open /context-manager in that session.`, variant: "warning" })
      })().catch(() => {})
    })
}

export default plugin
