import type { Model, Session, ToolPart } from "@opencode-ai/sdk/v2"
import type { Envelope, Policy } from "../src/context.ts"
import type { Host, ModelChoice } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { bindPruneRule } from "../src/text.ts"
import { FALLBACK_BASIS } from "../src/tokens.ts"

export const suppliedOptions = {
  spill: { maxLines: 2000, maxBytes: 51200, headShare: 0.5 },
  prune: { threshold: 5000, head: 1000, tail: 1000 },
  summarizer: { providerID: "fixture", modelID: "fixture-summary", variant: "low" },
}

export function pruneRule() {
  return bindPruneRule(settings().prune, FALLBACK_BASIS)
}

export function legacyCursor(policy: Policy, delta: -1 | 1): Policy {
  return { ...policy, cursor: policy.cursor + delta, revision: policy.revision + 1 }
}

export function session(id = "ses_test"): Session {
  return { id, slug: "test", projectID: "project", directory: "C:/fixture", title: "Fixture", version: "1.18.32", time: { created: 1, updated: 1 }, metadata: { unrelated: "keep" } }
}

export function messages(sessionID = "ses_test", count = 3): Envelope[] {
  return Array.from({ length: count }, (_, n) => {
    const userID = `msg_${n}_u`
    const assistantID = `msg_${n}_a`
    const tool: ToolPart = {
      type: "tool", id: `prt_${n}_tool`, messageID: assistantID, sessionID, callID: `call_${n}`, tool: n === 1 ? "skill" : "bash",
      state: { status: "completed", input: { command: "echo original input" }, output: `HEAD_${n}` + "abcd0123!?".repeat(1500) + `TAIL_${n}`, title: "result", metadata: {}, time: { start: 2, end: 3 } },
    }
    return [
      { info: { id: userID, sessionID, role: "user", agent: "build", model: { providerID: "test", modelID: "model", variant: "high" }, time: { created: n * 10 } }, parts: [{ type: "text", id: `prt_${n}_u`, sessionID, messageID: userID, text: `Question ${n}` }] },
      { info: { id: assistantID, sessionID, role: "assistant", parentID: userID, modelID: "model", providerID: "test", mode: "build", agent: "build", path: { cwd: "C:/fixture", root: "C:/fixture" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: n * 10 + 1, completed: n * 10 + 2 }, finish: "stop" }, parts: [tool, { type: "reasoning", id: `prt_${n}_r`, sessionID, messageID: assistantID, text: "Visible reasoning", time: { start: 1, end: 2 } }, { type: "text", id: `prt_${n}_a`, sessionID, messageID: assistantID, text: `Answer ${n}` }] },
    ] satisfies Envelope[]
  }).flat()
}

export function model(): Model {
  const media = { text: true, image: false, audio: false, pdf: false, video: false }
  return { id: "model", providerID: "test", api: { id: "model", url: "http://invalid", npm: "test" }, name: "Fixture model", capabilities: { temperature: true, reasoning: true, attachment: false, toolcall: true, input: media, output: media, interleaved: false }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01", variants: { high: { reasoningEffort: "high" } } }
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
