import { spawn } from "node:child_process"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const platform = process.platform === "win32" ? "windows" : process.platform
const suffix = process.arch === "x64" ? "-baseline" : ""
const executable = require.resolve(`@oven/bun-${platform}-${process.arch === "arm64" ? "aarch64" : process.arch}${suffix}/bin/bun${process.platform === "win32" ? ".exe" : ""}`)
const child = spawn(executable, ["test", "--conditions=browser", "--preload", "@opentui/solid/preload", "./test/tui.test.tsx"], { stdio: "inherit" })
child.on("error", (error) => { console.error(error); process.exitCode = 1 })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
