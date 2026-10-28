import { z } from "zod"
import { ENCODINGS } from "./tokens.ts"

export const VERSION = "4.5.1"
export const KEY = "opencode_context_manager"
export const AGENT = "context-manager-summarizer"
export const EDIT_AGENT = "context-manager-editor"

const integer = (minimum: number) => z.number().int({ error: "must be a safe integer" }).min(minimum)
const name = z.string().refine(value => value.trim().length > 0, "must be a nonempty string")
const schema = z.strictObject({
  autocompaction: z.strictObject({
    headroom: integer(0).default(20000),
    estimateMultiplier: z.number().min(1).default(1.3),
    lastResortKeepTokens: integer(0).default(20000),
  }).prefault({}),
  ui: z.strictObject({ maxLinesPerTurn: integer(3).default(4) }).prefault({}),
  spill: z.strictObject({
    maxLines: integer(2).default(2000),
    maxBytes: integer(8).default(51200),
    headShare: z.number().min(0).max(1).default(0.5),
  }).prefault({}),
  prune: z.strictObject({
    threshold: integer(1).default(3000),
    head: integer(0).default(1000),
    tail: integer(0).default(500),
  }).prefault({}).refine(value => value.head + value.tail < value.threshold, "head + tail must be below threshold"),
  tokenizer: z.strictObject({
    fallbackEncoding: z.enum(ENCODINGS).default("o200k_base"),
    overrides: z.record(z.string().includes("/"), z.enum(ENCODINGS)).default(() => ({})),
  }).prefault({}),
  summarizer: z.strictObject({
    providerID: name.optional(), modelID: name.optional(), variant: name.optional(),
  }).prefault({}).refine(value => !!value.providerID === !!value.modelID, "Set both summarizer.providerID and summarizer.modelID, or neither"),
}).prefault({})

export type Settings = z.infer<typeof schema>

export function settings(input?: unknown): Settings {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new Error(result.error.issues.map(issue => issue.code === "unrecognized_keys"
    ? `Unknown setting: ${issue.keys.join(", ")}`
    : `${issue.path.join(".") || "options"}: ${issue.message}`).join("; "))
}
