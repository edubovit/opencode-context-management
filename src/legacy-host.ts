import type { OpencodeClient as LegacyClient } from "@opencode-ai/sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { sdkHost } from "./sdk-host.ts"

export function legacyHost(client: LegacyClient) {
  const bridge = {
    session: {
      get: ({ sessionID }: { sessionID: string }) => client.session.get({ path: { id: sessionID }, throwOnError: true }),
      messages: ({ sessionID }: { sessionID: string }) => client.session.messages({ path: { id: sessionID }, query: { limit: 0 }, throwOnError: true }),
      status: () => client.session.status({ throwOnError: true }),
      update: ({ sessionID, ...body }: Record<string, unknown>) => client.session.update({ path: { id: String(sessionID) }, body, throwOnError: true } as Parameters<LegacyClient["session"]["update"]>[0]),
      create: (body: Record<string, unknown>) => client.session.create({ body, throwOnError: true } as Parameters<LegacyClient["session"]["create"]>[0]),
      prompt: ({ sessionID, ...body }: Record<string, unknown>) => client.session.prompt({ path: { id: String(sessionID) }, body, throwOnError: true } as Parameters<LegacyClient["session"]["prompt"]>[0]),
      abort: ({ sessionID }: { sessionID: string }) => client.session.abort({ path: { id: sessionID }, throwOnError: true }),
      delete: ({ sessionID }: { sessionID: string }) => client.session.delete({ path: { id: sessionID }, throwOnError: true }),
    },
    provider: { list: () => client.provider.list({ throwOnError: true }) },
    config: { get: () => client.config.get({ throwOnError: true }) },
  }
  return sdkHost(bridge as unknown as OpencodeClient)
}
