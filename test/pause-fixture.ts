import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const server: Plugin = async (_ctx, options) => {
  const root = String(options?.root)
  const seen = new Set<string>()
  const active = new Map<string, { aborted: boolean }>()
  return {
    event: async ({ event }) => {
      if (event.type === "session.status" && event.properties.status.type === "idle") {
        const gate = active.get(event.properties.sessionID)
        if (gate) gate.aborted = true
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const user = output.messages.findLastIndex((message) => message.info.role === "user")
      const first = output.messages[user]
      if (!first || seen.has(first.info.id) || !first.parts.some((part) => part.type === "text" && part.text.includes("PAUSE_PROBE")) ||
          !output.messages.slice(user).some((message) => message.parts.some((part) => part.type === "tool" && part.state.status === "completed"))) return
      seen.add(first.info.id)
      const gate = { aborted: false }
      active.set(first.info.sessionID, gate)
      const file = path.join(root, `pause-${first.info.id}.json`)
      await writeFile(file, JSON.stringify({ status: "paused", userID: first.info.id }))
      try {
        const deadline = Date.now() + 45000
        while (Date.now() < deadline) {
          if (gate.aborted) throw new Error("Pause probe aborted")
          const command = JSON.parse(await readFile(file, "utf8"))
          if (command.action === "resume") return
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        throw new Error("Pause probe timed out")
      } finally {
        active.delete(first.info.sessionID)
        await writeFile(file, JSON.stringify({ status: gate.aborted ? "aborted" : "resumed", userID: first.info.id }))
      }
    },
  }
}

export default { id: "context-manager-pause-fixture", server }
