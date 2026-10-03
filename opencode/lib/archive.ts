/**
 * Streaming tar.gz writer.
 *
 * Exporting transcripts needs one portable file, and a gzipped tar is what
 * every platform can already open — unlike a zip, it can be written as a
 * stream, so a 300-session export never has to be assembled in memory first.
 *
 * Only the ustar subset that regular files need is implemented: no symlinks,
 * no sparse files, no pax extensions. Paths longer than 100 characters use the
 * `prefix` field, which covers `sessions/<kind>/<id>.json` with room to spare.
 *
 * Written here rather than taken from npm because the plugins are loaded
 * directly from this directory with no install step, so a dependency would
 * have to be vendored anyway — and this is the part of tar that is small.
 */

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { once } from "node:events"

const BLOCK = 512

/** Right-pad an octal number into a fixed-width, NUL-terminated field. */
function octal(value: number, width: number): Buffer {
  const text = Math.floor(value).toString(8).padStart(width - 1, "0")
  return Buffer.from(text.slice(-(width - 1)) + "\0", "ascii")
}

/**
 * Split a path into ustar's `name` and `prefix` halves.
 *
 * `name` holds 100 bytes and `prefix` 155, joined by a slash on extraction, so
 * a long path is split at a separator rather than truncated. The split has to
 * be at the *earliest* separator that leaves a tail of 100 bytes or fewer:
 * splitting later leaves a tail that still overflows, and since `write` caps
 * at the field width that would be written as a silently truncated name.
 */
function splitName(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" }

  for (let at = name.indexOf("/"); at !== -1; at = name.indexOf("/", at + 1)) {
    const tail = name.slice(at + 1)
    if (Buffer.byteLength(tail) > 100) continue
    if (at > 155) break
    return { name: tail, prefix: name.slice(0, at) }
  }
  throw new Error(`path too long for tar: ${name}`)
}

function header(name: string, size: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK)
  const parts = splitName(name)

  block.write(parts.name, 0, 100, "utf8")
  octal(0o644, 8).copy(block, 100)
  octal(0, 8).copy(block, 108)
  octal(0, 8).copy(block, 116)
  octal(size, 12).copy(block, 124)
  octal(Math.floor(mtime / 1000), 12).copy(block, 136)
  // The checksum is computed over a header whose own checksum field is spaces.
  block.fill(" ", 148, 156)
  block.write("0", 156, 1, "ascii") // regular file
  block.write("ustar\0", 257, 6, "ascii")
  block.write("00", 263, 2, "ascii")
  block.write(parts.prefix, 345, 155, "utf8")

  let sum = 0
  for (const byte of block) sum += byte
  // Six octal digits, a NUL and a space, as ustar specifies.
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii")

  return block
}

/** Zero bytes needed to round a payload up to the next 512-byte block. */
function padding(size: number): Buffer {
  const remainder = size % BLOCK
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder)
}

export type Entry = { name: string; data: Buffer | string; mtime?: number }

/**
 * Write `entries` to `file` as a gzipped tar, creating parent directories.
 *
 * `entries` is an async iterable so the caller can read one transcript, yield
 * it and move on: the archive is written incrementally and only the entry in
 * flight is held in memory.
 */
export async function writeTarGz(file: string, entries: AsyncIterable<Entry>): Promise<{ bytes: number; files: number }> {
  await fsp.mkdir(path.dirname(file), { recursive: true })

  let files = 0
  const source = Readable.from(
    (async function* () {
      for await (const entry of entries) {
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8")
        yield header(entry.name, data.length, entry.mtime ?? Date.now())
        yield data
        const pad = padding(data.length)
        if (pad.length) yield pad
        files++
      }
      // Two zero blocks mark the end of the archive.
      yield Buffer.alloc(BLOCK * 2)
    })(),
  )

  // Written to a temp name and renamed, so an interrupted export never leaves a
  // truncated archive looking like a complete one.
  const temp = `${file}.${process.pid}.tmp`
  try {
    await pipeline(source, zlib.createGzip({ level: 9 }), fs.createWriteStream(temp))
    await fsp.rename(temp, file)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw error
  }

  const stat = await fsp.stat(file)
  return { bytes: stat.size, files }
}

/** Read a NUL- or space-terminated octal field. */
function readOctal(block: Buffer, offset: number, width: number): number {
  const text = block.subarray(offset, offset + width).toString("ascii").replace(/\0.*$/, "").trim()
  return text === "" ? 0 : parseInt(text, 8) || 0
}

/** Read a NUL-terminated string field. */
function readString(block: Buffer, offset: number, width: number): string {
  const raw = block.subarray(offset, offset + width)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8")
}

/**
 * Read a gzipped tar back, yielding each regular file.
 *
 * The whole archive is decompressed into memory first. That is the honest
 * trade for an export of this shape: sessions are JSON text in the low
 * megabytes, and a streaming parser would have to re-implement block
 * reassembly across chunk boundaries for no benefit at that size. A guard
 * refuses anything large enough for the assumption to stop holding.
 */
export async function* readTarGz(file: string, maxBytes = 512 * 1024 * 1024): AsyncGenerator<Entry & { data: Buffer }> {
  const input = fs.createReadStream(file)
  const stream = input.pipe(zlib.createGunzip())
  const iterator = stream[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0), total = 0
  async function take(size: number): Promise<Buffer> {
    const chunks: Buffer[] = []
    let left = size
    while (left) {
      if (!pending.length) {
        const next = await iterator.next()
        if (next.done) throw new Error("Archive cannot be imported: session-manager/tar-read — truncated archive")
        pending = Buffer.from(next.value as Buffer)
        total += pending.length
        if (total > maxBytes) throw new Error("Archive cannot be imported: session-manager/tar-read — decompressed size limit exceeded")
      }
      const n = Math.min(left, pending.length)
      chunks.push(pending.subarray(0, n)); pending = pending.subarray(n); left -= n
    }
    return Buffer.concat(chunks, size)
  }

  try { while (true) {
    const head = await take(BLOCK)
    // A block of zeroes is the end-of-archive marker.
    if (head.every((byte) => byte === 0)) break

    const expected = readOctal(head, 148, 8)
    let checksum = 0
    for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : head[i]!
    if (checksum !== expected) throw new Error("Archive cannot be imported: session-manager/tar-read — header checksum mismatch")
    const size = readOctal(head, 124, 12)
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error("Archive cannot be imported: session-manager/tar-read — truncated or invalid payload size")
    }
    const typeFlag = String.fromCharCode(head[156]!)
    const prefix = readString(head, 345, 155)
    const name = readString(head, 0, 100)
    const full = prefix ? `${prefix}/${name}` : name

    const data = await take(size)
    // Payloads are padded to a block boundary.
    if (size % BLOCK) await take(BLOCK - size % BLOCK)

    // "0" and "\0" are both regular files; directories and metadata entries
    // (a pax header, say) carry no session and are skipped rather than parsed.
    if (typeFlag !== "0" && typeFlag !== "\0") continue
    if (!full) continue

    yield { name: full, data, mtime: readOctal(head, 136, 12) * 1000 }
  } } finally {
    const closed = input.closed ? Promise.resolve() : once(input, "close")
    input.destroy(); stream.destroy(); await closed
  }
}
