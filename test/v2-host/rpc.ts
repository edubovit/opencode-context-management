import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

const sessionID = z.string().startsWith("ses_")
export const plan = z.object({
  pause: z.boolean(),
  sourceIDs: z.array(z.string()).default([]),
  modes: z.object({ reasoning: z.boolean(), tools: z.enum(["large", "all", "delete"]).optional() }).optional(),
  sourceHash: z.string().optional(),
}).strict()

export const fixtureRpc = Rpc.define({
  id: "context-manager-v2-fixture",
  methods: {
    status: { input: z.object({ sessionID }).strict(), output: z.unknown() },
    arm: { input: z.object({ sessionID, plan }).strict(), output: z.null() },
    resume: { input: z.object({ sessionID, pauseID: z.string() }).strict(), output: z.null(), errors: { stale: z.object({}) } },
    inspect: { input: z.object({ sessionID }).strict(), output: z.unknown() },
    tui: { input: z.object({ phase: z.enum(["ready", "command", "cleanup"]) }).strict(), output: z.null() },
  },
  events: { paused: { schema: z.object({ sessionID, pauseID: z.string() }) } },
})
