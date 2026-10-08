export type ModelChoice = { providerID: string; modelID: string; variant?: string }
export type Usage = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
export type Model = {
  id: string; providerID: string; name: string; api: { id: string; npm: string; url?: string }
  limit: { context: number; input?: number; output: number }
  variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>
  [key: string]: unknown
}
export type Session = {
  id: string; parentID?: string; metadata?: Record<string, unknown>; nativeVersion?: 2
  model?: { id: string; providerID: string; variant?: string }
  revert?: { messageID: string; partID?: string; [key: string]: unknown }
  directory?: string; title?: string; time: { created: number; updated: number }
  [key: string]: unknown
}
type MessageBase = {
  id: string; sessionID: string; agent: string; time: { created: number; completed?: number }
  kind?: string; sourceHash?: string; [key: string]: unknown
}
export type UserMessage = MessageBase & { role: "user"; model: ModelChoice }
export type AssistantMessage = MessageBase & {
  role: "assistant"; parentID: string; providerID: string; modelID: string
  finish?: string; error?: unknown; summary?: boolean; tokens: Usage; cost: number
}
export type Message = UserMessage | AssistantMessage
type PartBase = { id: string; sessionID: string; messageID: string; metadata?: Record<string, unknown> }
export type FilePart = PartBase & { type: "file"; mime: string; filename?: string; url: string; [key: string]: unknown }
export type ToolPart = PartBase & {
  type: "tool"; callID: string; tool: string; nativeVersion?: 2
  state:
    | { status: "pending" | "running"; input: Record<string, unknown>; metadata?: Record<string, unknown>; [key: string]: unknown }
    | { status: "completed"; input: Record<string, unknown>; output: string; metadata: Record<string, unknown>; attachments?: FilePart[]; time: { start: number; end: number; compacted?: number }; [key: string]: unknown }
    | { status: "error"; input: Record<string, unknown>; error: string; metadata?: Record<string, unknown>; attachments?: FilePart[]; [key: string]: unknown }
}
export type Part = ToolPart | FilePart
  | (PartBase & { type: "text"; text: string; ignored?: boolean; synthetic?: boolean; [key: string]: unknown })
  | (PartBase & { type: "reasoning"; text: string; [key: string]: unknown })
  | (PartBase & { type: "context"; text: string; category: "system" | "skill" | "synthetic" | "shell" | "control" })
  | (PartBase & { type: "compaction"; tail_start_id?: string; [key: string]: unknown })
  | (PartBase & { type: "step-start" | "step-finish" | "snapshot" | "patch" | "agent" | "subtask" | "retry"; [key: string]: unknown })
