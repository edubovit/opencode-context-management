import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { hash } from "./context.ts"

export type RuntimeCapture = {
  time: number
  sessionID: string
  model?: { providerID: string; modelID: string }
  variant?: string
  agent?: string
  historyHash?: string
  system?: string[]
  tools?: { id: string; description: string; parameters: unknown }[]
  warnings: string[]
}

export type Artifacts = Pick<Storage, "capture" | "write">

export class Storage {
  readonly root: string
  constructor(directory: string, base = path.join(homedir(), ".local", "state", "opencode-context-manager")) {
    this.root = path.join(base, hash(path.resolve(directory)).slice(0, 24))
  }
  async write(name: string, data: unknown) {
    await mkdir(this.root, { recursive: true })
    const target = path.join(this.root, name)
    const tmp = `${target}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, target)
    return target
  }
  async read<T>(name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(path.join(this.root, name), "utf8")) as T }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }
  capture(sessionID: string) { return this.read<RuntimeCapture>(`capture-${hash(sessionID)}.json`) }
  saveCapture(value: RuntimeCapture) { return this.write(`capture-${hash(value.sessionID)}.json`, value) }
  async spill(text: string) {
    await mkdir(this.root, { recursive: true })
    const target = path.join(this.root, `output-${randomUUID()}.txt`)
    await writeFile(target, text, { mode: 0o600 })
    return target
  }
  async cleanupOutputs() {
    await mkdir(this.root, { recursive: true })
    for (const name of await readdir(this.root)) {
      if (!/^output-[\da-f-]+\.txt$/.test(name)) continue
      const file = path.join(this.root, name)
      if ((await stat(file)).mtimeMs < Date.now() - 7 * 86400000) await unlink(file)
    }
  }
}
