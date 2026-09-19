/**
 * Device identity for the session index.
 *
 * The session index is designed to be shared between machines (the stores it
 * describes are often on a synced drive), so every entry records which device
 * observed it. A directory path alone is ambiguous across devices —
 * `D:\Documents\project` can exist on two machines and mean different things —
 * so `(device, directory)` together identify a working location.
 *
 * The identifier is stable per machine and written once to
 * `~/.config/opencode/device.json`.
 */

import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { CONFIG_DIR } from "./paths.ts"

export type Device = {
  /** Short stable identifier, e.g. `win-3f9a1c2b`. */
  id: string
  hostname: string
  platform: NodeJS.Platform
  /** Home directory, used to recognise paths belonging to this device. */
  home: string
  createdAt: number
}

const DEVICE_PATH = path.join(CONFIG_DIR, "device.json")

let cached: Device | null = null

function derive(): Device {
  const hostname = os.hostname()
  // Hash the hostname with the home directory so two machines that happen to
  // share a hostname still get distinct identifiers.
  const digest = crypto.createHash("sha1").update(`${hostname}\u0000${os.homedir()}`).digest("hex").slice(0, 8)
  const prefix = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform
  return {
    id: `${prefix}-${digest}`,
    hostname,
    platform: process.platform,
    home: os.homedir(),
    createdAt: Date.now(),
  }
}

/** Identity of the machine this process is running on. */
export async function local(): Promise<Device> {
  if (cached) return cached

  try {
    const parsed = JSON.parse(await fsp.readFile(DEVICE_PATH, "utf8"))
    if (parsed && typeof parsed.id === "string" && parsed.id) {
      cached = parsed as Device
      return cached
    }
  } catch {
    // No identity recorded yet.
  }

  const device = derive()
  await fsp.mkdir(path.dirname(DEVICE_PATH), { recursive: true })
  await fsp.writeFile(DEVICE_PATH, JSON.stringify(device, null, 2) + "\n", "utf8")
  cached = device
  return device
}

/** The basename of a path, tolerating either separator regardless of platform. */
export function basename(directory: string): string {
  const cleaned = directory.replace(/[\\/]+$/, "")
  const index = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"))
  return index < 0 ? cleaned : cleaned.slice(index + 1)
}
