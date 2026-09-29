import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Config, Session } from "@opencode-ai/sdk/v2"
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { AGENT, EDIT_AGENT, VERSION, settings } from "./config.ts"
import { blockMessages, historyHash, nativeActive, project, readPolicy, type Envelope } from "./context.ts"
import { Storage, type RuntimeCapture } from "./storage.ts"
import { spills, spillPreview } from "./text.ts"
import { SUMMARIZER_SYSTEM, SUMMARY_EDIT_SYSTEM } from "./summarize.ts"
import { Autocompaction } from "./autocompaction.ts"
import { controlServer } from "./control.ts"
import { legacyHost } from "./legacy-host.ts"

export async function createHooks(ctx: Pick<PluginInput, "client" | "directory">, options: unknown = {}, store = new Storage(ctx.directory)): Promise<Hooks> {
  const config = settings(options)
  const definitions = new Map<string, { id: string; description: string; parameters: unknown }>()
  const captures = new Map<string, RuntimeCapture>()
  const getSession = async (sessionID: string) => {
    const response = await ctx.client.session.get({ path: { id: sessionID }, throwOnError: true })
    return response.data as unknown as Session
  }
  const capture = (sessionID: string) => {
    let value = captures.get(sessionID)
    if (!value) {
      value = { sessionID, time: Date.now(), warnings: ["Tool definitions are project-level observations, not a complete per-request/MCP inventory."] }
      captures.set(sessionID, value)
    }
    return value
  }
  const flush = async (sessionID: string) => {
    const value = capture(sessionID)
    value.time = Date.now()
    await store.saveCapture(structuredClone(value))
  }
  const auto = new Autocompaction(legacyHost(ctx.client), config, store)
  const control = await controlServer(auto)
  try {
    await store.write("runtime.json", { version: VERSION, settings: config, control: control.address })
    await store.cleanupOutputs()
  } catch (error) { control.close(); throw error }

  return {
    event: async ({ event }) => {
      if (event.type === "session.status" && event.properties.status.type === "idle") auto.cancel(event.properties.sessionID)
      if (event.type === "server.instance.disposed" && event.properties.directory === ctx.directory) { auto.close(); control.close() }
    },
    config: async (legacy) => {
      const host = legacy as unknown as Config
      host.compaction = { ...host.compaction, auto: false, prune: false }
      host.tool_output = { max_lines: config.spill.maxLines + 20, max_bytes: config.spill.maxBytes + 4096 }
      host.agent ??= {}
      host.agent[AGENT] = {
        description: "Internal context-manager summarizer", mode: "subagent", hidden: true,
        prompt: SUMMARIZER_SYSTEM, permission: { "*": "deny" },
      }
      host.agent[EDIT_AGENT] = {
        description: "Internal summary editor", mode: "subagent", hidden: true,
        prompt: SUMMARY_EDIT_SYSTEM, permission: { "*": "deny" },
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages as unknown as Envelope[]
      const sessionID = messages[0]?.info.sessionID
      if (!sessionID || [AGENT, EDIT_AGENT].includes(messages.at(-1)?.info.agent ?? "")) return
      if (messages.some((m) => m.info.sessionID !== sessionID)) throw new Error("Mixed-session context is unsupported")
      await auto.beforeRequest(messages)
      const current = await getSession(sessionID)
      const effective = blockMessages(project(nativeActive(messages), readPolicy(current)))
      output.messages.splice(0, output.messages.length, ...effective as unknown as typeof output.messages)
      capture(sessionID).historyHash = historyHash(effective)
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const session = await getSession(input.sessionID)
      if (session.metadata?.context_manager_job) {
        output.system.splice(0, output.system.length, session.metadata.context_manager_edit ? SUMMARY_EDIT_SYSTEM : SUMMARIZER_SYSTEM)
        return
      }
      const value = capture(input.sessionID)
      value.system = [...output.system]
      value.model = { providerID: input.model.providerID, modelID: input.model.id }
      value.tools = [...definitions.values()]
    },
    "chat.params": async (input) => {
      if ([AGENT, EDIT_AGENT, "title", "summary", "compaction"].includes(input.agent)) return
      const value = capture(input.sessionID)
      value.agent = input.agent
      value.variant = (input.message as unknown as { model: { variant?: string } }).model.variant
      try {
        const catalog = await ctx.client.tool.list({ query: { provider: input.model.providerID, model: input.model.id }, throwOnError: true })
        if (!Array.isArray(catalog.data)) throw new Error("Tool catalog unavailable")
        value.tools = catalog.data
        value.warnings = ["Tool schemas are the host's model-filtered default-agent catalog, not this request's exact permission-filtered/MCP inventory."]
      } catch {
        value.tools = [...definitions.values()]
        value.warnings = ["Tool catalog unavailable; definitions are partial hook observations. Non-JSON parameter schemas are marked unavailable."]
      }
      await flush(input.sessionID)
    },
    "tool.definition": async (input, output) => {
      const jsonSchema = (output as unknown as { jsonSchema?: unknown }).jsonSchema
      definitions.set(input.toolID, { id: input.toolID, description: output.description, parameters: schemaView(jsonSchema ?? output.parameters) })
    },
    "experimental.session.compacting": async (input) => {
      if (readPolicy(await getSession(input.sessionID)).cursor > 0)
        throw new Error("Native compaction cannot be mixed with context-manager operations. Use /context-manager or undo its operations first.")
    },
    "tool.execute.after": async (_input, output) => {
      const result = output as unknown as Record<string, unknown>
      if (Array.isArray(result.content)) {
        const content = result.content as Record<string, unknown>[]
        const text = content.map(mcpText).filter((item): item is string => item !== undefined).join("\n\n")
        if (!spills(text, config.spill)) return
        const outputPath = await store.spill(text)
        result.content = [{ type: "text", text: spillPreview(text, config.spill, outputPath) }, ...content.filter((item) => mcpText(item) === undefined)]
        result.metadata = { ...(result.metadata && typeof result.metadata === "object" ? result.metadata : {}), outputPath }
        return
      }
      if (typeof result.output !== "string") return
      const metadata = result.metadata && typeof result.metadata === "object" ? result.metadata as Record<string, unknown> : {}
      let full = result.output
      let outputPath = typeof metadata.outputPath === "string" ? metadata.outputPath : undefined
      if (metadata.truncated && outputPath) {
        const allowed = path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "opencode", "tool-output")
        try {
          const resolved = await realpath(outputPath)
          if (path.dirname(resolved) !== await realpath(allowed))
            throw new Error("Tool spill is outside OpenCode's tool-output directory")
          full = await readFile(resolved, "utf8")
        } catch (error) {
          result.output += `\n[Context manager: unable to rebuild head/tail preview: ${error instanceof Error ? error.message : String(error)}]`
          return
        }
      }
      if (!spills(full, config.spill)) return
      outputPath ??= await store.spill(full)
      result.output = spillPreview(full, config.spill, outputPath)
      result.metadata = { ...metadata, truncated: true, outputPath }
    },
  }
}

function mcpText(item: Record<string, unknown>): string | undefined {
  if (item.type === "text" && typeof item.text === "string") return item.text
  if (item.type === "resource" && item.resource && typeof item.resource === "object") {
    const resource = item.resource as Record<string, unknown>
    if (typeof resource.text === "string") return `[Resource ${resource.uri ?? ""}]\n${resource.text}`
  }
  return undefined
}

function schemaView(value: unknown): unknown {
  if (value && typeof value === "object" && ("ast" in value || "_zod" in value || "_def" in value))
    return { unavailable: "Framework schema; obtain JSON Schema from the host tool catalog" }
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "function" ? "[function unavailable]" : item))
  } catch { return { unavailable: "Runtime parameter schema is not JSON serializable" } }
}

const server: Plugin = (ctx, options) => createHooks(ctx, options)
export default { id: "context-manager", server }
