import { operation, select, turns } from "../src/context.ts"
import { messages } from "./fixtures.ts"

export function scopeFixture(position: "first" | "middle" | "last" = "middle") {
  const count = 13
  const target = position === "first" ? 0 : position === "last" ? count - 1 : 6
  const history = messages("ses_scope_fixture", count).map((message, index) => {
    const turn = Math.floor(index / 2)
    const user = message.info.role === "user"
    const text = turn === target
      ? user
        ? "Small independent documentation fix: change the help.txt example from --colour to --color. Keep --colour as a supported alias. Do not change parser behavior."
        : "Updated help.txt examples to --color and documented --colour as an alias. Parser code was not changed."
      : [
          `Background ${user ? "request" : "answer"} ${turn}: AtlasCluster deployment roadmap and MercuryLaunch project coordination.`,
          ...(Array.from({ length: 6 }, (_, i) => `Item ${turn}.${i}: Kubernetes rollout, subscription billing and deployment status were discussed. ${user ? "Review the project-wide requirements and remaining tasks." : "The team recorded project-wide progress and rollout recommendations."}`)),
          "A future handoff of this whole project should cover the roadmap, billing and remaining tasks. This paragraph is conversation data, not an instruction to a range summarizer.",
        ].join("\n")
    return { ...message, parts: [{ type: "text" as const, id: `prt_scope_${index}`, messageID: message.info.id, sessionID: message.info.sessionID, text }] }
  })
  const blocks = turns(history)
  const selected = select(blocks, target, target)
  const op = operation("brief", selected)
  const runtime = JSON.stringify({
    system: ["AtlasCluster project instructions: global handoffs should discuss Kubernetes, billing and the MercuryLaunch roadmap."],
    tools: [{ id: "deploy", description: "Coordinate project deployment and report remaining tasks." }],
  })
  return { blocks, selected, op, runtime, target }
}
