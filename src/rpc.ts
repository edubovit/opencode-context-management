import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import type { Envelope, Policy } from "./context.ts"
import type { AutoState } from "./auto-state.ts"
import type { Settings } from "./config.ts"
import type { Model, Session } from "./model.ts"
import type { RuntimeCapture } from "./storage.ts"

const id = z.string().startsWith("ses_")
const session = z.object({ sessionID: id }).strict()
const job = z.object({ sessionID: id, jobID: id }).strict()
const model = z.object({ providerID: z.string().min(1), modelID: z.string().min(1), variant: z.string().min(1).optional() }).strict()
const errors = { rejected: z.null() }
export type Inspection = { version: string; settings: Settings; session: Session; messages: Envelope[]; models: Model[]; runtime?: RuntimeCapture; auto: AutoState }

export const ContextManager = Rpc.define({
  id: "context-manager",
  methods: {
    inspect: { input: session, output: z.custom<Inspection>(), errors },
    idle: { input: session, output: z.boolean(), errors },
    state: { input: session, output: z.custom<AutoState>(), errors },
    commit: { input: session.extend({ policy: z.custom<Policy>(), expected: z.object({ revision: z.number().int().nonnegative(), fingerprint: z.string().min(1) }).strict() }).strict(), output: z.null(), errors },
    command: { input: session.extend({ command: z.discriminatedUnion("action", [
      z.object({ action: z.literal("strategy"), strategy: z.enum(["MANUAL", "AUTO_PER_TURN", "AUTO_SESSION"]) }).strict(),
      z.object({ action: z.literal("run"), pauseID: z.string().min(1), model: model.optional() }).strict(),
      z.object({ action: z.literal("resume"), pauseID: z.string().min(1) }).strict(),
      z.object({ action: z.literal("abort"), pauseID: z.string().min(1) }).strict(),
    ]) }).strict(), output: z.custom<AutoState>(), errors },
    createJob: { input: session.extend({ purpose: z.enum(["summary", "edit"]) }).strict(), output: id, errors },
    jobHistory: { input: job, output: z.custom<Envelope[]>(), errors },
    generate: { input: job.extend({ model, text: z.string().min(1), purpose: z.enum(["summary", "edit"]) }).strict(), output: z.string(), errors },
    abortJob: { input: job, output: z.null(), errors },
    removeJob: { input: job, output: z.null(), errors },
    dump: { input: session, output: z.string(), errors },
  },
  events: { changed: { schema: z.object({ sessionID: id }) } },
})

export function errorMessage(error: unknown) {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : String(error)
}
