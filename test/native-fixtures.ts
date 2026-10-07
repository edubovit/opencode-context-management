import { Message } from "@opencode/ai"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"

export function nativeSession(id = "ses_native"): SessionInfo {
  return { id, projectID: "project", agent: "build", model: { providerID: "fixture", id: "model" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, location: { directory: "/fixture" }, time: { created: 1, updated: 1 }, metadata: { unrelated: "keep" } }
}

export function nativeFixture() {
  const session = nativeSession()
  const native: SessionMessageInfo[] = []
  const canonical: Message[] = []
  for (let n = 0; n < 3; n++) {
    const user = { id: `msg_u${n}`, type: "user" as const, text: `QUESTION_${n}`, time: { created: n * 10 + 1 } }
    native.push(user)
    canonical.push(Message.make({ id: user.id, role: "user", content: user.text }))
    if (n === 0) {
      native.push({ id: "msg_system", type: "system", text: "PRESERVE_CHRONOLOGICAL_INSTRUCTION", time: { created: 2 } })
      canonical.push(Message.system("PRESERVE_CHRONOLOGICAL_INSTRUCTION"))
    }
    const output = `HEAD_${n} ${"record detail ".repeat(500)} TAIL_${n}`
    const assistant: Extract<SessionMessageInfo, { type: "assistant" }> = {
      id: `msg_a${n}`, type: "assistant", agent: "build", model: session.model!, finish: "stop", time: { created: n * 10 + 3, completed: n * 10 + 4 },
      content: [
        { type: "reasoning", text: `REASON_${n}`, state: { signature: `proof_${n}` } },
        { type: "tool", id: `call_${n}`, name: "fixture", time: { created: 3, completed: 4 }, state: { status: "completed", input: { untouched: n }, content: [{ type: "text", text: output }], metadata: {} } },
        { type: "text", text: `ANSWER_${n}` },
      ],
    }
    native.push(assistant)
    canonical.push(Message.make({ id: assistant.id, role: "assistant", content: [
      { type: "reasoning", text: `REASON_${n}`, providerMetadata: { fixture: { signature: `proof_${n}` } } },
      { type: "tool-call", id: `call_${n}`, name: "fixture", input: { untouched: n } },
      { type: "text", text: `ANSWER_${n}` },
    ] }), Message.tool({ id: `call_${n}`, name: "fixture", result: { type: "text", value: output } }))
    native.push({ id: `msg_idle${n}`, type: "idle", outcome: "succeeded", time: { created: n * 10 + 5 } })
  }
  return { session, native, canonical }
}
