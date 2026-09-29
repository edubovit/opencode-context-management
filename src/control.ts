import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import type { AutoCommand, AutoControl, ControlAddress, Expected } from "./auto-state.ts"

export async function controlServer(control: AutoControl) {
  const token = randomBytes(32).toString("hex")
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)) }
    if (req.method !== "POST" || req.url !== "/" || req.headers.authorization !== `Bearer ${token}`) { reply(403, { error: "Forbidden" }); return }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { action: string; sessionID: string; command?: AutoCommand; metadata?: Record<string, unknown>; expected?: Expected }
      if (typeof input.sessionID !== "string" || !input.sessionID) throw new Error("Missing session ID")
      if (input.action === "state") reply(200, await control.state(input.sessionID))
      else if (input.action === "command" && input.command) reply(200, await control.command(input.sessionID, input.command))
      else if (input.action === "commit" && input.metadata && input.expected) { await control.commit(input.sessionID, input.metadata, input.expected); reply(200, {}) }
      else throw new Error("Invalid control action")
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : String(error) }) }
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  server.unref()
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Control server address unavailable")
  return { address: { url: `http://127.0.0.1:${address.port}/`, token }, close: () => { server.closeAllConnections(); server.close() } }
}

export function controlClient(address: ControlAddress): AutoControl {
  const url = new URL(address.url)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Context control must use local loopback")
  const call = async (input: unknown) => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${address.token}`, "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(30000) })
    const result = await response.json() as { error?: string }
    if (!response.ok) throw new Error(result.error ?? "Context control request failed")
    return result
  }
  return {
    state: async (sessionID) => await call({ action: "state", sessionID }) as Awaited<ReturnType<AutoControl["state"]>>,
    command: async (sessionID, command) => await call({ action: "command", sessionID, command }) as Awaited<ReturnType<AutoControl["state"]>>,
    commit: async (sessionID, metadata, expected) => { await call({ action: "commit", sessionID, metadata, expected }) },
  }
}
