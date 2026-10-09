/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { inputBlocked, type InspectorUI } from "./ui.ts"
import type { Model } from "./model.ts"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { Controller, type Loaded, type ModelChoice, type MultiRestorePreview } from "./controller.ts"
import { blockMessages, activeMessages, serialize, type Block, type RestoreMode } from "./context.ts"
import { SummaryBatch } from "./batch.ts"
import { SummaryEditor } from "./summary-editor.ts"
import { SummaryReader } from "./summary-reader.tsx"
import { TurnReader } from "./turn-reader.tsx"
import { RangeList } from "./range-list.tsx"
import { ContextOverview } from "./context-overview.tsx"
import { budgetView, compactCount } from "./inspector-view.ts"
import { CompactionMenu } from "./compaction-menu.tsx"
import { COMPACTION_MODES, selectedModes, toggleMode, type Compaction } from "./compaction.ts"
import { rangePreview, rangeToolStats } from "./range-rows.ts"
import { Hotkeys, type HotkeyLine } from "./tui-help.tsx"
import { anchorRanges, pressSpace, rangeIDs, rangeTag, selectedBlocks, visibleRanges, type Selection } from "./ranges.ts"
import { bindPruneRule } from "./text.ts"
import { distribution } from "./snapshot.ts"
import { settings, VERSION } from "./config.ts"
import { operationLabel, rangeLabel, toolStatus, turnIndex } from "./status.ts"
import { FALLBACK_BASIS, tokenLabel } from "./tokens.ts"
import { AUTO_KEY, STRATEGIES, type AutoState, type AutoControl } from "./auto-state.ts"
import { remoteHost } from "./control.ts"

const views = ["overview", "details", "content", "runtime"] as const

export function Inspector(props: { api: InspectorUI; sessionID: string; controller: Controller }) {
  const api = props.api
  const dimensions = useTerminalDimensions()
  const [loaded, setLoaded] = createSignal<Loaded>()
  const [cursor, setCursor] = createSignal(0)
  const [selection, setSelection] = createSignal<Selection>({ ranges: [] })
  const [busy, setBusy] = createSignal(false)
  const [pane, setPane] = createSignal<"list" | "content">("list")
  const [notice, setNotice] = createSignal("Loading active session context…")
  const [noticeError, setNoticeError] = createSignal(false)
  const [view, setView] = createSignal<typeof views[number]>("overview")
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
  const [auto, setAuto] = createSignal<AutoState>({ strategy: "AUTO_PER_TURN" })
  const [strategyPicker, setStrategyPicker] = createSignal(false)
  const [strategyIndex, setStrategyIndex] = createSignal(0)
  const [exitDialog, setExitDialog] = createSignal(false)
  const [configuring, setConfiguring] = createSignal(false)
  const [compaction, setCompaction] = createSignal<Compaction>({ kind: "summary", mode: "compact" })
  const [compactionIndex, setCompactionIndex] = createSignal(4)
  let detailsScroll: ScrollBoxRenderable | undefined
  const automatic = () => auto().pause?.phase === "auto"
  const canResume = () => auto().pause?.phase === "manual" && auto().pause!.tokens <= auto().pause!.threshold
  const basis = () => loaded()?.tokenizer ?? FALLBACK_BASIS
  const rule = () => loaded()?.pruneRule ?? bindPruneRule(props.controller.config.prune, basis())
  const size = (value: number) => unit() === "tokens" ? `≈${value.toLocaleString()} tokens` : `${value.toLocaleString()} chars`
  const shortSize = (value: number) => `${unit() === "tokens" ? "≈" : ""}${compactCount(value)}`
  const narrow = () => dimensions().width < 80
  const sidebarWidth = () => narrow() ? dimensions().width - 2 : Math.min(48, Math.max(30, Math.floor((dimensions().width - 3) * 0.4)))
  const popMode = api.keymap.mode.push("context-manager")
  onCleanup(() => { popMode(); void Promise.all([summaries.dispose(), props.controller.dispose()]).catch((error) => api.ui.toast.show({ message: String(error), variant: "warning" })) })
  const blocks = () => loaded()?.blocks ?? []
  const sourceTurns = createMemo(() => turnIndex(activeMessages(loaded()?.raw ?? [], loaded()?.session.revert)))
  const ranges = () => visibleRanges(selection(), cursor())
  const inspected = () => selectedBlocks(blocks(), ranges())
  const localCounts = createMemo(() => distribution(blocks(), loaded()?.runtime, basis(), unit()))
  const selectedCounts = createMemo(() => distribution(inspected(), undefined, basis(), unit()))
  const requestBudget = createMemo(() => budgetView(loaded(), auto(), props.controller.config.autocompaction.headroom))
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
    setNotice("Ready.")
  }
  const run = async (task: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    setNoticeError(false)
    try { await task() }
    catch (error) { setNoticeError(true); setNotice(error instanceof Error ? error.message : String(error)) }
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
        if (previous && !next.pause) { api.ui.router.navigate({ type: "session", sessionID: props.sessionID }); return }
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
    if (action !== "run") { setExitDialog(false); api.ui.router.navigate({ type: "session", sessionID: props.sessionID }) }
  }
  const openStrategy = () => {
    if (!props.controller.host.auto) { setNotice("Context controls unavailable; reload the plugin and reconnect"); return }
    setStrategyIndex(STRATEGIES.indexOf(auto().strategy))
    setStrategyPicker(true)
  }
  const saveStrategy = async () => {
    setAuto(await props.controller.host.auto!.command(props.sessionID, { action: "strategy", strategy: STRATEGIES[strategyIndex()] }))
    setStrategyPicker(false)
    setNotice(loaded()?.session.parentID && STRATEGIES[strategyIndex()] === "MANUAL" ? "Subagents use AUTO_PER_TURN instead of MANUAL." : "Strategy saved for this session. While paused, g explicitly runs the selected AUTO strategy.")
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
  const openCompaction = () => {
    try { selectedIDs() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return }
    setCompactionIndex(selectedModes(compaction())[0] ?? 0)
    setPane("list")
    setConfiguring(true)
  }
  const runCompaction = async () => {
    const value = compaction()
    if (!selectedModes(value).length) throw new Error("Select at least one compaction mode")
    setConfiguring(false)
    if (value.kind === "summary") { await beginSummary(value.mode); return }
    const ids = selectedIDs()
    await props.controller.pruneRanges(ids, value)
    await refresh(ids)
    setNotice("Pruning applied. Ctrl+E restores one layer; stored history is unchanged.")
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
    setNotice("Selected context layers restored. Unselected history is unchanged.")
  }
  const pickerOptions = createMemo(() => {
    const current = choice()
    if (picker() === "model") return [...models()].sort((a, b) => `${a.providerID}/${a.name}`.localeCompare(`${b.providerID}/${b.name}`)).map((model) => ({
      name: model.name, description: `${model.providerID}/${model.id}`,
      value: { providerID: model.providerID, modelID: model.id, variant: current?.providerID === model.providerID && current.modelID === model.id ? current.variant ?? "default" : "default" },
    }))
    if (!current) return []
    const model = models().find((m) => m.providerID === current.providerID && m.id === current.modelID)
    const variants = (model?.variants ?? []).map((variant) => variant.id).filter((id) => id !== "default")
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
    if (key.defaultPrevented || inputBlocked(api)) return
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
    if (configuring()) {
      key.preventDefault()
      if (busy()) return
      if (key.name === "escape") setConfiguring(false)
      if (key.ctrl || key.meta) return
      if (key.name === "up" || key.name === "k") setCompactionIndex(Math.max(0, compactionIndex() - 1))
      if (key.name === "down" || key.name === "j") setCompactionIndex(Math.min(COMPACTION_MODES.length - 1, compactionIndex() + 1))
      if (key.name === "home") setCompactionIndex(0)
      if (key.name === "end") setCompactionIndex(COMPACTION_MODES.length - 1)
      if (key.name === "space") setCompaction(toggleMode(compaction(), compactionIndex()))
      if (key.name === "return") void run(runCompaction)
      if (key.name === "m") openPicker("model")
      if (key.name === "t") openPicker("effort")
      return
    }
    if (key.name === "escape") {
      key.preventDefault()
      if (busy()) { void summaries.cancel().catch((e) => setNotice(String(e))); return }
      if (runningBatch()) {
        void run(async () => { await summaries.discard(); setRunningBatch(false); touch(); setNotice("Batch discarded; context unchanged.") })
        return
      }
      if (selection().anchor !== undefined) { setSelection({ ranges: selection().ranges }); return }
      if (auto().pause) { setExitDialog(true); return }
      api.ui.router.navigate({ type: "session", sessionID: props.sessionID })
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
    if (key.ctrl && key.name === "e") { key.preventDefault(); void run(() => previewRestore("expand")); return }
    if (key.ctrl || key.meta) return
    if (key.name === "tab") { key.preventDefault(); setPane(pane() === "list" ? "content" : "list"); return }
    const actions: Record<string, () => void | Promise<void>> = {
      return: () => run(openReader),
      a: openStrategy,
      g: () => run(() => autoCommand("run")),
      "?": () => { setHelp(true) },
      space: () => { if (pane() !== "list") return; try { setSelection(pressSpace(selection(), cursor(), blocks())) } catch (error) { setNotice(String(error)) } },
      c: openCompaction,
      f: () => run(refresh),
      o: () => run(async () => { setNotice(`Snapshot saved: ${await props.controller.dump(api.app.version)}`) }),
      v: () => { setView(views[(views.indexOf(view()) + 1) % views.length]); if (!narrow() || pane() === "content") detailsScroll?.scrollTo(0); if (narrow()) setPane("content") },
      n: () => { setUnit(unit() === "tokens" ? "characters" : "tokens") },
      m: () => openPicker("model"),
      t: () => openPicker("effort"),
    }
    const action = actions[key.name]
    if (action) { key.preventDefault(); void action() }
  })
  const rows = createMemo(() => blocks().map((block, index) => {
    const selected = ranges().some((range) => index >= range.start && index <= range.end)
    const tag = rangeTag(selection(), cursor(), index)
    const status = toolStatus([block], rule(), basis())
    const protectedTurn = auto().pause && block.sourceIDs.some((id) => (auto().pause!.protectedIDs ?? [auto().pause!.userID]).includes(id))
    return {
      title: `${selected ? "●" : "○"} ${tag ? `${tag} · ` : ""}${rangeLabel(block.sourceIDs, sourceTurns())} · ${block.kind === "turn" ? block.messages[0]?.info.role === "user" ? "USER" : block.messages[0]?.info.kind === "assistant" ? "CONTINUATION" : "HOST CONTEXT" : "SUMMARY"}`,
      size: shortSize(distribution([block], undefined, basis(), unit()).total),
      stats: [protectedTurn ? "PROTECTED" : !block.closed ? "Unfinished" : "", block.kind === "turn" ? rangeToolStats(status) : ""].filter(Boolean).join(" · ") || undefined,
      preview: rangePreview(block, loaded()!.policy),
    }
  }))
  const stats = (selected: boolean) => {
    const items = selected ? inspected() : blocks()
    const data = distribution(items, selected ? undefined : loaded()?.runtime, basis(), unit())
    const status = toolStatus(items, rule(), basis())
    const value = (key: string) => data.unavailableCategories.includes(key) ? "unavailable" : data.counts[key].toLocaleString()
    return [
      selected ? `SELECTED RANGES (${selection().ranges.length}${selection().anchor !== undefined ? " + open" : ""})` : "LOCAL CONTEXT",
      `Total categorized text: ${size(data.total)}`,
      rangeToolStats(status),
      `user: ${value("user")} · assistant: ${value("assistant")} · summaries: ${value("summaries")}`,
      `reasoning: ${value("reasoning")} · toolInputs: ${value("toolInputs")}`,
      `toolOutputs: ${value("toolOutputs")} · loadedSkills: ${value("loadedSkills")}`,
      ...(!selected ? [`system: ${value("systemPrompts")} · skills: ${value("advertisedSkills")}`, `toolSchemas: ${value("capturedToolDefinitions")}`] : []),
      `Attachments: ${data.attachments} (token cost unknown) · Prune delta: ${signed(unit() === "tokens" ? status.pruneDelta : status.pruneCharDelta)}`,
    ].join("\n")
  }
  const globalStats = createMemo(() => loaded() ? stats(false) : "LOCAL CONTEXT\nUnavailable: session history not loaded")
  const selectionStats = createMemo(() => stats(true))
  const panel = createMemo(() => {
    if (view() === "runtime") return limited(JSON.stringify(loaded()?.runtime ?? { unavailable: "No runtime capture yet. Send a normal session message first." }, null, 2))
    if (view() === "content") return limited(serialize(blockMessages(ranges().length ? inspected() : blocks())))
    const usage = loaded()?.usage
    const budget = auto().pause ? auto().pause!.accounting : loaded()?.runtime?.budget
    return [
      `Session: ${props.sessionID} · revision ${loaded()?.policy.revision ?? "?"}`,
      `Context tokenizer: ${tokenLabel(basis())}`,
      `Auto: ${auto().strategy} · headroom ${props.controller.config.autocompaction.headroom.toLocaleString()} tokens`,
      `Limits: >${rule().threshold} tokens; retain up to ${rule().head} head + ${rule().tail} tail (notice/link extra).`,
      ...selection().ranges.map((range, index) => `R${index + 1}: ${rangeLabel(blocks().slice(range.start, range.end + 1).flatMap((block) => block.sourceIDs), sourceTurns())}`),
      "Runtime inventory may be stale/incomplete; missing is not zero. Session overhead is not assigned to selected ranges.",
      usage ? `Last reported usage: ${usage.total.toLocaleString()} tokens · ${usage.providerID}/${usage.modelID}` : "Last reported usage: unavailable",
      ...(budget ? [`${auto().pause ? "Live guard" : "Last request guard"}: ≈${budget.tokens.toLocaleString()}`,
        `Source: ${budget.source}`, `Guard local: ≈${budget.local.toLocaleString()}`,
        ...(requestBudget().note ? [requestBudget().note!] : []),
        ...(budget.reported ? ["Provider baseline:", `Input+cache: ${budget.reported.input.toLocaleString()}`, `Output+reasoning: ${budget.reported.output.toLocaleString()}`, "Removed local text is not exact provider savings."]
          : [`No matching usage; local fallback ×${budget.multiplier}.`, "This is not a provider token count."])] : []),
      "Historical usage is not a recount. Large = eligible under current rules; file previews are separate. Ctrl+E restores one layer.",
    ].join("\n")
  })
  const hints = (): HotkeyLine[] => exitDialog() ? [[{ key: "s/Esc", label: "stay" }, { key: "r", label: "resume if below threshold" }, { key: "a", label: "abort run and exit" }]]
    : strategyPicker() ? [[{ key: "Up/Down", label: "strategy" }, { key: "Enter", label: "save only" }, { key: "Esc", label: "cancel" }]]
    : automatic() ? [["Automatic compaction in progress"], [{ key: "Esc", label: "exit choices / abort run" }]]
    : picker() ? [[{ key: "Up/Down", label: "select" }, { key: "Enter", label: "confirm" }, { key: "Esc", label: "cancel" }, "type to filter"]]
    : help() ? [[{ key: "Esc", label: "close help" }]]
    : busy() ? [[{ key: "Esc", label: "cancel running model requests — writes already in progress may finish" }]]
    : restoring() ? [[{ key: "Ctrl+S", label: "confirm restore" }, { key: "Esc", label: "cancel" }], ["Selected ranges only; no model call. Restoring increases context size."]]
    : runningBatch() ? [[{ key: "g", label: "retry failed ranges" }, { key: "m", label: "model" }, { key: "t", label: "effort" }, { key: "Esc", label: "discard batch" }], ["Successful results stay pending until the entire batch can autoapply."]]
    : configuring() ? [[{ key: "Up/Down", label: "mode" }, { key: "Space", label: "toggle" }, { key: "Enter", label: "run" }], [{ key: "m/t", label: "model/effort" }, { key: "Esc", label: "cancel" }]]
    : narrow() ? [
      [{ key: "Space", label: "select" }, { key: "c", label: "reduce" }, { key: "Enter", label: "read" }],
      [{ key: "Ctrl+E", label: "restore" }, { key: "v", label: "details" }, { key: "Tab", label: "pane" }],
      [{ key: "a", label: "auto" }, { key: "m/t", label: "model" }, { key: "?", label: "help" }, { key: "Esc", label: "back" }],
    ] : [
      [{ key: "Space", label: "select" }, { key: "c", label: "reduce" }, { key: "Enter", label: "read" }, { key: "Ctrl+E", label: "restore" }],
      [{ key: "v", label: "details" }, { key: "Tab", label: "pane" }, { key: "a", label: "auto" }, { key: "m/t", label: "model" }, { key: "?", label: "help" }, { key: "Esc", label: "back" }],
    ]
  const batchStatus = () => { epoch(); return summaries.entries.map((entry, index) => `R${index + 1} ${rangeLabel(entry.ids, sourceTurns())}: ${entry.status}${entry.error ? `\n${entry.error}` : ""}`).join("\n\n") }
  return <box width="100%" height="100%" flexDirection="column" overflow="hidden">
    <Show when={reader()} keyed fallback={
      <box width="100%" height="100%" flexDirection="column" padding={1} overflow="hidden">
        <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between">
          <text fg={api.theme.text.base}><b>Context manager</b>{busy() ? " · working" : ""}</text>
          <text fg={api.theme.text.muted}>{auto().strategy === "MANUAL" ? "Manual" : auto().strategy === "AUTO_PER_TURN" ? "Auto / turn" : "Auto / session"}</text>
        </box>
        <box height={narrow() ? 2 : 1} flexShrink={0} flexDirection={narrow() ? "column" : "row"} gap={narrow() ? 0 : 2}>
          <text id="cm-context-total" height={1} flexGrow={1} minWidth={0} wrapMode="none" truncate fg={api.theme.text.base}>{`Local text  ${loaded() ? `${shortSize(localCounts().total)} ${unit() === "tokens" ? "tokens" : "chars"}` : "unavailable"}`}</text>
          <text id="cm-selected-total" height={1} flexShrink={0} wrapMode="none" truncate fg={ranges().length ? api.theme.text.formfield.selected : api.theme.text.muted}>{ranges().length ? `Selected (${selection().ranges.length}${selection().anchor !== undefined ? " + open" : ""})  ${shortSize(selectedCounts().total)} ${unit() === "tokens" ? "tokens" : "chars"}` : "No selection"}</text>
        </box>
        <text height={1} flexShrink={0} wrapMode="none" truncate fg={api.theme.text.muted}>{`Summary  ${choice() ? `${choice()!.providerID}/${choice()!.modelID}` : "choose a model with m"} · Effort: ${choice()?.variant ?? "default"}`}</text>
        <Show when={auto().pause}>{(pause) => <text height={2} flexShrink={0} overflow="hidden" fg={api.theme.text.feedback.warning.base}>{`PAUSED (${pause().phase}) ≈${pause().tokens.toLocaleString()} / ${pause().threshold.toLocaleString()} tokens · input limit ${pause().derived ? "derived" : "advertised"}\n${pause().message}`}</text>}</Show>
        <Show when={help()} fallback={
          <box flexDirection="row" flexGrow={1} minHeight={0} gap={1} overflow="hidden">
            <Show when={!narrow() || pane() === "list"}>
            <box id="cm-conversation-panel" flexGrow={1} flexBasis={0} minWidth={0} flexDirection="column" minHeight={0} overflow="hidden"
              border borderStyle="rounded" borderColor={pane() === "list" ? api.theme.text.formfield.focused : api.theme.border.base}
              title={`Conversation · ${unit() === "tokens" ? "tokens" : "chars"}`} paddingLeft={1} paddingRight={1}>
              <Show when={restoring()} keyed fallback={
                <Show when={runningBatch()} fallback={
                  <Show when={configuring()} fallback={<RangeList api={api} rows={rows()} maxLines={props.controller.config.ui.maxLinesPerTurn} selectedIndex={cursor()} onChange={setCursor} focused={!busy() && !automatic() && !exitDialog() && !strategyPicker() && !picker() && pane() === "list"} />}>
                    <CompactionMenu api={api} value={compaction()} index={compactionIndex()} toggle={(index) => { if (!picker() && !inputBlocked(api)) setCompaction(toggleMode(compaction(), index)) }} />
                  </Show>
                }>
                  <text height={1} fg={api.theme.text.base}>Batch progress — automatic acceptance</text>
                  <scrollbox flexGrow={1} minHeight={0} focused={!busy() && !picker()}><text>{batchStatus()}</text></scrollbox>
                </Show>
              }>{(preview) => <>
                <text height={2} fg={api.theme.text.base}>Restore preview — {preview.operations.map((op) => operationLabel(op, sourceTurns())).join("; ")}</text>
                <text height={2}>{`Restore ${[preview.summaries ? `${preview.summaries} summary` : "", preview.prunings ? `${preview.prunings} pruning` : ""].filter(Boolean).join(" + ")} layers. Text delta: ${signed(preview.afterTokens - preview.beforeTokens)} tokens`}</text>
                <scrollbox flexGrow={1} minHeight={0} focused={!busy()}><text selectable>{limited(`BEFORE\n\n${serialize(blockMessages(preview.before))}\n\nAFTER\n\n${serialize(blockMessages(preview.after))}`)}</text></scrollbox>
              </>}</Show>
            </box>
            </Show>
            <Show when={!narrow() || pane() === "content"}>
            <box id="cm-context-panel" width={narrow() ? "100%" : sidebarWidth()} flexShrink={0} flexDirection="column" minHeight={0} overflow="hidden"
              border borderStyle="rounded" borderColor={pane() === "content" ? api.theme.text.formfield.focused : api.theme.border.base}
              title={view().charAt(0).toUpperCase() + view().slice(1)} paddingLeft={1} paddingRight={1}>
              <scrollbox id="cm-context-scroll" ref={(value) => { detailsScroll = value }} flexGrow={1} minHeight={0} focused={!configuring() && !runningBatch() && !busy() && !picker() && !restoring() && !help() && !exitDialog() && !strategyPicker() && pane() === "content"}>
                <Show when={view() === "overview"} fallback={<text id="cm-diagnostics" selectable>{view() === "details" ? `${globalStats()}${ranges().length ? `\n\n${selectionStats()}` : ""}\n\n` : ""}{panel()}</text>}>
                  <Show when={loaded()} fallback={<text fg={api.theme.text.muted}>Context unavailable.</text>}>
                    <ContextOverview api={api} budget={requestBudget()} counts={ranges().length ? selectedCounts() : localCounts()} selected={ranges().length > 0} width={sidebarWidth() - 4} />
                  </Show>
                </Show>
              </scrollbox>
            </box>
            </Show>
          </box>
        }>
          <scrollbox flexGrow={1} minHeight={0} focused={!picker()}><text>{helpText}</text></scrollbox>
        </Show>
        <text id="cm-notice" height={notice() === "Ready." ? 1 : 2} flexShrink={0} overflow="hidden" fg={noticeError() ? api.theme.text.feedback.error.base : api.theme.text.muted}>{notice()}</text>
        <Hotkeys api={api} lines={hints()} />
      </box>
    }>{(value) => value.kind === "summary"
      ? <SummaryReader api={api} editor={value.editor} choice={choice} modalOpen={() => !!picker()} pick={openPicker} close={closeSummary} />
      : <TurnReader api={api} block={value.block} label={value.label} close={() => setReader(undefined)} />}</Show>
    <Show when={picker()}>
      <box position="absolute" top={2} left={0} width={reader() ? "85%" : "45%"} height="65%" border padding={1} backgroundColor={api.theme.background.base} overflow="hidden">
        <text height={1} wrapMode="none" truncate>{picker() === "model" ? "Choose compaction model" : "Choose reasoning effort / variant"}</text>
        <input placeholder="Type to filter" onInput={(value) => { setQuery(value); setPickerIndex(0) }} focused />
        <select options={filteredOptions()} selectedIndex={pickerIndex()} onSelect={(index) => chooseOption(index)} flexGrow={1} minHeight={0} showScrollIndicator />
      </box>
    </Show>
    <Show when={strategyPicker()}>
      <box id="cm-strategy-picker" position="absolute" top={2} left={0} width="85%" height={Math.min(6 + STRATEGIES.length * 2, Math.max(0, dimensions().height - 3))} border padding={1} backgroundColor={api.theme.background.base} overflow="hidden">
        <text height={2} flexShrink={0} overflow="hidden">Autocompaction strategy — saved per session. Selection does not execute it.</text>
        <select id="cm-strategy-options" options={STRATEGIES.map((name) => ({ name, description: name === "MANUAL" ? "Top-level only; subagents use AUTO_PER_TURN" : name === "AUTO_PER_TURN" ? "Oldest USER, earlier prefix, then last resort" : "Earlier prefix, then last resort" }))} selectedIndex={strategyIndex()} flexGrow={1} minHeight={0} showScrollIndicator />
      </box>
    </Show>
    <Show when={exitDialog()}>
      <box id="cm-pause-exit" position="absolute" top={2} left={0} width="95%" height={10} border padding={1} backgroundColor={api.theme.background.base} overflow="hidden">
        <text height={2}>Leave the suspended session?</text>
        <text height={1} onMouseUp={() => setExitDialog(false)}>s / Esc — Stay in menu</text>
        <text height={2} fg={api.theme.text.action.primary.state({ disabled: !canResume() })} onMouseUp={() => { if (canResume()) void run(() => autoCommand("resume")) }}>{canResume() ? "r — Resume and exit (continues the agent loop)" : "Resume blocked: context is above threshold or an AUTO job is running."}</text>
        <text height={1} onMouseUp={() => void run(() => autoCommand("abort"))}>a — Abort run and exit (does not resume)</text>
      </box>
    </Show>
  </box>
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toLocaleString()}`
}

function limited(text: string) {
  return text.length > 120000 ? `${text.slice(0, 120000)}\n[Display limited to 120,000 UTF-16 units. Select a smaller range or export the full effective snapshot.]` : text
}

const helpText = `RANGE MENU HOTKEYS

SELECT & REDUCE
Space starts/finishes a range; inside a closed range, removes it.
Arrows move the cursor. Esc cancels an open range, then returns.
c configures actions for selected ranges.
In configuration: arrows choose, Space toggles, Enter runs.
m/t selects the summary model/effort, also from the main view.
Reasoning combines with one tool mode. Tool deletion requires reasoning removal.
Summaries cannot combine with pruning. Parallel summaries apply together.
Pruning changes effective context only. Stored history is unchanged.

READ & EXPAND
Enter reads the hovered USER or SUMMARY fullscreen.
Ctrl+E previews one-layer restoration for each selected item; Ctrl+S confirms.
Summaries expand first, retaining their prior pruning. Pruned turns restore
their latest pruning action; earlier layers stay applied. Combined tool/reasoning
pruning restores together. This also restores deleted calls and results.
Restoration makes no model call and can increase context; resume stays budget-checked.
Readers: arrows move 10 lines; PageUp/PageDown move one screen.
Summary reader: e edits manually; r requests a model edit; Ctrl+S applies.
Model edits remain proposals until applied.

VIEWS & COUNTS
v cycles Overview → Details → Content → Runtime.
Details has full counts, tokenizer/model identity, usage and warnings.
n switches local token/character counts. The guard always uses tokens.
Tab switches panes; below 80 columns, shows one pane at a time.
The overview meter compares a request estimate to the cleanup threshold.
Last request is historical, not a recount. Live guard is a held request.
Local text, provider usage and guard forecasts are different measures.
Counts are estimates; media and opaque overhead are not fully known.
f refreshes. o exports effective context. Exports can contain private data.

AUTOMATIC CLEANUP
a saves a strategy without running it. g runs AUTO while paused.
Paused exit: s/Esc stays; r resumes only below threshold; a aborts.
Manual edits protect the active turn. AUTO last resort may summarize its prefix,
preserving the configured recent tail. Subagents cannot use MANUAL.
Incomplete batch: g retries failed ranges; m/t changes model/effort; Esc discards.
There is no global Undo/Redo or ledger rewind.`

const plugin = Plugin.define({
  id: "context-manager",
  setup: (ctx) => {
    const api = ctx
    const remotes = new Set<ReturnType<typeof remoteHost>>()
    const unregister = ctx.ui.router.register({
      name: "context-manager",
      render: ({ data: params }) => {
        const sessionID = typeof params?.sessionID === "string" ? params.sessionID : ""
        const [controller, setController] = createSignal<Controller>()
        const [error, setError] = createSignal("")
        let closed = false
        let remote: ReturnType<typeof remoteHost> | undefined
        onCleanup(() => {
          closed = true
          if (remote) { const current = remote; void current.close().catch((error) => api.ui.toast.show({ message: String(error), variant: "warning" })).finally(() => remotes.delete(current)) }
        })
        onMount(async () => {
          try {
            if (!sessionID) throw new Error("Open a session first")
            remote = remoteHost(ctx.client, sessionID)
            remotes.add(remote)
            const published = await remote.load()
            if (published.version !== VERSION) throw new Error("Server/TUI plugin versions differ. Fully restart OpenCode before changing context.")
            if (!closed) setController(new Controller(remote.host, sessionID, settings(published.settings), remote.artifacts))
          } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
        })
        useKeyboard((key) => { if (!key.defaultPrevented && !inputBlocked(api) && !controller() && key.name === "escape") api.ui.router.navigate({ type: "session", sessionID }) })
        return <Show when={controller()} keyed fallback={<text>{error() || "Loading context manager…"} · Esc back</text>}>
          {(value) => <Inspector api={api} sessionID={sessionID} controller={value} />}
        </Show>
      },
    })
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "context-manager.open", title: "Context manager", group: "Session", palette: true, slash: { name: "context-manager" },
      run: () => {
        const current = api.ui.router.current()
        if (current.type !== "session") {
          api.ui.toast.show({ message: "Open a session first", variant: "warning" })
          return
        }
        api.ui.dialog.clear()
        api.ui.router.navigate({ type: "plugin", name: "context-manager", data: { sessionID: current.sessionID } })
      },
    }] }))
    const unsubscribe = watchSuspensions(api, async (id) => remoteHost(ctx.client, id).host.auto)
    return async () => { unregister(); unsubscribe(); await Promise.allSettled([...remotes].map((remote) => remote.close())); remotes.clear() }
  },
})

export function watchSuspensions(api: InspectorUI, control: (sessionID: string) => Promise<AutoControl | undefined>) {
    const seen = new Map<string, string>()
    return api.data.on("session.metadata.updated", (event) => {
      const info = { id: event.data.sessionID, metadata: event.data.metadata }
      const notice = (info.metadata?.[AUTO_KEY] as AutoState | undefined)?.pause
      if (!notice) { seen.delete(info.id); return }
      if (!["manual", "invalid"].includes(notice.phase) || seen.get(info.id) === notice.id) return
      void (async () => {
        const state = await (await control(info.id))?.state(info.id)
        if (state?.pause?.id !== notice.id || !["manual", "invalid"].includes(state.pause.phase)) return
        if (seen.get(info.id) === notice.id) return
        seen.set(info.id, notice.id)
        const current = api.ui.router.current()
        if (current.type === "session" && current.sessionID === info.id && !inputBlocked(api))
          api.ui.router.navigate({ type: "plugin", name: "context-manager", data: { sessionID: info.id } })
        else if (current.type !== "plugin" || current.name !== "context-manager") api.ui.toast.show({ message: `Session paused for context reduction: ${info.id}. Open /context-manager in that session.`, variant: "warning" })
      })().catch(() => {})
    })
}

export default plugin
