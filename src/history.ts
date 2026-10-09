import type { SessionMessageInfo } from "@opencode/client"

export function protectedMessages(messages: readonly SessionMessageInfo[]): ReadonlySet<string> {
  const boundary = messages.findLastIndex((message) => message.type === "idle")
  const tail = messages.slice(boundary + 1)
  const start = tail.findIndex((message) => message.type === "user")
  return new Set((start < 0 ? tail : tail.slice(start)).map((message) => message.id))
}
