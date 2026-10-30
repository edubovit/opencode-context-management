import type { Envelope, Model, ModelChoice, Session } from "./model.ts"
import type { AutoControl, Expected } from "./auto-state.ts"
import type { SummaryProgress } from "./summary-progress.ts"

export type HelperPurpose = "summary" | "edit"
export type HelperTrigger = "manual" | "auto"

export interface Host {
  readonly readOnly?: boolean
  auto?: AutoControl
  session(id: string): Promise<Session>
  messages(id: string): Promise<Envelope[]>
  progress?(id: string): Promise<SummaryProgress>
  idle(id: string): Promise<boolean>
  update(id: string, metadata: Record<string, unknown>, expected?: Expected): Promise<void>
  models(): Promise<Model[]>
  configured(): Promise<boolean>
  createJob(purpose?: HelperPurpose, ownerID?: string, trigger?: HelperTrigger): Promise<string>
  generate(id: string, model: ModelChoice, text: string, purpose?: HelperPurpose): Promise<string>
  abort(id: string): Promise<void>
  remove(id: string): Promise<void>
}
