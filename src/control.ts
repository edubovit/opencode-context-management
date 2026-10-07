import type { OpenCodeClient } from "@opencode/client"
import { ContextManager, errorMessage, type Inspection } from "./rpc.ts"
import type { Host } from "./controller.ts"
import type { Artifacts } from "./storage.ts"
import { KEY } from "./config.ts"
import type { Policy } from "./context.ts"

export function remoteHost(client: OpenCodeClient, sessionID: string) {
  const rpc = client.rpc(ContextManager)
  let pending: Promise<Inspection> | undefined
  let closed = false
  const jobs = new Set<string>()
  const creates = new Set<Promise<string>>()
  const removals = new Map<string, Promise<void>>()
  const location = async () => ({ location: (await client.session.get({ sessionID })).location })
  const call = async <T>(run: (options: Awaited<ReturnType<typeof location>>) => Promise<T>) => {
    try { return await run(await location()) }
    catch (error) { throw new Error(errorMessage(error)) }
  }
  const load = () => {
    if (!pending) pending = call((options) => rpc.inspect({ sessionID }, options)).finally(() => { pending = undefined })
    return pending
  }
  const auto = {
    state: async (_id: string) => call((options) => rpc.state({ sessionID }, options)),
    command: async (_id: string, command: Parameters<NonNullable<Host["auto"]>["command"]>[1]) => call((options) => rpc.command({ sessionID, command }, options)),
    commit: async (_id: string, metadata: Record<string, unknown>, expected: Parameters<NonNullable<Host["auto"]>["commit"]>[2]) => {
      await call((options) => rpc.commit({ sessionID, policy: metadata[KEY] as Policy, expected }, options))
    },
  }
  const host: Host = {
    auto,
    session: async () => (await load()).session,
    messages: async (id) => id === sessionID ? (await load()).messages : call((options) => rpc.jobHistory({ sessionID, jobID: id }, options)),
    models: async () => (await load()).models,
    idle: async () => call((options) => rpc.idle({ sessionID }, options)),
    configured: async () => { await load(); return true },
    update: async (_id, metadata, expected) => {
      if (!expected) throw new Error("Missing maintenance source check")
      await auto.commit(sessionID, metadata, expected)
    },
    createJob: (purpose = "summary") => {
      if (closed) return Promise.reject(new Error("Inspector is closed"))
      const request = call((options) => rpc.createJob({ sessionID, purpose }, options)).then(async (id) => {
        jobs.add(id)
        if (closed) { await host.remove(id); throw new Error("Inspector closed during helper creation") }
        return id
      })
      creates.add(request)
      void request.finally(() => creates.delete(request)).catch(() => {})
      return request
    },
    generate: (jobID, model, text, purpose = "summary") => call((options) => rpc.generate({ sessionID, jobID, model, text, purpose }, options)),
    abort: async (jobID) => { if (jobs.has(jobID) && !removals.has(jobID)) await call((options) => rpc.abortJob({ sessionID, jobID }, options)) },
    remove: async (jobID) => {
      const pending = removals.get(jobID)
      if (pending) return pending
      if (!jobs.has(jobID)) return
      const removal = call((options) => rpc.removeJob({ sessionID, jobID }, options)).then(() => { jobs.delete(jobID) }).finally(() => { removals.delete(jobID) })
      removals.set(jobID, removal)
      return removal
    },
  }
  const artifacts: Artifacts = {
    capture: async () => (await load()).runtime,
    write: async () => call((options) => rpc.dump({ sessionID }, options)),
  }
  return { host, artifacts, load, close: async () => {
    closed = true
    await Promise.allSettled([...creates])
    const results = await Promise.allSettled([...jobs].map((id) => host.remove(id)))
    if (results.some((result) => result.status === "rejected")) throw new Error("Some helper cleanup failed; reopen the inspector or restart the plugin")
  } }
}
