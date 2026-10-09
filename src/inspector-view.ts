import { inputBudget, type AutoState } from "./auto-state.ts"
import type { Loaded } from "./controller.ts"
import type { distribution } from "./metrics.ts"

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

export function compactCount(value: number) { return compact.format(value).replace("K", "k") }

export function meter(value: number, limit: number, width: number) {
  const filled = Math.max(0, Math.min(width, Math.round(value / limit * width)))
  return "━".repeat(filled) + "─".repeat(width - filled)
}

export function budgetView(loaded: Pick<Loaded, "session" | "models" | "runtime"> | undefined, auto: AutoState, headroom: number) {
  const pause = auto.pause
  const reading = pause ? pause.accounting : loaded?.runtime?.budget
  const label = pause ? "Live guard" : "Last request guard"
  const tokens = pause?.tokens ?? reading?.tokens
  const source = !reading ? pause ? "Local estimate" : "No request estimate yet"
    : reading.source === "provider-matched" ? "Provider-based estimate"
    : reading.source === "provider-unpaired" ? "Unpaired estimate"
    : `Local estimate ×${reading.multiplier}`
  if (pause) return { label, tokens, threshold: pause.threshold, source }
  if (!reading) return { label, tokens, source }
  const captured = loaded?.runtime
  const current = loaded?.session.model
  if (!captured?.model || !current || captured.model.providerID !== current.providerID || captured.model.modelID !== current.id ||
      (captured.variant ?? "default") !== (current.variant ?? "default"))
    return { label, tokens, source, note: "Model changed; previous request" }
  const model = loaded?.models.find((model) => model.providerID === current.providerID && model.id === current.id)
  if (!model) return { label, tokens, source, note: "Model limits unavailable" }
  try { return { label, tokens, threshold: inputBudget(model, headroom).threshold, source } }
  catch { return { label, tokens, source, note: "Invalid model limits or headroom" } }
}

export function breakdown(data: ReturnType<typeof distribution>) {
  const names: Record<string, string> = {
    user: "Prompts", assistant: "Replies", summaries: "Summaries", reasoning: "Reasoning", toolInputs: "Tool inputs",
    toolOutputs: "Tool results", loadedSkills: "Skills", systemPrompts: "System", advertisedSkills: "Skill list", capturedToolDefinitions: "Tool schemas",
  }
  const rows = Object.entries(data.counts).filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ label: names[key], value }))
  return rows.length <= 4 ? rows : [...rows.slice(0, 3), { label: "Other", value: rows.slice(3).reduce((sum, row) => sum + row.value, 0) }]
}
