import { randomUUID } from "node:crypto"
import { Plugin } from "@opencode/plugin"
import { Activity } from "../../src/v2/activity.ts"
import { Gates } from "../../src/v2/gates.ts"
import { fingerprint, protectedMessages, type Transcript } from "../../src/v2/history.ts"
import { pruneRequest } from "../../src/v2/request.ts"
import { TOKENIZER_ID } from "../../src/tokens.ts"
import { fixtureRpc, plan } from "./rpc.ts"

const key = "context_manager_v2_fixture"

export default Plugin.define({
  id: "context-manager-v2-fixture",
  async setup(ctx) {
    const generation = randomUUID()
    const gates = new Gates()
    const activity = new Activity((sessionID) => ctx.session.wait({ sessionID }))
    const captures = new Map<string, { before: unknown; after: unknown; transcript: Transcript; options: unknown }>()
    const pauseSources = new Map<string, string>()
    const tui: string[] = []
    const stop = new AbortController()
    const listening = (async () => {
      for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
        if (event.type === "session.execution.interrupted" || event.type === "session.execution.failed" || event.type === "session.execution.succeeded") gates.cancel(event.data.sessionID)
      }
    })().catch((error: unknown) => { if (!stop.signal.aborted) { gates.close(); throw error } })
    void listening.catch(() => {})
    const session = async (sessionID: string) => {
      const value = await ctx.session.get({ sessionID })
      if (value.location.directory !== ctx.location.directory) throw new Error("Fixture session belongs to another location")
      return value
    }
    const rpc = await ctx.rpc.register(fixtureRpc, {
      status: async ({ sessionID }) => {
        await session(sessionID)
        return { generation, pauseID: gates.current(sessionID) ?? null, idle: await activity.idle(sessionID), cleanupCount: await ctx.storage.get("cleanupCount") ?? 0, tui }
      },
      arm: async ({ sessionID, plan: next }) => {
        const current = await session(sessionID)
        if (!await activity.idle(sessionID)) throw new Error("Fixture cannot change a running session")
        const transcript = await ctx.session.context({ sessionID })
        const sourceIDs = next.sourceIDs.length ? next.sourceIDs : transcript.filter((message) => message.type === "user" || message.type === "assistant").map((message) => message.id)
        await ctx.session.update({ sessionID, metadata: { ...current.metadata, [key]: { ...next, sourceIDs, sourceHash: fingerprint(transcript.filter((message) => sourceIDs.includes(message.id))) } } })
        return null
      },
      resume: async ({ sessionID, pauseID }, call) => {
        await session(sessionID)
        if (gates.current(sessionID) !== pauseID) return call.error("stale", "This context suspension is no longer active", {})
        if (fingerprint(await ctx.session.context({ sessionID })) !== pauseSources.get(sessionID)) return call.error("stale", "Paused source changed", {})
        gates.release(sessionID, pauseID)
        return null
      },
      inspect: async ({ sessionID }) => {
        await session(sessionID)
        return { generation, capture: captures.get(sessionID) ?? null, transcript: await ctx.session.context({ sessionID }) }
      },
      tui: async ({ phase }) => { tui.push(phase); return null },
    })
    await ctx.session.hook("title", (event) => { event.result = "Synthetic context-manager test" })
    await ctx.session.hook("context", async (event) => {
      const current = await session(event.sessionID)
      if (current.metadata?.opencode_context_manager !== undefined) throw new Error("This isolated test fixture does not replay saved policies")
      const options = JSON.parse(JSON.stringify(event.options)) as unknown
      const transcript = await ctx.session.context({ sessionID: event.sessionID })
      const selected = plan.parse(current.metadata?.[key] ?? { pause: false })
      const before = JSON.parse(JSON.stringify(event.messages)) as unknown
      if (selected.pause) {
        pauseSources.set(event.sessionID, fingerprint(transcript))
        await gates.pause(event.sessionID, (pauseID) => rpc.events.emit("paused", { sessionID: event.sessionID, pauseID }))
      }
      if (selected.modes) {
        if (fingerprint(transcript.filter((message) => selected.sourceIDs.includes(message.id))) !== selected.sourceHash) throw new Error("Saved pruning source changed")
        event.messages = pruneRequest(transcript, event.messages, {
          sourceIDs: selected.sourceIDs,
          fingerprint: fingerprint(transcript),
          modes: selected.modes,
          protectedIDs: protectedMessages(transcript),
          rule: { unit: "tokens", encoding: "o200k_base", library: TOKENIZER_ID, threshold: 200, head: 20, tail: 20 },
        })
      }
      captures.set(event.sessionID, { before, after: JSON.parse(JSON.stringify(event.messages)) as unknown, transcript, options })
    })
    await ctx.session.hook("compaction", () => { throw new Error("Context-manager fixture rejects native compaction") })
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "fixture_tool", description: "Synthetic fixture output", input: { type: "object", properties: {} }, options: { codemode: false },
        execute: async () => ({ content: "HEAD_FIXTURE " + "long fixture output ".repeat(500) + " TAIL_FIXTURE", metadata: { truncated: false } }),
      })
    })
    return async () => {
      gates.close()
      activity.close()
      stop.abort()
      await listening
      const count = await ctx.storage.get("cleanupCount")
      await ctx.storage.set("cleanupCount", (typeof count === "number" ? count : 0) + 1)
    }
  },
})
