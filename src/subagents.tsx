/** @jsxImportSource @opentui/solid */
import type { OpenCodeClient } from "@opencode/client"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { ChildPage } from "./rpc.ts"
import { remoteHost } from "./control.ts"
import { Controller } from "./controller.ts"
import { settings, VERSION } from "./config.ts"
import { Inspector } from "./inspector.tsx"
import { Hotkeys } from "./tui-help.tsx"
import { inputBlocked, type InspectorUI } from "./ui.ts"

export function Subagents(props: { api: InspectorUI; client: OpenCodeClient; sessionID: string }) {
  const [parents, setParents] = createSignal([props.sessionID])
  const [selected, setSelected] = createSignal<string>()
  const descend = (id: string) => { setParents([...parents(), id]); setSelected(undefined) }
  const back = () => parents().length > 1 ? setParents(parents().slice(0, -1)) : props.api.ui.router.navigate({ type: "session", sessionID: props.sessionID })
  return <Show when={selected()} keyed fallback={
    <Show when={parents().at(-1)} keyed>{id => {
      const remote = remoteHost(props.client, id, true)
      onCleanup(() => { void remote.close() })
      return <ChildList api={props.api} load={remote.children} open={setSelected} descend={descend} back={back} />
    }}</Show>
  }>{id => <ObservedContext api={props.api} client={props.client} sessionID={id} back={() => setSelected(undefined)} descend={() => descend(id)} />}</Show>
}

function ObservedContext(props: { api: InspectorUI; client: OpenCodeClient; sessionID: string; back(): void; descend(): void }) {
  const remote = remoteHost(props.client, props.sessionID, true)
  const [controller, setController] = createSignal<Controller>()
  const [error, setError] = createSignal("")
  let alive = true, loading = false
  const load = async () => {
    if (loading) return
    loading = true
    try {
      const snapshot = await remote.load()
      if (snapshot.version !== VERSION) throw new Error("Server/TUI plugin versions differ; reload and reconnect")
      if (alive) setController(new Controller(remote.host, props.sessionID, settings(snapshot.settings), remote.artifacts))
    } catch (error) { if (alive) setError(String(error)) }
    finally { loading = false }
  }
  onMount(() => void load())
  onCleanup(() => { alive = false; void remote.close() })
  useKeyboard(key => {
    if (key.defaultPrevented || inputBlocked(props.api) || controller()) return
    if (key.name === "escape") { key.preventDefault(); props.back() }
    if (key.name === "f") { key.preventDefault(); void load() }
  })
  return <Show when={controller()} keyed fallback={<text>{error() || "Loading subagent context…"} · f retry · Esc back</text>}>
    {value => <Inspector api={props.api} sessionID={props.sessionID} controller={value} back={props.back} subagents={props.descend} />}
  </Show>
}

export function ChildList(props: { api: InspectorUI; load(cursor?: string): Promise<ChildPage>; open(id: string): void; descend(id: string): void; back(): void }) {
  const [page, setPage] = createSignal<ChildPage>()
  const [index, setIndex] = createSignal(0)
  const [notice, setNotice] = createSignal("Loading subagents…")
  const [cursors, setCursors] = createSignal<(string | undefined)[]>([undefined])
  let alive = true, loading = false
  const pop = props.api.keymap.mode.push("context-manager")
  const refresh = async (nextCursors = cursors()) => {
    if (loading) return
    loading = true
    try {
      const next = await props.load(nextCursors.at(-1))
      if (!alive) return
      if (next.version !== VERSION) throw new Error("Server/TUI plugin versions differ; reload and reconnect")
      const id = page()?.items[index()]?.id
      setPage(next)
      setCursors(nextCursors)
      setIndex(Math.max(0, next.items.findIndex(item => item.id === id)))
      setNotice(next.items.length ? "Read-only · list refreshes every 5s" : "No subagents on this page.")
    } catch (error) { if (alive) setNotice(`List unavailable: ${String(error)}`) }
    finally { loading = false }
  }
  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => { alive = false; pop() })
  useKeyboard(key => {
    if (key.defaultPrevented || inputBlocked(props.api)) return
    if (key.name === "escape") { key.preventDefault(); props.back(); return }
    if (key.ctrl || key.meta) return
    const item = page()?.items[index()]
    const actions: Record<string, () => unknown> = {
      return: () => { if (item) props.open(item.id) },
      s: () => { if (item) props.descend(item.id) },
      f: () => refresh(),
      n: () => { if (page()?.next) void refresh([...cursors(), page()!.next]) },
      p: () => { if (cursors().length > 1) void refresh(cursors().slice(0, -1)) },
    }
    if (actions[key.name]) { key.preventDefault(); void actions[key.name]() }
  })
  return <box width="100%" height="100%" flexDirection="column" padding={1} overflow="hidden">
    <text height={1} flexShrink={0} fg={props.api.theme.text.base}><b>Subagent contexts · READ-ONLY</b></text>
    <text height={1} flexShrink={0} wrapMode="none" truncate>{page()?.title ?? "Current session"}</text>
    <select id="cm-subagents" flexGrow={1} minHeight={0} focused={!inputBlocked(props.api)} showScrollIndicator selectedIndex={index()} onChange={setIndex}
      options={(page()?.items ?? []).map(item => ({ name: `${item.status} · ${item.title}`, description: `${item.agent} · ${item.model} · ${item.id}`, value: item.id }))} />
    <text height={2} flexShrink={0}>{notice()}{page()?.next ? " · More: n" : ""}{cursors().length > 1 ? " · Previous: p" : ""}</text>
    <Hotkeys api={props.api} lines={[
      [{ key: "Enter", label: "context" }, { key: "s", label: "children" }, { key: "f", label: "refresh" }],
      [{ key: "n/p", label: "pages" }, { key: "Esc", label: "back" }],
    ]} />
  </box>
}
