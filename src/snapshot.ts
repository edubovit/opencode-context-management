import { VERSION } from "./config.ts"
import { blockMessages, historyHash, serialize, type Block, type Policy } from "./context.ts"
import { distribution, type lastReportedUsage } from "./metrics.ts"
import { FALLBACK_BASIS, type TokenBasis } from "./tokens.ts"
import type { RuntimeCapture } from "./storage.ts"
export { distribution } from "./metrics.ts"

export function snapshot(sessionID: string, hostVersion: string, blocks: Block[], policy: Policy, runtime?: RuntimeCapture,
  tokenizer: TokenBasis = FALLBACK_BASIS, usage?: ReturnType<typeof lastReportedUsage>) {
  const messages = blockMessages(blocks)
  return {
    schemaVersion: 3, pluginVersion: VERSION, hostVersion, sessionID, created: new Date().toISOString(),
    kind: "current-effective-context", stage: "effective normalized transcript, not canonical hook messages or a provider request",
    historyHash: historyHash(messages), policy, runtime: runtime ?? null, tokenizer, lastReportedUsage: usage ?? null,
    warnings: [
      "Local token estimates are not exact provider request counts or billing. Framing, media and hidden/provider-specific overhead are not counted.",
      ...(tokenizer.source === "fallback" ? ["No verified tokenizer mapping for this model; an explicit fallback encoding is being used."] : []),
      "Not an exact provider request. Later hooks, permission filtering and provider conversion can change context.",
      "Tool inventory is a hook-stage observation, not complete final/MCP schemas. Missing is not zero.",
      runtime ? "Runtime data is the latest observation; config/model/agent changes may make it stale." : "Runtime prompts and tool inventory unavailable: no capture found.",
      ...(runtime?.historyHash !== historyHash(messages) && runtime ? ["History differs from the last runtime capture."] : []),
      ...(runtime?.warnings ?? []),
    ],
    distribution: distribution(blocks, runtime, tokenizer),
    characterDistribution: distribution(blocks, runtime, tokenizer, "characters"),
    blocks: blocks.map(({ previous: _previous, ...visible }) => visible), text: serialize(messages),
  }
}
