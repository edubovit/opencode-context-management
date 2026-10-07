import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import type { Model } from "./model.ts"

export const TOKENIZER_ID = "gpt-tokenizer@4.0.0" as const
export type Encoding = "o200k_base" | "cl100k_base"
export type TokenBasis = {
  encoding: Encoding
  library: typeof TOKENIZER_ID
  source: "model-name mapping" | "configured override" | "fallback"
  providerID?: string
  modelID?: string
  apiModelID?: string
}
export type TokenOptions = { fallbackEncoding: Encoding; overrides: Record<string, Encoding> }
export const FALLBACK_BASIS: TokenBasis = { encoding: "o200k_base", library: TOKENIZER_ID, source: "fallback" }

type Codec = Pick<typeof import("gpt-tokenizer/encoding/o200k_base"), "encode" | "decode" | "countTokens" | "setMergeCacheSize">
const require = createRequire(import.meta.url)
const codecs = new Map<Encoding, Codec>()
const counts = new Map<string, number>()
const ordinary = { allowedSpecial: new Set<string>(), disallowedSpecial: new Set<string>() }

export function isEncoding(value: unknown): value is Encoding {
  return value === "o200k_base" || value === "cl100k_base"
}

function codec(encoding: Encoding) {
  if (!isEncoding(encoding)) throw new Error(`Unsupported tokenizer encoding: ${encoding}`)
  let value = codecs.get(encoding)
  if (!value) {
    value = require(`gpt-tokenizer/encoding/${encoding}`) as Codec
    value.setMergeCacheSize(4096)
    codecs.set(encoding, value)
  }
  return value
}

export function tokenCount(text: string, encoding: Encoding = "o200k_base") {
  if (!text) return 0
  const key = `${encoding}:${createHash("sha256").update(text).digest("hex")}`
  const cached = counts.get(key)
  if (cached !== undefined) return cached
  const count = codec(encoding).countTokens(text, ordinary)
  if (counts.size >= 2048) counts.delete(counts.keys().next().value!)
  counts.set(key, count)
  return count
}

export function tokenEdges(text: string, head: number, tail: number, encoding: Encoding) {
  const tokenizer = codec(encoding)
  const encoded = tokenizer.encode(text, ordinary)
  let end = head ? Math.min(text.length, tokenizer.decode(encoded.slice(0, head)).length) : 0
  let start = tail ? Math.max(0, text.length - tokenizer.decode(encoded.slice(-tail)).length) : text.length
  const splitSurrogate = (index: number) => index > 0 && index < text.length &&
    text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff &&
    text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff
  if (splitSurrogate(end)) end--
  if (splitSurrogate(start)) start++
  while (end > 0 && tokenCount(text.slice(0, end), encoding) > head) {
    end--
    if (splitSurrogate(end)) end--
  }
  while (start < text.length && tokenCount(text.slice(start), encoding) > tail) {
    start += text.codePointAt(start)! > 0xffff ? 2 : 1
  }
  return { head: text.slice(0, end), tail: text.slice(start), separated: end < start }
}

export function tokenBasis(choice: { providerID: string; modelID: string } | undefined, model: Model | undefined, options: TokenOptions): TokenBasis {
  const identity = choice ? { providerID: choice.providerID, modelID: choice.modelID, apiModelID: model?.api.id ?? choice.modelID } : {}
  const override = choice && options.overrides[`${choice.providerID}/${choice.modelID}`]
  if (override) return { ...identity, encoding: override, library: TOKENIZER_ID, source: "configured override" }
  const id = model?.api.id ?? choice?.modelID ?? ""
  const openai = choice?.providerID === "openai" || choice?.providerID === "azure" || choice?.providerID.includes("github-copilot") || model?.api.npm === "@ai-sdk/azure" || model?.api.npm === "@opencode/ai/providers/azure"
  if (openai && /^(gpt-5(?:[.-]|$)|gpt-4o(?:-|$)|chatgpt-4o-|gpt-4\.[15](?:-|$)|o[13](?:-|$)|o4-mini(?:-|$))/.test(id))
    return { ...identity, encoding: "o200k_base", library: TOKENIZER_ID, source: "model-name mapping" }
  if (openai && /^(gpt-4(?:-|$)|gpt-3\.5(?:-|$)|gpt-35-turbo(?:-|$))/.test(id))
    return { ...identity, encoding: "cl100k_base", library: TOKENIZER_ID, source: "model-name mapping" }
  return { ...identity, encoding: options.fallbackEncoding, library: TOKENIZER_ID, source: "fallback" }
}

export function tokenLabel(basis: TokenBasis) {
  return `${basis.providerID && basis.modelID ? `${basis.providerID}/${basis.modelID} · ` : ""}${basis.encoding} · ${basis.source} · local estimate`
}
