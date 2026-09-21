/**
 * Dashboard appearance.
 *
 * The dashboard was a single hard-coded dark palette with a purple accent. That
 * is a reasonable default and a poor requirement: the page sits next to an
 * editor the user has already themed, and on a bright screen a forced dark
 * panel is the one window they have to squint at.
 *
 * Three things are configurable — the mode, and an accent for each mode — and
 * nothing else. A full palette editor would be a colour picker per token and a
 * standing invitation to build an unreadable page; an accent is the part that
 * carries identity, while contrast stays the stylesheet's responsibility.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR } from "./paths.ts"

const FILE = path.join(CONFIG_DIR, "dashboard-theme.json")

/** `system` follows the OS via `prefers-color-scheme`. */
export type Mode = "light" | "dark" | "system"

export type Theme = {
  mode: Mode
  /** Accent used while the dark palette is active. */
  darkAccent: string
  /** Accent used while the light palette is active. */
  lightAccent: string
}

/**
 * Named accents rather than a free-form colour field.
 *
 * Each is pre-checked against both palettes, so no choice can produce text
 * that fails to read against its background — which an arbitrary hex value
 * very easily does.
 */
export const ACCENTS: Array<{ value: string; label: string; dark: string; light: string }> = [
  { value: "purple", label: "Purple", dark: "#a78bfa", light: "#7c3aed" },
  { value: "blue", label: "Blue", dark: "#60a5fa", light: "#2563eb" },
  { value: "teal", label: "Teal", dark: "#2dd4bf", light: "#0d9488" },
  { value: "green", label: "Green", dark: "#4ade80", light: "#16a34a" },
  { value: "amber", label: "Amber", dark: "#fbbf24", light: "#b45309" },
  { value: "rose", label: "Rose", dark: "#fb7185", light: "#e11d48" },
  { value: "slate", label: "Slate", dark: "#94a3b8", light: "#475569" },
]

export const DEFAULTS: Theme = { mode: "dark", darkAccent: "purple", lightAccent: "blue" }

function accent(value: unknown, fallback: string): string {
  const name = String(value ?? "")
  return ACCENTS.some((entry) => entry.value === name) ? name : fallback
}

export async function load(): Promise<Theme> {
  try {
    const parsed = JSON.parse(await fsp.readFile(FILE, "utf8"))
    const mode = parsed?.mode
    return {
      mode: mode === "light" || mode === "dark" || mode === "system" ? mode : DEFAULTS.mode,
      darkAccent: accent(parsed?.darkAccent, DEFAULTS.darkAccent),
      lightAccent: accent(parsed?.lightAccent, DEFAULTS.lightAccent),
    }
  } catch {
    // Missing or corrupt: the defaults are a working theme.
    return { ...DEFAULTS }
  }
}

export async function save(patch: Partial<Theme>): Promise<Theme> {
  const next = { ...(await load()), ...patch }
  await fsp.mkdir(path.dirname(FILE), { recursive: true })
  await fsp.writeFile(FILE, JSON.stringify(next, null, 2) + "\n", "utf8")
  return next
}

/** Hex pair for one accent name, for inlining into the page. */
export function resolve(name: string): { dark: string; light: string } {
  const found = ACCENTS.find((entry) => entry.value === name) ?? ACCENTS[0]
  return { dark: found.dark, light: found.light }
}
