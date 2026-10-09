import type { ModelInfo, SessionInfo, SessionMessageInfo } from "@opencode/client"

export type ModelChoice = { providerID: string; modelID: string; variant?: string }
export type Usage = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
export type Model = Pick<ModelInfo, "id" | "providerID" | "modelID" | "name" | "package" | "limit" | "variants">
export type Session = Pick<SessionInfo, "id" | "parentID" | "model" | "revert" | "location" | "title" | "time"> & { metadata?: Record<string, unknown> }
type MessageBase = {
  id: string; sessionID: string; agent: string; time: { created: number; completed?: number }
  kind: SessionMessageInfo["type"]; sourceHash?: string
}
export type UserMessage = MessageBase & { role: "user"; model: ModelChoice }
export type AssistantMessage = MessageBase & {
  role: "assistant"; providerID: string; modelID: string
  finish?: string; error?: unknown; tokens: Usage; cost: number
}
export type Message = UserMessage | AssistantMessage
type PartBase = { id: string; sessionID: string; messageID: string; metadata?: Record<string, unknown> }
export type FilePart = PartBase & { type: "file"; mime: string; filename?: string; url: string }
export type ToolPart = PartBase & {
  type: "tool"; callID: string; tool: string
  state:
    | { status: "pending" | "running"; input: Record<string, unknown>; metadata?: Record<string, unknown> }
    | { status: "completed"; input: Record<string, unknown>; output: string; metadata: Record<string, unknown>; attachments?: FilePart[]; time: { start: number; end: number } }
    | { status: "error"; input: Record<string, unknown>; error: string; metadata?: Record<string, unknown>; attachments?: FilePart[] }
}
export type Part = ToolPart | FilePart
  | (PartBase & { type: "text"; text: string; synthetic?: boolean })
  | (PartBase & { type: "reasoning"; text: string })
  | (PartBase & { type: "context"; text: string; category: "system" | "skill" | "synthetic" | "shell" | "control" })
