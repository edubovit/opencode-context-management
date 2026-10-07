import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client"
import { hash } from "../context.ts"

export type Transcript = readonly SessionMessageInfo[]

export async function history(client: Pick<OpenCodeClient, "message">, sessionID: string, signal?: AbortSignal): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = []
  const cursors = new Set<string>()
  const ids = new Set<string>()
  let cursor: string | undefined
  do {
    signal?.throwIfAborted()
    const page = await client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "asc" }) }, { signal })
    for (const message of page.data) {
      if (ids.has(message.id)) throw new Error("Session history changed during pagination; reload it")
      ids.add(message.id)
      messages.push(message)
    }
    cursor = page.cursor.next ?? undefined
    if (cursor && cursors.has(cursor)) throw new Error("Session history cursor repeated")
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return messages
}

export function fingerprint(messages: Transcript) {
  return hash({ format: "opencode-v2-transcript-1", messages })
}

export function protectedMessages(messages: Transcript): ReadonlySet<string> {
  const boundary = messages.findLastIndex((message) => message.type === "idle")
  const tail = messages.slice(boundary + 1)
  const start = tail.findIndex((message) => message.type === "user")
  return new Set((start < 0 ? tail : tail.slice(start)).map((message) => message.id))
}
