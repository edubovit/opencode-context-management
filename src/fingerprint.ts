import { createHash } from "node:crypto"
import type { Envelope } from "./model.ts"

export function sameIDs(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export function hash(value: unknown) {
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
  return createHash("sha256").update(canonical ?? "null").digest("hex")
}

export function historyHash(messages: Envelope[]) {
  return hash(messages.map(({ info, parts }) => ({
    id: info.id, role: info.role,
    parts: parts.map((part) => part.type === "tool" ? { ...part, nativeVersion: 2 } : part),
    ...(info.sourceHash ? { sourceHash: info.sourceHash } : {}),
  })))
}
