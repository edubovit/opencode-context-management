import type { SessionMessageInfo } from "@opencode/client"
import type { Model, Session } from "../src/model.ts"
import type { Envelope } from "../src/context.ts"
import { transcriptView, sessionView } from "../src/normalize.ts"
import { nativeSession } from "./native-fixtures.ts"
import type { Host, ModelChoice } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { bindPruneRule } from "../src/text.ts"
import { FALLBACK_BASIS } from "../src/tokens.ts"

export const suppliedOptions = {
  spill: { maxLines: 2000, maxBytes: 51200, headShare: 0.5 },
  prune: { threshold: 5000, head: 1000, tail: 1000 },
  summarizer: { providerID: "fixture", modelID: "fixture-summary", variant: "low" },
}

export function pruneRule(input: Partial<ReturnType<typeof settings>["prune"]> = {}) {
  return bindPruneRule({ ...settings().prune, ...input }, FALLBACK_BASIS)
}

export function session(id = "ses_test"): Session {
  return sessionView({ ...nativeSession(id), model: { providerID: "test", id: "model", variant: "high" } })
}

export function messages(sessionID = "ses_test", count = 3): Envelope[] {
  const native: SessionMessageInfo[] = Array.from({ length: count }, (_, n) => {
    const userID = `msg_${n}_u`
    const assistantID = `msg_${n}_a`
    return [
      { id: userID, type: "user", text: `Question ${n}`, time: { created: n * 10 } },
      { id: assistantID, type: "assistant", model: { providerID: "test", id: "model", variant: "high" }, agent: "build", time: { created: n * 10 + 1, completed: n * 10 + 2 }, finish: "stop", content: [
        { type: "tool", id: `call_${n}`, name: n === 1 ? "skill" : "shell", time: { created: 2, completed: 3 }, state: { status: "completed", input: { command: "echo original input" }, content: [{ type: "text", text: `HEAD_${n}` + "abcd0123!?".repeat(1500) + `TAIL_${n}` }], metadata: {} } },
        { type: "reasoning", text: "Visible reasoning" }, { type: "text", text: `Answer ${n}` },
      ] },
    ] satisfies SessionMessageInfo[]
  }).flat()
  return transcriptView({ ...nativeSession(sessionID), model: { providerID: "test", id: "model", variant: "high" } }, native)
}

export function model(): Model {
  return { id: "model", providerID: "test", modelID: "model", name: "Fixture model", limit: { context: 200000, output: 32000 }, variants: [{ id: "high", settings: { reasoningEffort: "high" } }] }
}

export function fixtureHost() {
  const data = {
    session: session(), messages: messages(), idle: true, model: model(), prompts: [] as string[],
    calls: [] as { sessionID: string; choice: ModelChoice; text: string }[],
    conversations: new Map<string, Envelope[]>(), removed: [] as string[], aborted: [] as string[],
    responses: ["A useful detailed summary."], jobs: 0, enabled: true,
  }
  const host: Host = {
    session: async () => structuredClone(data.session),
    messages: async (id) => structuredClone(id === data.session.id ? data.messages : data.conversations.get(id) ?? []),
    idle: async () => data.idle,
    update: async (_id, metadata) => { data.session.metadata = structuredClone(metadata) },
    models: async () => [data.model],
    configured: async () => data.enabled,
    createJob: async () => {
      const id = `job_${++data.jobs}`
      data.conversations.set(id, [])
      return id
    },
    generate: async (id, choice, text) => {
      data.prompts.push(text)
      data.calls.push({ sessionID: id, choice: structuredClone(choice), text })
      const reply = data.responses.shift() ?? "summary"
      const turn = messages(id, 1)
      for (const [index, message] of turn.entries()) {
        message.info.id = `msg_job_${data.calls.length}_${index}`
        message.info.agent = "context-manager-summarizer"
        if (message.info.role === "user") message.info.model = { ...choice }
        message.parts = [{ type: "text", id: `prt_job_${data.calls.length}_${index}`, messageID: message.info.id, sessionID: id, text: index === 0 ? text : reply }]
      }
      data.conversations.get(id)!.push(...turn)
      return reply
    },
    abort: async (id) => { data.aborted.push(id) },
    remove: async (id) => { data.removed.push(id); data.conversations.delete(id) },
  }
  return { host, data }
}
