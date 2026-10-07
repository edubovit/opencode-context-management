import type { ModelInfo, SessionInfo, SessionMessageInfo, ToolContent } from "@opencode/client"
import type { Envelope } from "../context.ts"
import { hash } from "../context.ts"
import type { FilePart, Model, Part, Session, ToolPart, Usage } from "../model.ts"

const zero = (): Usage => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

export function sessionView(value: SessionInfo): Session {
  return {
    id: value.id, nativeVersion: 2, directory: value.location.directory, title: value.title ?? undefined,
    time: { created: value.time.created, updated: value.time.updated },
    ...(value.model ? { model: { id: value.model.id, providerID: value.model.providerID, ...(value.model.variant ? { variant: value.model.variant } : {}) } } : {}),
    ...(value.metadata ? { metadata: value.metadata } : {}),
    ...(value.revert ? { revert: { messageID: value.revert.messageID } } : {}),
  }
}

export function modelView(value: ModelInfo): Model {
  return {
    id: value.id, providerID: value.providerID, name: value.name,
    api: { id: value.modelID, npm: value.package ?? "" },
    limit: { context: value.limit.context, output: value.limit.output, ...(value.limit.input ? { input: value.limit.input } : {}) },
    variants: Object.fromEntries(value.variants.map((variant) => [variant.id, {}])),
  }
}

export function transcriptView(session: SessionInfo, messages: readonly SessionMessageInfo[]): Envelope[] {
  let parentID = ""
  return messages.map((message) => {
    if (message.type === "user") parentID = message.id
    const base = { id: message.id, sessionID: session.id, agent: session.agent ?? "build", kind: message.type, sourceHash: hash(message), time: { created: message.time.created } }
    const model = session.model ?? { providerID: "", id: "" }
    const partBase = (index: string | number) => ({ id: `${message.id}:${index}`, messageID: message.id, sessionID: session.id })
    if (message.type === "user") return {
      info: { ...base, role: "user" as const, model: { providerID: model.providerID, modelID: model.id, variant: model.variant ?? undefined } },
      parts: [
        ...(message.text ? [{ ...partBase("text"), type: "text" as const, text: message.text }] : []),
        ...(message.files ?? []).map((file, index): Part => {
          const name = file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")
          if (file.mime === "text/plain" || file.mime === "application/x-directory") return {
            ...partBase(`file:${index}`), type: "text",
            text: [`[Attached ${file.mime === "text/plain" ? "file" : "directory"}: ${name}]`, file.description, Buffer.from(file.data, "base64").toString("utf8")].filter((value) => value !== undefined).join("\n"),
          }
          return { ...partBase(`file:${index}`), type: "file", mime: file.mime, filename: name, url: `data:${file.mime};base64,${file.data}` }
        }),
        ...(message.skills ?? []).flatMap((skill, index): Part[] => skill.text ? [{ ...partBase(`skill:${index}`), type: "context", category: "skill", text: skill.text }] : []),
      ],
    }
    if (message.type === "assistant") return {
      info: {
        ...base, role: "assistant" as const, parentID, agent: message.agent, providerID: message.model.providerID, modelID: message.model.id,
        time: { created: message.time.created, completed: message.time.completed ?? undefined }, finish: message.finish ?? undefined,
        error: message.error ?? undefined, tokens: message.tokens ?? zero(), cost: message.cost ?? 0,
      },
      parts: message.content.map((content, index): Part => {
        if (content.type !== "tool") return { ...partBase(index), type: content.type, text: content.text, ...(content.state ? { metadata: content.state } : {}) }
        const key = partBase(`tool:${content.id}`)
        const common = { ...key, type: "tool" as const, nativeVersion: 2 as const, callID: content.id, tool: content.name, ...(content.providerState ? { metadata: content.providerState } : {}) }
        if (content.state.status === "streaming") return { ...common, state: { status: "pending", input: { partial: content.state.input } } }
        if (content.state.status === "running") return { ...common, state: { status: "running", input: content.state.input, metadata: content.state.metadata } }
        if (content.state.status === "error") return {
          ...common, state: {
            status: "error", input: content.state.input, error: [content.state.error.message, contentText(content.state.content ?? [])].filter(Boolean).join("\n\n"), metadata: content.state.metadata ?? {},
            attachments: (content.state.content ?? []).flatMap((item, index): FilePart[] => item.type === "file" ? [{ ...partBase(`result:${content.id}:${index}`), type: "file", url: item.uri, mime: item.mime, filename: item.name ?? undefined }] : []),
          },
        }
        const tool: ToolPart = {
          ...common, state: {
            status: "completed", input: content.state.input, output: contentText(content.state.content), metadata: content.state.metadata ?? {},
            time: { start: content.time.created, end: content.time.completed ?? content.time.created },
            attachments: content.state.content.flatMap((item, index): FilePart[] => item.type === "file" ? [{ ...partBase(`result:${content.id}:${index}`), type: "file", url: item.uri, mime: item.mime, filename: item.name ?? undefined }] : []),
          },
        }
        return tool
      }),
    }
    const text = message.type === "skill" || message.type === "system" || message.type === "synthetic" ? message.text
      : message.type === "shell" ? `[Shell ${message.command}]\n${message.output?.output ?? ""}`
      : message.type === "compaction" ? (message.status === "completed" ? `${message.summary}\n${message.recent}` : `[Native compaction ${message.status}]`)
      : `[${message.type}]`
    return {
      info: { ...base, role: "assistant" as const, parentID, providerID: model.providerID, modelID: model.id, cost: 0, tokens: zero() },
      parts: [{ ...partBase("context"), type: "context" as const, category: message.type === "skill" ? "skill" as const : message.type === "shell" ? "shell" as const : message.type === "synthetic" ? "synthetic" as const : "system" as const, text }],
    }
  })
}

export function contentText(content: readonly ToolContent[]) {
  return content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n\n")
}
