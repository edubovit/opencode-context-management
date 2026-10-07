import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { PluginContext } from "../src/host.ts"
import { nativeSession } from "./native-fixtures.ts"

export function mockContext() {
  const sessions = new Map<string, SessionInfo>([["ses_native", nativeSession()]])
  const messages = new Map<string, SessionMessageInfo[]>([["ses_native", []]])
  const state = { finish: "stop", failure: false, prompts: [] as string[], created: [] as Record<string, unknown>[], removed: [] as string[], interrupted: [] as string[], switchWait: Promise.resolve(), version: "2.0.24" }
  const hooks = new Map<string, (event: unknown) => Promise<void>>()
  const agents = new Map<string, Record<string, unknown>>()
  let jobs = 0
  const context = {
    app: { get version() { return state.version } }, location: { directory: "/fixture", project: { id: "project", directory: "/fixture", canonical: "/fixture" } }, options: {},
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { const value = sessions.get(sessionID); if (!value) throw new Error("Session missing"); return structuredClone(value) },
      context: async ({ sessionID }: { sessionID: string }) => structuredClone(messages.get(sessionID) ?? []),
      wait: async () => {},
      update: async ({ sessionID, metadata }: { sessionID: string; metadata: SessionInfo["metadata"] }) => { sessions.get(sessionID)!.metadata = structuredClone(metadata) },
      create: async (input: Record<string, unknown>) => {
        state.created.push(input)
        const value = { ...nativeSession(`ses_job${++jobs}`), ...input } as SessionInfo
        sessions.set(value.id, value); messages.set(value.id, [])
        return structuredClone(value)
      },
      switchModel: async ({ sessionID, model }: { sessionID: string; model: NonNullable<SessionInfo["model"]> }) => { await state.switchWait; sessions.get(sessionID)!.model = model },
      prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => {
        state.prompts.push(text)
        const id = `msg_prompt${state.prompts.length}`
        const value = sessions.get(sessionID)!
        messages.get(sessionID)!.push({ id, type: "user", text, time: { created: 1 } }, {
          id: `msg_answer${state.prompts.length}`, type: "assistant", agent: value.agent!, model: value.model!, time: { created: 2, completed: 3 },
          finish: state.finish as "stop" | "length", ...(state.failure ? { error: { type: "provider.rate-limit", message: "Slow down", status: 429 } } : {}),
          content: [{ type: "reasoning", text: "not the answer" }, { type: "text", text: "Answer only" }],
        })
        value.outcome = state.failure ? "failed" : "succeeded"
        return { id }
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => { state.interrupted.push(sessionID); sessions.get(sessionID)!.outcome = "interrupted" },
      remove: async ({ sessionID }: { sessionID: string }) => { state.removed.push(sessionID); sessions.delete(sessionID); messages.delete(sessionID) },
      hook: async (name: string, callback: (event: unknown) => Promise<void>) => { hooks.set(name, callback) },
    },
    model: { list: async () => ({ location: { directory: "/fixture" }, data: [{ id: "model", modelID: "api-model", providerID: "fixture", name: "Fixture", package: "@opencode/ai/providers/openai-compatible", variants: [{ id: "high" }], limit: { context: 200000, input: 168000, output: 32000 } }] }) },
    agent: { transform: async (callback: (editor: { update(id: string, update: (value: Record<string, unknown>) => void): void }) => void) => callback({ update: (id, update) => { const value = {}; update(value); agents.set(id, value) } }) },
    rpc: { register: async () => ({ events: { emit: async () => {} } }) },
    tool: { hook: async (name: string, callback: (event: unknown) => Promise<void>) => { hooks.set(name, callback) } },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) { await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); if (signal.aborted) resolve() }) } },
  } as unknown as PluginContext
  return { context, state, sessions, messages, hooks, agents }
}
