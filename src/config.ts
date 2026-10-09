import { isEncoding, type Encoding, type TokenOptions } from "./tokens.ts"

export const VERSION = "4.0.0"
export const KEY = "opencode_context_manager"
export const AGENT = "context-manager-summarizer"
export const EDIT_AGENT = "context-manager-editor"

export type Settings = {
  autocompaction: { headroom: number; estimateMultiplier: number; lastResortKeepTokens: number }
  ui: { maxLinesPerTurn: number }
  spill: { maxLines: number; maxBytes: number; headShare: number }
  prune: { threshold: number; head: number; tail: number }
  tokenizer: TokenOptions
  summarizer: { providerID?: string; modelID?: string; variant?: string }
}

export function settings(input: unknown = {}): Settings {
  const root = record(input, "options")
  keys(root, ["spill", "prune", "summarizer", "tokenizer", "ui", "autocompaction"])
  const autocompaction = record(root.autocompaction ?? {}, "autocompaction")
  keys(autocompaction, ["headroom", "estimateMultiplier", "lastResortKeepTokens"])
  const ui = record(root.ui ?? {}, "ui")
  keys(ui, ["maxLinesPerTurn"])
  const spill = record(root.spill ?? {}, "spill")
  const prune = record(root.prune ?? {}, "prune")
  const summarizer = record(root.summarizer ?? {}, "summarizer")
  const tokenizer = record(root.tokenizer ?? {}, "tokenizer")
  keys(spill, ["maxLines", "maxBytes", "headShare"])
  keys(prune, ["threshold", "head", "tail"])
  keys(tokenizer, ["fallbackEncoding", "overrides"])
  keys(summarizer, ["providerID", "modelID", "variant"])
  const overrides = record(tokenizer.overrides ?? {}, "tokenizer.overrides")
  for (const [model, encoding] of Object.entries(overrides)) {
    if (!model.includes("/") || !isEncoding(encoding)) throw new Error("Tokenizer overrides must map provider/model to a supported encoding")
  }
  const fallbackEncoding = tokenizer.fallbackEncoding ?? "o200k_base"
  if (!isEncoding(fallbackEncoding)) throw new Error("Unsupported tokenizer.fallbackEncoding")
  const value: Settings = {
    autocompaction: {
      headroom: integer(autocompaction.headroom === undefined ? 20000 : autocompaction.headroom, "autocompaction.headroom", 0),
      estimateMultiplier: autocompaction.estimateMultiplier === undefined ? 1.3 : Number(autocompaction.estimateMultiplier),
      lastResortKeepTokens: integer(autocompaction.lastResortKeepTokens === undefined ? 20000 : autocompaction.lastResortKeepTokens, "autocompaction.lastResortKeepTokens", 0),
    },
    ui: { maxLinesPerTurn: integer(ui.maxLinesPerTurn === undefined ? 4 : ui.maxLinesPerTurn, "ui.maxLinesPerTurn", 3) },
    spill: {
      maxLines: integer(spill.maxLines ?? 2000, "spill.maxLines", 2),
      maxBytes: integer(spill.maxBytes ?? 51200, "spill.maxBytes", 8),
      headShare: Number(spill.headShare ?? 0.5),
    },
    prune: {
      threshold: integer(prune.threshold ?? 5000, "prune.threshold", 1),
      head: integer(prune.head ?? 1000, "prune.head", 0),
      tail: integer(prune.tail ?? 1000, "prune.tail", 0),
    },
    tokenizer: { fallbackEncoding, overrides: { ...overrides } as Record<string, Encoding> },
    summarizer: {
      providerID: optionalString(summarizer.providerID),
      modelID: optionalString(summarizer.modelID),
      variant: optionalString(summarizer.variant),
    },
  }
  if (!Number.isFinite(value.spill.headShare) || value.spill.headShare < 0 || value.spill.headShare > 1)
    throw new Error("spill.headShare must be between 0 and 1")
  if ((autocompaction.estimateMultiplier !== undefined && typeof autocompaction.estimateMultiplier !== "number") || !Number.isFinite(value.autocompaction.estimateMultiplier) || value.autocompaction.estimateMultiplier < 1)
    throw new Error("autocompaction.estimateMultiplier must be a finite number >= 1")
  if (value.prune.head + value.prune.tail >= value.prune.threshold)
    throw new Error("prune.head + prune.tail must be below prune.threshold")
  if (!!value.summarizer.providerID !== !!value.summarizer.modelID)
    throw new Error("Set both summarizer.providerID and summarizer.modelID, or neither")
  return value
}

export function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function integer(value: unknown, name: string, minimum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}`)
  return value
}

function optionalString(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error("Model and variant settings must be nonempty strings")
  return value
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown setting: ${key}`)
}
