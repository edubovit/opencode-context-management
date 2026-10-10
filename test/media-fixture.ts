import { deflateSync } from "node:zlib"

const width = 960
const height = 600
const stride = width * 3 + 1
const pixels = Buffer.alloc(stride * height)
let seed = 123456789
for (let index = 0; index < pixels.length; index++) {
  if (index % stride === 0) continue
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  pixels[index] = seed & 255
}

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4)
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

const header = Buffer.alloc(13)
header.writeUInt32BE(width, 0)
header.writeUInt32BE(height, 4)
header[8] = 8
header[9] = 2
const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))])
export const syntheticImage = { type: "file" as const, mime: "image/png", uri: `data:image/png;base64,${bytes.toString("base64")}` }
