// Defensive read of CliProxy account reset state.
//
// A Codex account's "reset" is its ChatGPT subscription cycle, held on the
// /auth-files entry under `id_token.chatgpt_subscription_active_start` and
// `id_token.chatgpt_subscription_active_until` (plus `plan_type`). The field
// names are not pinned across CPA versions, so the dashboard detects them from
// the response, the Subscriptions panel shows the mapping, and an administrator
// can override it. Nothing here fabricates a reset; an undetected concept reads
// as null and its alarm stays silent.

export const RESET_CONCEPTS = ["ticked", "requested", "arrivedAt", "expiresAt"];

const CONCEPT_HINTS = {
  ticked: /tick/i,
  requested: /request/i,
  arrivedAt: /active_start|arriv/i,
  expiresAt: /active_until|expire|expir/i,
};

// Collect the reset-relevant fields from one raw auth-file entry. Only keys
// that carry "reset" (or the narrower concept words) plus the non-secret
// subscription/liveness fields are kept, so an account's bearer token or other
// private fields never enter the snapshot.
export function resetFields(entry) {
  const out = {};
  if (!entry || typeof entry !== "object") return out;
  for (const [key, value] of Object.entries(entry)) {
    if (/reset/i.test(key)) out[key] = value;
  }
  // ChatGPT subscription window lives one level down inside id_token; flatten
  // the non-secret sub-fields so the reset mapping can address them by name.
  const token = entry.id_token;
  if (token && typeof token === "object") {
    for (const key of ["chatgpt_subscription_active_start", "chatgpt_subscription_active_until", "plan_type"]) {
      if (token[key] !== undefined) out[key] = token[key];
    }
  }
  for (const key of ["last_refresh", "status", "failed", "success", "unavailable"]) {
    if (entry[key] !== undefined) out[key] = entry[key];
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
    for (const key of Object.keys(raw)) keys.add(key);
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

// Read one account's reset state using the resolved field mapping. `planType`
// is surfaced separately: an account with a plan but no active-until window is
// the "reset ticked missing" case the resetRequested alarm watches for.
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
    planType: typeof raw.plan_type === "string" && raw.plan_type ? raw.plan_type : null,
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
