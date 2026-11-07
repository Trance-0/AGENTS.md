import { createHash } from "node:crypto";

const fail = (status, reason) => Object.assign(new Error(`Quota unavailable: dashboard/CPA management — ${reason}.`), { status });
const numeric = value => value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const epoch = value => {
  const n = numeric(value);
  return n !== null ? (n > 1e11 ? n : n * 1000) : typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
};
export function quotaWindow(entry, kind, now = Date.now()) {
  if (!entry || typeof entry !== "object") return null;
  const used = numeric(kind === "claude" ? entry.utilization : entry.used_percent ?? entry.usedPercent);
  const reset = epoch(entry.resets_at ?? entry.reset_at ?? entry.resetAt ?? entry.reset_time);
  const after = numeric(entry.reset_after_seconds ?? entry.resetAfterSeconds);
  // Window length lets pooled views classify windows by duration instead of by
  // the provider's primary/secondary label.
  const length = numeric(entry.limit_window_seconds ?? entry.limitWindowSeconds);
  return { remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)), resetsAt: reset ?? (after === null ? null : now + after * 1000), ...(length !== null && length > 0 ? { windowSeconds: length } : {}) };
}
export function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw fail(400, "enter a valid HTTPS dashboard address"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw fail(400, "dashboard address must use HTTPS without credentials, query, or fragment");
  return url.origin + url.pathname.replace(/\/(?:management\.html|v0\/management)\/?$/, "").replace(/\/+$/, "");
}

export async function fetchQuota(settings, fetcher = fetch) {
  const endpoint = validateEndpoint(settings.endpoint);
  const request = async (pathname, body) => {
    let response;
    try {
      response = await fetcher(endpoint + "/v0/management" + pathname, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${settings.key}`, "content-type": "application/json", accept: "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw fail(502, "remote request timed out or could not connect"); }
    if (!response.ok) throw fail(502, `remote dashboard returned HTTP ${response.status}; check the management key and remote access setting`);
    try { return await response.json(); } catch { throw fail(502, "remote dashboard returned an invalid JSON response"); }
  };
  const listing = await request("/auth-files");
  if (!Array.isArray(listing?.files)) throw fail(502, "account list was missing from the management response");
  const accounts = listing.files.filter(file => file.disabled !== true && (file.auth_index || file.authIndex));
  const rows = [];
  // A small worker pool keeps a large account collection from flooding upstreams.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
    while (next < accounts.length) {
      const index = next++, account = accounts[index];
      const provider = String(account.provider || account.type || "unknown").toLowerCase();
      const row = { id: createHash("sha256").update(String(account.name || index)).digest("hex").slice(0, 12), provider, label: `${provider} account ${index + 1}`, windows: [] };
      const call = async (url, header = {}, data) => {
        const result = await request("/api-call", { authIndex: String(account.auth_index ?? account.authIndex), method: data ? "POST" : "GET", url, header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", ...header }, ...(data ? { data: JSON.stringify(data) } : {}) });
        if (Number(result.status_code) < 200 || Number(result.status_code) >= 300) throw fail(502, `upstream quota returned HTTP ${Number(result.status_code) || 0}`);
        try { return typeof result.body === "string" ? JSON.parse(result.body) : result.body; } catch { throw fail(502, "upstream quota response was not JSON"); }
      };
      try {
        if (provider === "claude" || provider === "anthropic") {
          const body = await call("https://api.anthropic.com/api/oauth/usage", { "anthropic-beta": "oauth-2025-04-20" });
          for (const [key, label, seconds] of [["five_hour", "5 hours", 18000], ["seven_day", "7 days", 604800], ["seven_day_opus", "Opus · 7 days", 604800], ["seven_day_sonnet", "Sonnet · 7 days", 604800]]) {
            const window = quotaWindow(body?.[key], "claude"); if (window) row.windows.push({ label, ...window, windowSeconds: seconds });
          }
        } else if (provider === "codex" || provider === "openai") {
          const body = await call("https://chatgpt.com/backend-api/wham/usage", { "User-Agent": "codex_cli_rs/0.76.0" });
          const limits = body?.rate_limit ?? body?.rateLimit;
          for (const [key, label] of [["primary_window", "Primary window"], ["secondary_window", "Secondary window"]]) {
            const window = quotaWindow(limits?.[key], "codex"); if (window) row.windows.push({ label, ...window });
          }
        } else if (provider === "antigravity") {
          const project = account.project_id ?? account.projectId;
          if (!project) throw fail(502, "quota account has no project ID");
          const body = await call("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {}, { project });
          for (const group of body?.groups || []) for (const bucket of group.buckets || []) {
            const fraction = numeric(bucket.remainingFraction ?? bucket.remaining_fraction);
            row.windows.push({ label: `${String(group.displayName ?? group.display_name ?? "Model group").slice(0, 100)} · ${String(bucket.window || "quota").slice(0, 30)}`, remainingPercent: fraction === null ? null : Math.max(0, Math.min(100, fraction * 100)), resetsAt: epoch(bucket.resetTime ?? bucket.reset_time) });
          }
        } else row.error = "This provider does not expose a supported quota endpoint.";
        if (!row.windows.length && !row.error) row.error = "The provider returned no quota windows; remaining capacity is unknown.";
      } catch (error) { row.error = error.message?.startsWith("Quota unavailable:") ? error.message : "Quota unavailable: dashboard/CPA account — upstream response could not be read."; }
      rows.push(row);
    }
  }));
  return { updatedAt: Date.now(), accounts: rows.sort((a, b) => a.label.localeCompare(b.label)), note: "Quota is per account/window. Percentages are not added across accounts; unknown does not mean zero." };
}
