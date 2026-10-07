import { Plugin } from "@opencode/plugin"
import { AGENT, EDIT_AGENT, KEY, VERSION, settings } from "./config.ts"
import { blockMessages, historyHash, nativeActive, project, readPolicy } from "./context.ts"
import { Controller } from "./controller.ts"
import { Storage } from "./storage.ts"
import { spills, spillPreview } from "./text.ts"
import { inputEstimate, SUMMARIZER_SYSTEM, SUMMARY_EDIT_SYSTEM } from "./summarize.ts"
import { Autocompaction } from "./autocompaction.ts"
import { ContextManager, errorMessage } from "./rpc.ts"
import { pluginHost, type PluginContext } from "./host.ts"
import { modelView, sessionView, transcriptView } from "./v2/normalize.ts"
import { protectedMessages } from "./v2/history.ts"
import { projectRequest, requestTokens } from "./v2/projection.ts"
import { tokenBasis } from "./tokens.ts"

export async function setupServer(ctx: PluginContext, store = new Storage(ctx.location.directory)) {
  if (ctx.app.version !== "2.0.24") throw new Error(`Context manager ${VERSION} requires OpenCode 2.0.24; found ${ctx.app.version}`)
  const config = settings(ctx.options)
  const adapter = pluginHost(ctx)
  const host = adapter.host
  const auto = new Autocompaction(host, config, store)
  let closed = false
  const stop = new AbortController()
  const requireSession = async (sessionID: string) => {
    if (closed) throw new Error("Context manager was unloaded; reopen the inspector")
    const value = await adapter.nativeSession(sessionID)
    readPolicy(sessionView(value))
    return value
  }
  const eligible = async (sessionID: string) => {
    await requireSession(sessionID)
    const state = await auto.state(sessionID)
    return state.pause ? state.pause.phase === "manual" : host.idle(sessionID)
  }
  const ownJob = async (sessionID: string, jobID: string) => {
    await requireSession(sessionID)
    if (!adapter.owns(jobID, sessionID)) throw new Error("Helper does not belong to this session or plugin generation")
  }
  const attempt = async <T>(reject: (message: string) => unknown, run: () => Promise<T>): Promise<T> => {
    try { return JSON.parse(JSON.stringify(await run())) as T }
    catch (error) { throw reject(errorMessage(error)) }
  }
  const rpc = await ctx.rpc.register(ContextManager, {
    inspect: ({ sessionID }, call) => attempt((message) => call.error("rejected", message, null), async () => {
      await requireSession(sessionID)
      const [session, messages, models, runtime, state] = await Promise.all([host.session(sessionID), host.messages(sessionID), host.models(), store.capture(sessionID), auto.state(sessionID)])
      return { version: VERSION, settings: config, session, messages, models, runtime, auto: state }
    }),
    idle: ({ sessionID }, call) => attempt((message) => call.error("rejected", message, null), () => eligible(sessionID)),
    state: ({ sessionID }, call) => attempt((message) => call.error("rejected", message, null), async () => { await requireSession(sessionID); return auto.state(sessionID) }),
    commit: ({ sessionID, policy, expected }, call) => attempt((message) => call.error("rejected", message, null), async () => {
      await requireSession(sessionID)
      call.signal.throwIfAborted()
      await auto.commit(sessionID, { [KEY]: policy }, expected)
      await rpc.events.emit("changed", { sessionID })
      return null
    }),
    command: ({ sessionID, command }, call) => attempt((message) => call.error("rejected", message, null), async () => {
      await requireSession(sessionID)
      call.signal.throwIfAborted()
      const state = await auto.command(sessionID, command)
      await rpc.events.emit("changed", { sessionID })
      return state
    }),
    createJob: ({ sessionID, purpose }, call) => attempt((message) => call.error("rejected", message, null), async () => {
      if (!await eligible(sessionID)) throw new Error("Wait for the main session or a live manual suspension")
      call.signal.throwIfAborted()
      const id = await host.createJob(purpose, sessionID)
      if (call.signal.aborted || closed) { await host.remove(id); throw new Error("Helper creation cancelled") }
      return id
    }),
    jobHistory: ({ sessionID, jobID }, call) => attempt((message) => call.error("rejected", message, null), async () => { await ownJob(sessionID, jobID); return host.messages(jobID) }),
    generate: ({ sessionID, jobID, model, text, purpose }, call) => attempt((message) => call.error("rejected", message, null), async () => {
      await ownJob(sessionID, jobID)
      if (!await eligible(sessionID)) throw new Error("Main session is no longer available for context maintenance")
      const selected = (await host.models()).find((entry) => entry.providerID === model.providerID && entry.id === model.modelID)
      if (!selected) throw new Error("Summary model is unavailable")
      const estimate = inputEstimate(text, tokenBasis(model, selected, config.tokenizer), await host.messages(jobID), purpose === "edit" ? SUMMARY_EDIT_SYSTEM : SUMMARIZER_SYSTEM)
      if (estimate > (selected.limit.input || selected.limit.context)) throw new Error("Summary dialogue exceeds the helper input capacity")
      call.signal.throwIfAborted()
      const abort = () => { void host.abort(jobID).catch(() => {}) }
      call.signal.addEventListener("abort", abort, { once: true })
      try { return await host.generate(jobID, model, text, purpose) }
      finally { call.signal.removeEventListener("abort", abort); if (call.signal.aborted) await host.remove(jobID).catch(() => {}) }
    }),
    abortJob: ({ sessionID, jobID }, call) => attempt((message) => call.error("rejected", message, null), async () => { await ownJob(sessionID, jobID); await host.abort(jobID); return null }),
    removeJob: ({ sessionID, jobID }, call) => attempt((message) => call.error("rejected", message, null), async () => { await ownJob(sessionID, jobID); await host.remove(jobID); return null }),
    dump: ({ sessionID }, call) => attempt((message) => call.error("rejected", message, null), async () => { await requireSession(sessionID); return new Controller(host, sessionID, config, store).dump(ctx.app.version) }),
  })
  await ctx.agent.transform((agents) => {
    for (const [id, system] of [[AGENT, SUMMARIZER_SYSTEM], [EDIT_AGENT, SUMMARY_EDIT_SYSTEM]]) agents.update(id, (agent) => {
      agent.description = "Internal context-manager helper"
      agent.mode = "subagent"
      agent.hidden = true
      agent.system = system
      agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      delete agent.steps
    })
  })
  const context = async (event: import("@opencode/plugin/promise/session").SessionContext, gate: boolean) => {
    const current = await requireSession(event.sessionID)
    if ([AGENT, EDIT_AGENT].includes(event.agent) && current.metadata?.context_manager_job) {
      event.system = [{ type: "text", text: event.agent === EDIT_AGENT ? SUMMARY_EDIT_SYSTEM : SUMMARIZER_SYSTEM }]
      event.tools = {}
      return
    }
    const native = await ctx.session.context({ sessionID: event.sessionID })
    const raw = transcriptView(current, native)
    const incoming = [...event.messages]
    const model = (await ctx.model.list()).data.find((entry) => entry.id === event.model.id && entry.providerID === event.model.providerID)
    const choice = { providerID: event.model.providerID, modelID: event.model.id, variant: event.model.variant }
    const basis = tokenBasis(choice, model && modelView(model), config.tokenizer)
    const estimate = (policy: ReturnType<typeof readPolicy>) => requestTokens(projectRequest(native, raw, incoming, policy), event.system, event.tools, basis)
    const capture = {
      sessionID: event.sessionID, time: Date.now(), model: choice, variant: event.model.variant, agent: event.agent,
      historyHash: historyHash(blockMessages(project(nativeActive(raw), readPolicy(sessionView(current))))),
      system: [...event.system.map((part) => part.text), ...incoming.filter((message) => message.role === "system").map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"))],
      tools: Object.entries(event.tools).map(([id, tool]) => ({ id, description: tool.description, parameters: tool.input })),
      warnings: ["Captured at this plugin's context hook; later hooks, provider framing, media and opaque state are not fully counted."],
    }
    await store.saveCapture(capture)
    if (gate) await auto.beforeRequest(raw, { model: choice, protectedIDs: [...protectedMessages(native)], estimate })
    const policy = readPolicy(sessionView(await requireSession(event.sessionID)))
    event.messages = projectRequest(native, raw, incoming, policy)
    capture.historyHash = historyHash(blockMessages(project(nativeActive(raw), policy)))
    capture.time = Date.now()
    await store.saveCapture(capture)
  }
  await ctx.session.hook("context", (event) => context(event, true))
  await ctx.session.hook("generate", (event) => context(event, false))
  await ctx.session.hook("compaction", () => { throw new Error("Context manager owns compaction. Set compaction.auto to false and use /context-manager, not native /compact.") })
  await ctx.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed") return
    const content = typeof event.result.content === "string" ? [{ type: "text" as const, text: event.result.content }] : event.result.content ?? []
    const text = content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n")
    if (spills(text, config.spill)) {
      const outputPath = await store.spill(text)
      event.result = { ...event.result, content: [{ type: "text", text: spillPreview(text, config.spill, outputPath) }, ...content.filter((part) => part.type !== "text")], metadata: { ...event.result.metadata, truncated: true, outputPath } }
    } else event.result = { ...event.result, metadata: { truncated: false, ...event.result.metadata } }
  })
  await store.cleanupOutputs()
  const listening = (async () => {
    for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
      if (event.type === "session.execution.interrupted" || event.type === "session.execution.failed" || event.type === "session.execution.succeeded") auto.cancel(event.data.sessionID)
      if (event.type === "session.moved") { auto.cancel(event.data.sessionID); await adapter.moved(event.data.sessionID).catch((error: unknown) => console.error("Context manager moved-session helper cleanup:", errorMessage(error))) }
      if (event.type === "session.deleted") { auto.cancel(event.data.sessionID); adapter.deleted(event.data.sessionID) }
    }
  })().catch((error: unknown) => { if (!stop.signal.aborted) { closed = true; auto.close(); console.error("Context manager event stream stopped; reload required:", errorMessage(error)) } })
  return async () => {
    closed = true
    auto.close()
    stop.abort()
    await listening
    await adapter.close()
  }
}

export default Plugin.define({ id: "context-manager", setup: setupServer })
