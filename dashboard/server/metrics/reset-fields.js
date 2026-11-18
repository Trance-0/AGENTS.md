// Defensive read of CliProxy account reset state.
//
// The management /auth-files entries carry per-account reset fields whose
// exact names are not pinned across CPA versions, so the dashboard detects the
// key names from the response and the Subscriptions panel shows that mapping
// (and lets the administrator override it). Nothing here fabricates a reset;
// an undetected concept simply reads as null and the matching alarm stays
// silent rather than guessing.

// Semantic concepts the reset alarms depend on. Each maps to a key-name hint.
export const RESET_CONCEPTS = ["ticked", "requested", "arrivedAt", "expiresAt"];

const CONCEPT_HINTS = {
  ticked: /tick/i,
  requested: /request/i,
  arrivedAt: /arriv/i,
  expiresAt: /expire|expir/i,
};

// Collect the reset-ish keys from one raw auth-file entry. Only keys that carry
// "reset" (or the narrower concept words) are kept, so an account's bearer
// token or other private fields never enter the snapshot.
export function resetFields(entry) {
  const out = {};
  if (!entry || typeof entry !== "object") return out;
  for (const [key, value] of Object.entries(entry)) {
    if (/reset/i.test(key)) out[key] = value;
  }
  return out;
}

// Propose a concept -> field-name mapping from the raw reset keys seen across
// accounts. Returns { ticked, requested, arrivedAt, expiresAt } with the
// detected key name (or "" when none matched).
export function detectResetFields(files) {
  const mapping = { ticked: "", requested: "", arrivedAt: "", expiresAt: "" };
  const keys = new Set();
  for (const file of files || []) {
    const raw = file?.reset ?? file ?? {};
    for (const key of Object.keys(raw)) if (/reset/i.test(key)) keys.add(key);
  }
  for (const concept of RESET_CONCEPTS) {
    mapping[concept] = [...keys].find(key => CONCEPT_HINTS[concept].test(key)) ?? "";
  }
  return mapping;
}

const truthy = value => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !/^(0|false|off|no)$/i.test(value.trim());
  return true;
};

const epoch = value => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e11 ? value : value * 1000;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric)) return numeric > 1e11 ? numeric : numeric * 1000;
  }
  return null;
};

// Read one account's reset state using the resolved field mapping. An empty
// field name (or a missing value) yields null for that concept.
export function readResetState(entry, mapping = {}) {
  const raw = entry?.reset ?? entry ?? {};
  const read = concept => {
    const key = mapping?.[concept];
    return key ? raw[key] : undefined;
  };
  return {
    ticked: truthy(read("ticked")),
    requested: truthy(read("requested")),
    arrivedAt: epoch(read("arrivedAt")),
    expiresAt: epoch(read("expiresAt")),
  };
}

// Merge a detected mapping with an administrator override; a non-empty override
// value wins over the detected key name.
export function resolveMapping(detected, override = {}) {
  const out = { ...detected };
  for (const concept of RESET_CONCEPTS) {
    const value = String(override?.[concept] ?? "").trim();
    if (value !== "") out[concept] = value;
  }
  return out;
}
