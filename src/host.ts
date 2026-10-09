import type { Plugin } from "@opencode/plugin"
import type { SessionInfo } from "@opencode/client"
import { AGENT, EDIT_AGENT, KEY } from "./config.ts"
import { AUTO_KEY, strategy } from "./auto-state.ts"
import type { HelperTrigger, Host } from "./controller.ts"
import { Activity } from "./activity.ts"
import { modelView, sessionView, transcriptView } from "./normalize.ts"
import { emptyPolicy, readPolicy } from "./context.ts"
import { validateNativePolicy } from "./projection.ts"

export type PluginContext = Parameters<Plugin.Plugin["setup"]>[0]

export function pluginHost(ctx: PluginContext) {
  const activity = new Activity((sessionID) => ctx.session.wait({ sessionID }))
  const jobs = new Map<string, { owner: string; purpose: "summary" | "edit"; trigger: HelperTrigger; running: boolean; cancelled: boolean; budgetError?: string }>()
  const loading = new Map<string, Promise<SessionInfo>>()
  let closed = false
  const loadSession = async (sessionID: string): Promise<SessionInfo> => {
    if (closed) throw new Error("Context manager has been unloaded")
    const value = await ctx.session.get({ sessionID })
    if (value.location.directory !== ctx.location.directory)
      throw new Error("Session location changed. Reopen the context manager in its current location.")
    if (value.parentID && !value.fork && !value.metadata?.context_manager_job) {
      const saved = value.metadata?.[KEY]
      const owner = saved && typeof saved === "object" && "sessionID" in saved ? saved.sessionID : undefined
      if (saved !== undefined && owner !== value.id) {
        if (typeof owner !== "string") throw new Error("Invalid inherited context-manager state")
        readPolicy({ ...sessionView(value), id: owner })
        let ancestor: string | undefined = value.parentID
        while (ancestor && ancestor !== owner) ancestor = (await ctx.session.get({ sessionID: ancestor })).parentID
        if (!ancestor) throw new Error("Context-manager ledger does not belong to this child or its ancestors")
      }
      if (saved === undefined || owner !== value.id) {
        const metadata: NonNullable<SessionInfo["metadata"]> = JSON.parse(JSON.stringify({ ...value.metadata, [KEY]: emptyPolicy(value.id), [AUTO_KEY]: { strategy: strategy(sessionView(value)) } }))
        if (closed) throw new Error("Context manager unloaded before child initialization")
        await ctx.session.update({ sessionID, metadata })
        return { ...value, metadata }
      }
    }
    return value
  }
  const nativeSession = (sessionID: string): Promise<SessionInfo> => {
    const pending = loading.get(sessionID)
    if (pending) return pending
    const next = loadSession(sessionID).finally(() => { loading.delete(sessionID) })
    loading.set(sessionID, next)
    return next
  }
  const host: Host = {
    session: async (id) => sessionView(await nativeSession(id)),
    messages: async (id) => {
      const value = await nativeSession(id)
      return transcriptView(value, await ctx.session.context({ sessionID: id }))
    },
    idle: (id) => activity.idle(id),
    configured: async () => !closed,
    models: async () => (await ctx.model.list()).data.map(modelView),
    update: async (id, metadata) => {
      const session = await nativeSession(id)
      const native = await ctx.session.context({ sessionID: id })
      const policy = readPolicy({ ...sessionView(session), metadata })
      validateNativePolicy(native, transcriptView(session, native), policy)
      await ctx.session.update({ sessionID: id, metadata: JSON.parse(JSON.stringify(metadata)) })
    },
    createJob: async (purpose = "summary", ownerID, trigger = "auto") => {
      if (!ownerID) throw new Error("Summary job owner is required")
      await nativeSession(ownerID)
      const job = await ctx.session.create({
        parentID: ownerID, title: purpose === "edit" ? "Context manager summary edit" : "Context manager summary job",
        agent: purpose === "edit" ? EDIT_AGENT : AGENT,
        metadata: { context_manager_job: true, context_manager_edit: purpose === "edit" },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      })
      jobs.set(job.id, { owner: ownerID, purpose, trigger, running: false, cancelled: false })
      if (closed) { await ctx.session.remove({ sessionID: job.id }); jobs.delete(job.id); throw new Error("Context manager unloaded while creating a helper") }
      try { await nativeSession(ownerID) }
      catch (error) { await ctx.session.remove({ sessionID: job.id }); jobs.delete(job.id); throw error }
      return job.id
    },
    generate: async (id, choice, text, purpose = "summary") => {
      const job = jobs.get(id)
      if (!job || job.purpose !== purpose) throw new Error("Summary helper is not owned by this plugin generation")
      if (job.running) throw new Error("Summary helper already has a pending request")
      job.running = true
      job.cancelled = false
      job.budgetError = undefined
      try {
        await nativeSession(id)
        await ctx.session.switchModel({ sessionID: id, model: { providerID: choice.providerID, id: choice.modelID, variant: choice.variant ?? "default" } })
        if (closed || !jobs.has(id) || job.cancelled) throw new Error("Summary cancelled")
        const admitted = await ctx.session.prompt({ sessionID: id, text })
        if (closed || !jobs.has(id) || job.cancelled) await ctx.session.interrupt({ sessionID: id, resume: false })
        await ctx.session.wait({ sessionID: id })
        if (closed || !jobs.has(id) || job.cancelled) throw new Error("Summary cancelled")
        if (job.budgetError) throw new Error(job.budgetError)
        const current = await nativeSession(id)
        const messages = await ctx.session.context({ sessionID: id })
        const start = messages.findIndex((message) => message.id === admitted.id && message.type === "user")
        if (start < 0) throw new Error("Summary input was not delivered")
        const reply = messages.slice(start + 1).findLast((message) => message.type === "assistant")
        if (current.outcome !== "succeeded" || !reply || reply.type !== "assistant" || reply.error)
          throw new Error(`Summarizer failed: ${reply?.type === "assistant" && reply.error ? `${reply.error.type}: ${reply.error.message}` : current.outcome ?? "no completed response"}`)
        if (reply.finish === "length") throw new Error("Summarizer reached the host/provider output limit; incomplete draft rejected")
        if (reply.finish !== "stop" || !reply.time.completed) throw new Error(`Summarizer did not finish successfully (${reply.finish ?? "unfinished"})`)
        return reply.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n")
      } finally { job.running = false }
    },
    abort: async (id) => { const job = jobs.get(id); if (job) job.cancelled = true; await nativeSession(id); await ctx.session.interrupt({ sessionID: id, resume: false }) },
    remove: async (id) => {
      if (!jobs.has(id)) throw new Error("Only owned summary helpers can be removed")
      await ctx.session.remove({ sessionID: id })
      jobs.delete(id)
    },
  }
  return {
    host, nativeSession,
    owns: (id: string, owner: string) => jobs.get(id)?.owner === owner,
    manualJob: (id: string) => jobs.get(id)?.trigger === "manual",
    budgetFailure: (id: string, message: string) => { const job = jobs.get(id); if (job) job.budgetError = message },
    moved: async (owner: string) => {
      await Promise.all([...jobs].filter(([, job]) => job.owner === owner).map(async ([id, job]) => { job.cancelled = true; await host.remove(id) }))
    },
    deleted: (id: string) => {
      jobs.delete(id)
      for (const [jobID, job] of jobs) if (job.owner === id) { job.cancelled = true; jobs.delete(jobID) }
    },
    close: async () => {
      closed = true
      activity.close()
      await Promise.allSettled([...loading.values()])
      const results = await Promise.allSettled([...jobs.keys()].map(async (id) => { await ctx.session.remove({ sessionID: id }); jobs.delete(id) }))
      if (results.some((result) => result.status === "rejected")) throw new Error("Some owned helpers could not be removed during plugin cleanup")
    },
  }
}
