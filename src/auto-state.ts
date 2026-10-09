import type { Model, Session } from "./model.ts"
import type { ModelChoice } from "./controller.ts"
import type { BudgetReading } from "./budget.ts"

export const AUTO_KEY = "opencode_context_autocompaction"
export const STRATEGIES = ["MANUAL", "AUTO_PER_TURN", "AUTO_SESSION"] as const
export type Strategy = typeof STRATEGIES[number]
export type Expected = { revision: number; fingerprint: string }
export type Pause = {
  id: string; userID: string; phase: "manual" | "auto" | "resuming" | "aborting" | "invalid"
  tokens: number; threshold: number; inputLimit: number; derived: boolean; message: string
  protectedIDs?: string[]
  accounting?: BudgetReading
}
export type AutoState = { strategy: Strategy; pause?: Pause }
export type AutoCommand = { action: "strategy"; strategy: Strategy } | { action: "run" | "resume" | "abort"; pauseID: string; model?: ModelChoice }
export type AutoControl = {
  state(sessionID: string): Promise<AutoState>
  command(sessionID: string, command: AutoCommand): Promise<AutoState>
  commit(sessionID: string, metadata: Record<string, unknown>, expected: Expected): Promise<void>
}

export function strategy(session: Pick<Session, "metadata" | "parentID">): Strategy {
  const state = session.metadata?.[AUTO_KEY] as AutoState | undefined
  const selected = state && STRATEGIES.includes(state.strategy) ? state.strategy : "AUTO_PER_TURN"
  return session.parentID && selected === "MANUAL" ? "AUTO_PER_TURN" : selected
}

export function inputBudget(model: Pick<Model, "limit">, headroom: number) {
  const derived = !(model.limit.input && model.limit.input > 0)
  const inputLimit = derived ? model.limit.context - model.limit.output : model.limit.input!
  if (!Number.isFinite(inputLimit) || inputLimit <= 0 || (derived && (!model.limit.context || !model.limit.output)))
    throw new Error("Autocompaction needs a valid model input limit, or context and output limits. Configure the model limits before starting this run.")
  const threshold = inputLimit - headroom
  if (threshold <= 0) throw new Error(`Autocompaction headroom ${headroom} must be smaller than the model input budget ${inputLimit}`)
  return { inputLimit, threshold, derived }
}
