import assert from "node:assert/strict"
import { fixture } from "./host-fixture.ts"
import { remoteHost } from "../src/control.ts"
import { Controller } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { hash } from "../src/context.ts"

const test = await fixture(process.argv[2])
let passed = false
const checks: string[] = []
try {
  for (const background of [false, true]) {
    const source = await test.client.session.create({ location: { directory: test.project }, model: { providerID: "fixture", id: "fixture" } })
    await test.client.session.remove({ sessionID: source.id })
    const messages = [
      { id: `msg_shell_${background}`, type: "shell", shellID: `sh_fixture_${background}`, command: "echo SHELL_INPUT_MARKER", status: "exited", time: { created: 1, completed: 2 }, metadata: { background }, output: { output: "SHELL_OUTPUT_MARKER", cursor: 0, size: 19, truncated: false } },
      ...(background ? [{ id: "msg_completion", type: "synthetic", text: "Completed shell: SHELL_OUTPUT_MARKER", time: { created: 3 } }] : []),
    ]
    const session = await test.client.session.import({ info: source, messages: JSON.parse(JSON.stringify(messages)), location: { directory: test.project } })
    const remote = remoteHost(test.client, session.id)
    const inspected = await remote.load()
    const controller = new Controller(remote.host, session.id, settings(inspected.settings), remote.artifacts)
    const before = await test.client.session.context({ sessionID: session.id })
    const ids = (await controller.load()).blocks[0].sourceIDs
    const draft = await controller.summarize("brief", ids)
    await controller.apply(draft, "SHELL_SUMMARY_MARKER")
    const send = async () => {
      await test.client.session.prompt({ sessionID: session.id, text: "Continue after context edit" })
      await test.client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(45000) })
      assert.equal((await test.client.session.get({ sessionID: session.id })).outcome, "succeeded")
      return JSON.stringify(test.requests.at(-1))
    }
    const compacted = await send()
    assert.ok(compacted.includes("SHELL_SUMMARY_MARKER") && !compacted.includes("SHELL_OUTPUT_MARKER"))
    await controller.applyRestore(await controller.prepareRestore("expand", ids))
    const restored = await send()
    assert.ok(!restored.includes("SHELL_SUMMARY_MARKER") && restored.includes("SHELL_OUTPUT_MARKER"))
    assert.equal(restored.includes("SHELL_INPUT_MARKER"), !background)
    assert.equal(hash((await test.client.session.context({ sessionID: session.id })).slice(0, before.length)), hash(before))
    await remote.close()
    checks.push(`shell-led summary, next request and restoration; background=${background}`)
  }
  passed = true
} finally {
  await test.close({ passed, checks })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
