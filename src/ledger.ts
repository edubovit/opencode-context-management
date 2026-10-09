import { z } from "zod"
import { KEY } from "./config.ts"
import type { Session } from "./model.ts"
import { TOKENIZER_ID } from "./tokens.ts"

export const POLICY_VERSION = 10
export type Mode = "tool-prune" | "tool-prune-all" | "tool-delete" | "prune-reason" | "compact" | "brief"
export type RestoreMode = "expand"

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const encoding = z.enum(["o200k_base", "cl100k_base"])
const tokenizer = z.object({
  encoding, library: z.literal(TOKENIZER_ID), source: z.enum(["model-name mapping", "configured override", "fallback"]),
  providerID: z.string().optional(), modelID: z.string().optional(), apiModelID: z.string().optional(),
}).strict()
const rule = z.object({
  unit: z.literal("tokens"), encoding, library: z.literal(TOKENIZER_ID), threshold: count.positive(), head: count, tail: count,
}).strict().refine((value) => value.head + value.tail < value.threshold, "Invalid saved pruning budget")
const ids = z.array(z.string().min(1)).nonempty().refine((value) => new Set(value).size === value.length, "Duplicate source identity")
const pruneTargets = z.array(z.object({ operationID: z.string().min(1), sourceIDs: ids }).strict()).nonempty()
  .refine((targets) => {
    const sources = targets.flatMap((target) => target.sourceIDs)
    return new Set(sources).size === sources.length
  }, "Overlapping pruning restoration targets")
const operation = z.object({
  id: z.string().min(1), mode: z.enum(["tool-prune", "tool-prune-all", "tool-delete", "prune-reason", "compact", "brief", "expand", "revise"]),
  sourceIDs: ids, beforeHash: z.string().min(1), beforeChars: count, beforeTokens: count, tokenizer, created: count,
  summary: z.string().refine((text) => text.trim().length > 0, "Empty summary").optional(), rule: rule.optional(), summaryIDs: ids.optional(), targetID: z.string().min(1).optional(),
  pruneReason: z.literal(true).optional(), checkpoint: z.literal(true).optional(), pruneTargets: pruneTargets.optional(),
}).strict().superRefine((op, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message })
  if (op.mode === "tool-prune" && !op.rule) reject("Missing saved token pruning rule")
  if (op.rule && op.mode !== "tool-prune") reject("Only large-output pruning accepts a rule")
  if (op.pruneReason && !["tool-prune", "tool-prune-all", "tool-delete"].includes(op.mode)) reject("Invalid reasoning pruning combination")
  if (op.mode === "tool-delete" && !op.pruneReason) reject("Deleting tools requires pruning reasoning")
  if (["compact", "brief", "revise"].includes(op.mode) && !op.summary) reject("Missing saved summary")
  if (op.mode === "revise" && !op.targetID) reject("Missing summary revision target")
  if (op.mode === "expand" && !op.summaryIDs && !op.pruneTargets) reject("Missing restoration targets")
  if (op.pruneTargets && op.mode !== "expand") reject("Pruning restoration targets require expansion")
  if (op.pruneTargets?.some((target) => target.sourceIDs.some((id) => !op.sourceIDs.includes(id)))) reject("Pruning restoration target is outside the selected range")
  if (op.checkpoint && op.mode !== "compact") reject("Invalid last-resort checkpoint")
})

export type Operation = z.infer<typeof operation>
export const policySchema = z.object({
  version: z.literal(POLICY_VERSION), sessionID: z.string().min(1), revision: count, operations: z.array(operation),
}).strict().superRefine((policy, ctx) => {
  if (policy.revision !== policy.operations.length || new Set(policy.operations.map((op) => op.id)).size !== policy.operations.length)
    ctx.addIssue({ code: "custom", message: "Invalid operation identity or revision" })
})
export type Policy = z.infer<typeof policySchema>

export function emptyPolicy(sessionID: string): Policy {
  return { version: POLICY_VERSION, sessionID, revision: 0, operations: [] }
}

export function readPolicy(session: Pick<Session, "id" | "metadata">): Policy {
  const value = session.metadata?.[KEY]
  if (value === undefined) return emptyPolicy(session.id)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context-manager state")
  if (!("sessionID" in value) || value.sessionID !== session.id)
    throw new Error("Context-manager ledger belongs to another session or has no owner; original data is preserved")
  if (!("version" in value) || ![7, 8, 9, POLICY_VERSION].includes(Number(value.version)) || typeof value.version !== "number")
    throw new Error("Unsupported context-manager ledger; only V2 formats 7–10 are supported. Original data is preserved.")
  if (value.version === POLICY_VERSION) return policySchema.parse(value)
  const saved = z.object({ version: z.union([z.literal(7), z.literal(8), z.literal(9)]), sessionID: z.string(), revision: count, cursor: count.optional(), operations: z.array(operation) }).strict().parse(value)
  if ((saved.version < 9 ? saved.cursor !== saved.operations.length : saved.cursor !== undefined) || (saved.version === 7 && saved.operations.some((op) => op.checkpoint)))
    throw new Error("Invalid saved V2 ledger cursor or checkpoint; original data is preserved")
  if (saved.operations.some((op) => op.pruneTargets)) throw new Error("Pruning restoration requires ledger format 10; original data is preserved")
  return policySchema.parse({ version: POLICY_VERSION, sessionID: saved.sessionID, revision: saved.revision, operations: saved.operations })
}

export function append(policy: Policy, op: Operation): Policy {
  return { ...policy, revision: policy.revision + 1, operations: [...policy.operations, op] }
}
