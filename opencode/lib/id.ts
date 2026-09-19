/**
 * opencode identifier generation.
 *
 * Mirrors `packages/core/src/util/id.ts`: a 26-character identifier whose first
 * 12 characters are a hex timestamp (milliseconds shifted left 12 bits plus a
 * monotonic counter, bitwise inverted for descending ids) and whose remaining
 * 14 characters are random base62. Sessions/messages/parts must use ids in this
 * shape or opencode's schema validation rejects the row on read.
 */

import crypto from "node:crypto"

const LENGTH = 26
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

let lastTimestamp = 0
let counter = 0

function create(descending: boolean, timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current

  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")

  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH - 12))
  return time + Array.from(bytes, (byte) => CHARS[byte % 62]).join("")
}

/** Ascending ids sort oldest-first (used for messages and parts). */
export function ascending(prefix: string, timestamp?: number): string {
  return `${prefix}_${create(false, timestamp)}`
}

/** Descending ids sort newest-first (used for sessions). */
export function descending(prefix: string, timestamp?: number): string {
  return `${prefix}_${create(true, timestamp)}`
}

/** Recover the millisecond timestamp encoded in an identifier. */
export function timestampOf(id: string): number {
  const prefix = id.split("_")[0]
  const hex = id.slice(prefix.length + 1, prefix.length + 13)
  return Number(BigInt("0x" + hex) / 4096n)
}

export const sessionID = (timestamp?: number) => descending("ses", timestamp)
export const messageID = (timestamp?: number) => ascending("msg", timestamp)
export const partID = (timestamp?: number) => ascending("prt", timestamp)
