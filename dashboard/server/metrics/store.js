import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const name = value => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value);
const tokens = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
// Estimated cost in nano-USD per usage row: an administrator price wins over
// the price OpenClaw recorded; NULL when neither is known.
const COST_NANO = `CASE WHEN p.route IS NOT NULL THEN ROUND(1000*(e.input*p.input+e.output*p.output+e.cacheRead*p.cacheRead+e.cacheWrite*p.cacheWrite)) ELSE e.costNano END`;
const fail = reason => Object.assign(new Error(`Usage unavailable: dashboard/metrics storage — ${reason}.`), { status: 400 });

export class MetricsStore {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "metrics.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, route TEXT NOT NULL, model TEXT NOT NULL,
        agent TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
        cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL, total INTEGER NOT NULL,
        success INTEGER NOT NULL, costNano INTEGER, priceSource TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_time ON usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS usage_route_model_time ON usage_events(route, model, timestamp);
      CREATE TABLE IF NOT EXISTS model_prices (route TEXT NOT NULL, model TEXT NOT NULL,
        input REAL NOT NULL, output REAL NOT NULL, cacheRead REAL NOT NULL, cacheWrite REAL NOT NULL,
        updatedAt INTEGER NOT NULL, PRIMARY KEY(route, model));
      CREATE TABLE IF NOT EXISTS log_cursors (name TEXT PRIMARY KEY, inode TEXT NOT NULL, offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metrics_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  ingest(event) {
    if (!event || event.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(event.id || "") || !name(event.route) || !name(event.model) || !name(event.agent)) return false;
    if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0 || event.timestamp > Date.now() + 300000) return false;
    if (!["input", "output", "cacheRead", "cacheWrite", "total"].every(key => tokens(event[key]))) return false;
    if (event.total !== event.input + event.output + event.cacheRead + event.cacheWrite) return false;
    const costNano = typeof event.costUsd === "number" && event.costUsd >= 0 && Number.isSafeInteger(Math.round(event.costUsd * 1e9)) ? Math.round(event.costUsd * 1e9) : null;
    return this.db.prepare("INSERT OR IGNORE INTO usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(event.id, event.timestamp, event.route, event.model, event.agent, event.input, event.output, event.cacheRead, event.cacheWrite, event.total, event.success === false ? 0 : 1, costNano, costNano === null ? "unpriced" : "openclaw-config").changes > 0;
  }
  cursor(name) { return this.db.prepare("SELECT * FROM log_cursors WHERE name=?").get(name); }
  setCursor(name, inode, offset) { this.db.prepare("INSERT OR REPLACE INTO log_cursors VALUES (?,?,?)").run(name, String(inode), offset); }
  getSetting(name) { const row = this.db.prepare("SELECT value FROM metrics_settings WHERE name=?").get(name); return row ? JSON.parse(row.value) : null; }
  setSetting(name, value) { this.db.prepare("INSERT OR REPLACE INTO metrics_settings VALUES (?,?)").run(name, JSON.stringify(value)); }
  tokensBetween(start, end) {
    return this.db.prepare("SELECT COALESCE(SUM(total), 0) AS tokens FROM usage_events WHERE timestamp>=? AND timestamp<=?").get(start, end).tokens;
  }
  // Per-route tokens and estimated cost in [start, end]: [{ route, tokens, costUsd (known part or null), unpriced (attempts) }].
  routeTotals(start, end) {
    return this.db.prepare(`SELECT e.route, SUM(e.total) AS tokens, SUM(${COST_NANO}) AS costNano, SUM(CASE WHEN (${COST_NANO}) IS NULL THEN 1 ELSE 0 END) AS unpriced
      FROM usage_events e LEFT JOIN model_prices p ON p.route=e.route AND p.model=e.model WHERE e.timestamp>=? AND e.timestamp<=? GROUP BY e.route ORDER BY tokens DESC`)
      .all(start, end).map(row => ({ route: row.route, tokens: row.tokens ?? 0, costUsd: row.costNano === null ? null : row.costNano / 1e9, unpriced: row.unpriced ?? 0 }));
  }
  prices() { return this.db.prepare("SELECT * FROM model_prices ORDER BY route,model").all(); }
  savePrice(value) {
    if (!name(value?.route) || !name(value?.model)) throw fail("select a valid route and model");
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 100000) throw fail("prices must be finite nonnegative USD amounts per million tokens");
    this.db.prepare("INSERT OR REPLACE INTO model_prices VALUES (?,?,?,?,?,?,?)").run(value.route, value.model, value.input, value.output, value.cacheRead, value.cacheWrite, Date.now());
  }
  report({ days = 7, route = "", model = "" } = {}, now = Date.now()) {
    days = Number(days);
    if (![1, 7, 30, 90].includes(days) || (route && !name(route)) || (model && !name(model))) throw fail("choose a supported time range and valid route/model filters");
    const start = now - days * 86400000;
    const bucketMs = days === 1 ? 3600000 : 86400000;
    const params = [start, now, route, route, model, model];
    const from = `FROM usage_events e LEFT JOIN model_prices p ON p.route=e.route AND p.model=e.model
      WHERE e.timestamp>=? AND e.timestamp<=? AND (?='' OR e.route=?) AND (?='' OR e.model=?)`;
    const cost = COST_NANO;
    const sums = `COUNT(*) AS attempts, SUM(e.success) AS successes, SUM(e.input) AS input, SUM(e.output) AS output,
      SUM(e.cacheRead) AS cacheRead, SUM(e.cacheWrite) AS cacheWrite, SUM(e.total) AS tokens,
      SUM(${cost}) AS costNano, SUM(CASE WHEN (${cost}) IS NULL THEN 1 ELSE 0 END) AS unpriced`;
    const convert = row => {
      const result = { ...row };
      for (const key of ["attempts", "successes", "input", "output", "cacheRead", "cacheWrite", "tokens", "unpriced"]) result[key] ??= 0;
      result.costUsd = row.costNano === null ? null : row.costNano / 1e9;
      delete result.costNano;
      return result;
    };
    const summary = convert(this.db.prepare(`SELECT ${sums} ${from}`).get(...params));
    const routes = this.db.prepare(`SELECT e.route, ${sums} ${from} GROUP BY e.route ORDER BY tokens DESC`).all(...params).map(convert);
    const models = this.db.prepare(`SELECT e.route,e.model, ${sums} ${from} GROUP BY e.route,e.model ORDER BY tokens DESC`).all(...params).map(convert);
    const trends = this.db.prepare(`SELECT CAST(e.timestamp/${bucketMs} AS INTEGER)*${bucketMs} AS timestamp,e.route, ${sums} ${from} GROUP BY 1,e.route ORDER BY 1,e.route`).all(...params).map(convert);
    const filters = this.db.prepare("SELECT DISTINCT route,model FROM usage_events ORDER BY route,model").all();
    const first = this.db.prepare("SELECT MIN(timestamp) AS timestamp FROM usage_events").get().timestamp;
    return { summary, routes, models, trends, filters, prices: this.prices(), start, end: now, bucketMs, firstEventAt: first, currency: "USD", note: "One attempt includes its tool-continuation model calls. Attempts without reported tokens are excluded. Costs are estimates, not invoices; unpriced usage is excluded from the known subtotal. Cache tokens are separate from fresh input. Daily buckets use UTC; labels use your local time." };
  }
}
