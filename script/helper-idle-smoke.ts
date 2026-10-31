import assert from "node:assert/strict"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { fixture } from "./host-fixture.ts"
import { remoteHost } from "../src/control.ts"
import { hash } from "../src/fingerprint.ts"

const test = await fixture(process.argv[2], process.argv[3])
const checks: string[] = []
let passed = false
try {
  test.config.plugins.push(path.join(test.repo, "test/idle-fixture"))
  await writeFile(test.configPath, JSON.stringify(test.config))
  await test.restart()
  const parent = await test.client.session.create({ location: { directory: test.project }, model: { providerID: "fixture", id: "fixture" } })
  const remote = remoteHost(test.client, parent.id)
  await remote.load()
  const parentBefore = hash((await test.client.session.get({ sessionID: parent.id })).metadata)
  for (const purpose of ["summary", "edit"] as const) {
    const job = await remote.host.createJob(purpose, parent.id, "manual")
    const session = await test.client.session.get({ sessionID: job })
    await test.client.session.update({ sessionID: job, metadata: { ...session.metadata, fixture_idle_input: true } })
    const before = test.requests.length
    await assert.rejects(remote.host.generate(job, { providerID: "fixture", modelID: "fixture" }, "Produce only the requested replacement", purpose), /another input/)
    assert.equal(test.requests.length, before + 2)
    const history = await test.client.session.context({ sessionID: job })
    assert.equal(history.filter(message => message.type === "synthetic" && message.text === "UNRELATED_IDLE_HOOK_INPUT").length, 1)
    assert.equal(history.filter(message => message.type === "assistant" && message.finish === "stop").length, 2)
    assert.ok(await remote.host.generate(job, { providerID: "fixture", modelID: "fixture" }, "Fresh independent request", purpose))
    await remote.host.remove(job)
    assert.equal(hash((await test.client.session.get({ sessionID: parent.id })).metadata), parentBefore)
    checks.push(`${purpose} rejects a successful idle-hook follow-up, accepts a fresh prompt and leaves parent unchanged`)
  }
  await remote.close()
  passed = true
} finally {
  await test.close({ passed, checks })
  console.log(JSON.stringify({ root: test.root, passed, checks: checks.length }))
}
