import type { TestContext } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Controller } from "../src/controller.ts"
import { settings } from "../src/config.ts"
import { Storage } from "../src/storage.ts"
import { fixtureHost, messages } from "./fixtures.ts"

export async function setupController(t: Pick<TestContext, "after">, count = 3) {
  const dir = await mkdtemp(path.join(tmpdir(), "cm-controller-"))
  const { host, data } = fixtureHost()
  data.messages = messages(data.session.id, count)
  const storage = new Storage(dir, dir)
  const controller = new Controller(host, data.session.id, settings(), storage)
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { host, data, storage, controller, ids: data.messages.slice(0, 2).map(message => message.info.id) }
}
