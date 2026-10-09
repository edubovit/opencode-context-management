import { spawn } from "@lydell/node-pty"
import headless from "@xterm/headless"
import { writeFile } from "node:fs/promises"

export function terminal(input: { executable: string; url: string; sessionID: string; project: string; env: NodeJS.ProcessEnv; output: string }) {
  const screen = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 0 })
  const child = spawn(input.executable, ["--server", input.url, "--session", input.sessionID, input.project], {
    cols: 80, rows: 24, cwd: input.project, env: input.env, name: "xterm-256color",
  })
  let log = ""
  let ended = false
  let pending = Promise.resolve()
  const exited = new Promise<number>((resolve) => child.onExit(({ exitCode }) => { ended = true; resolve(exitCode) }))
  screen.onData((data) => { if (!ended) child.write(data) })
  child.onData((data) => {
    log += data
    pending = pending.then(() => new Promise<void>((resolve) => screen.write(data, resolve)))
  })
  const text = async () => {
    await pending
    const buffer = screen.buffer.active
    return Array.from({ length: screen.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n")
  }
  return {
    text,
    keys: (keys: string) => { if (ended) throw new Error("Owned TUI exited before input"); child.write(keys) },
    resize: (cols: number, rows: number) => { screen.resize(cols, rows); child.resize(cols, rows) },
    close: async () => {
      if (!ended) child.write("\x03\x03")
      const timer = setTimeout(() => { if (!ended) child.kill() }, 8000)
      try {
        const code = await exited
        await pending
        await writeFile(input.output, log)
        await writeFile(input.output + ".screen.txt", await text())
        return code
      } finally {
        clearTimeout(timer)
        screen.dispose()
        if (process.platform === "win32") child.kill()
      }
    },
  }
}
