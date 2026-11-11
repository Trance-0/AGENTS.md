import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function providerFailure(error) {
  const status = error?.data?.statusCode;
  let code;
  try { const body = JSON.parse(error?.data?.responseBody || '{}'); code = body.error?.code || body.error?.type; } catch {}
  const message = String(error?.data?.message || '');
  if (/credit|quota|billing/i.test(String(code)) || /no credits|insufficient.quota/i.test(message)) return 'provider billing/quota exhausted; add credit or select an available provider';
  if (status === 401 || status === 403) return 'provider authentication rejected; update its credentials';
  if (status === 429) return 'provider rate limited the request; retry after the provider cooldown';
  return `${error?.name || 'provider error'}${Number.isInteger(status) ? ` (HTTP ${status})` : ''}; inspect the retained OpenCode session`;
}
const fail = cause => new Error(`Coding task cannot continue: opencode-server/runtime — ${cause}.`);
const sessionID = value => {
  if (!/^ses_[a-zA-Z0-9]+$/.test(value || "")) throw fail("server returned an invalid session ID");
  return value;
};

export class OpenCodeRuntime {
  constructor(config, { fetchImpl = fetch, pollMs = 2000 } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
    this.running = new Set();
    const url = new URL(config.url);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw fail("server URL must use HTTP(S) without embedded credentials");
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw fail("non-local server connections require HTTPS");
  }

  async request(route, { method = "GET", body, cwd, signal } = {}) {
    const auth = JSON.parse(await fs.readFile(this.config.credentialsFile, "utf8"));
    if (!auth.username || !auth.password) throw fail("server credential file is incomplete");
    const url = new URL(route, this.config.url);
    if (cwd) url.searchParams.set("directory", cwd);
    let response;
    try {
      response = await this.fetch(url, {
        method, signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
        headers: { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) { throw fail(signal?.aborted ? "request canceled" : `server request failed (${error.name})`); }
    if (!response.ok) throw fail(`server rejected ${method} ${url.pathname} with HTTP ${response.status}`);
    if (response.status === 204) return undefined;
    return response.json();
  }

  file(key) { return path.join(this.config.stateDir, `${crypto.createHash("sha256").update(key).digest("hex")}.json`); }
  async read(key) {
    try { return JSON.parse(await fs.readFile(this.file(key), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw fail("saved session mapping is unreadable"); }
  }
  async save(key, record) {
    await fs.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const target = this.file(key), temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temporary, target);
  }
  directory(cwd) {
    const candidate = cwd || this.config.cwd;
    for (const [from, to] of Object.entries(this.config.pathMap || {}).sort((a, b) => b[0].length - a[0].length)) {
      if (candidate === from || candidate.startsWith(`${from}/`)) return path.resolve(to, `.${candidate.slice(from.length)}`);
    }
    if (!path.isAbsolute(candidate)) throw fail("working directory must be absolute");
    return candidate;
  }
  async ensureSession(input) {
    if (input.agent !== "opencode") throw fail(`unsupported harness ${input.agent}`);
    if (input.env && Object.keys(input.env).length) throw fail("per-session environment overrides are unavailable on a shared server");
    let record = await this.read(input.sessionKey);
    const cwd = this.directory(input.cwd);
    if (record && !record.closed) {
      if (record.cwd !== cwd) throw fail("session working directory changed; start a new session");
      await this.request(`/session/${sessionID(record.id)}`, { cwd });
    } else {
      const session = input.resumeSessionId
        ? await this.request(`/session/${sessionID(input.resumeSessionId)}`, { cwd })
        : await this.request("/session", { method: "POST", cwd, body: { title: `OpenClaw · ${input.sessionKey}` } });
      if (session.directory && session.directory !== cwd) throw fail("resumed session belongs to a different working directory");
      record = { id: sessionID(session.id), cwd, agent: "build", timeout: 21600 };
      await this.save(input.sessionKey, record);
    }
    return { sessionKey: input.sessionKey, backend: "opencode-server", runtimeSessionName: record.id, backendSessionId: record.id, agentSessionId: record.id, cwd };
  }
  async record(handle) {
    const record = await this.read(handle.sessionKey);
    if (!record || record.closed || record.id !== handle.agentSessionId) throw fail("session handle no longer matches its saved mapping");
    return record;
  }
  getCapabilities() { return { controls: ["session/status", "session/set_mode", "session/set_config_option"], configOptionKeys: ["model", "variant", "timeout"] }; }
  async getStatus({ handle }) {
    const record = await this.record(handle);
    const statuses = await this.request("/session/status", { cwd: record.cwd });
    return { summary: `OpenCode ${statuses[record.id]?.type || "idle"}`, backendSessionId: record.id, agentSessionId: record.id, details: { cwd: record.cwd, agent: record.agent, model: record.model, variant: record.variant } };
  }
  async setMode({ handle, mode }) {
    if (!["build", "plan"].includes(mode)) throw fail("mode must be build or plan");
    const record = await this.record(handle); record.agent = mode; await this.save(handle.sessionKey, record);
  }
  async setConfigOption({ handle, key, value }) {
    const record = await this.record(handle);
    if (key === "model") {
      const split = value.indexOf("/");
      if (split < 1 || split === value.length - 1) throw fail("model must be provider/model");
      record.model = { providerID: value.slice(0, split), modelID: value.slice(split + 1) };
    } else if (key === "variant") record.variant = value;
    else if (key === "timeout") {
      if (!Number.isFinite(Number(value)) || Number(value) < 1) throw fail("timeout must be a positive number of seconds");
      record.timeout = Number(value);
    } else throw fail(`unsupported session option ${key}`);
    await this.save(handle.sessionKey, record);
  }
  async doctor() {
    try {
      const health = await this.request("/global/health");
      return { ok: health.healthy === true, message: `Coding harness ${health.healthy ? "ready" : "unavailable"}: opencode-server/health — server version ${health.version}, healthy=${health.healthy}.` };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  async *runTurn(input) {
    const key = input.handle.sessionKey;
    if (this.running.has(key)) throw fail("this session already has an active turn");
    this.running.add(key);
    let record, submitted = false;
    try {
      record = await this.record(input.handle);
      const statuses = await this.request("/session/status", { cwd: record.cwd });
      if (statuses[record.id] && statuses[record.id].type !== "idle" && record.active?.requestId !== input.requestId) throw fail("the desktop or another request is already running in this session");
      if (record.active?.requestId !== input.requestId) {
        record.active = { requestId: input.requestId, messageId: `msg_${Date.now().toString(16)}${crypto.randomBytes(12).toString("hex")}`, startedAt: Date.now() };
        await this.save(key, record);
        const mapped = Object.entries(this.config.pathMap || {}).map(([from, to]) => `${from} -> ${to}`).join("; ");
        const context = `OpenCode tools run on the host in ${record.cwd}. Container paths mentioned in the task must be translated for host file tools: ${mapped || 'no path mappings configured'}. Keep container paths only inside docker exec commands. Report permission or provider blockers explicitly.\n\n`;
        const parts = [{ type: "text", text: context + input.text }, ...(input.attachments || []).map(item => ({ type: "file", mime: item.mediaType, url: `data:${item.mediaType};base64,${item.data}` }))];
        await this.request(`/session/${record.id}/prompt_async`, { method: "POST", cwd: record.cwd, signal: input.signal, body: { messageID: record.active.messageId, agent: record.agent, ...(record.model ? { model: record.model } : {}), ...(record.variant ? { variant: record.variant } : {}), parts } });
      }
      submitted = true;
      const seen = new Map(); let lastHeartbeat = 0, idleSince;
      while (true) {
        if (input.signal?.aborted) throw fail("turn canceled");
        if (Date.now() - record.active.startedAt > record.timeout * 1000) throw fail(`turn exceeded its ${record.timeout}-second limit; history is retained for resuming`);
        const messages = await this.request(`/session/${record.id}/message?limit=100`, { cwd: record.cwd, signal: input.signal });
        let complete = false;
        for (const message of messages) {
          if (message.info?.role !== "assistant" || message.info.parentID !== record.active.messageId) continue;
          if (message.info.error) throw fail(`model response failed: ${providerFailure(message.info.error)}`);
          for (const part of message.parts || []) {
            if (part.type === "text" || part.type === "reasoning") {
              const previous = seen.get(part.id) || "", text = part.text || "";
              if (text.startsWith(previous) && text.length > previous.length) yield { type: "text_delta", text: text.slice(previous.length), stream: part.type === "reasoning" ? "thought" : "output" };
              seen.set(part.id, text);
            } else if (part.type === "tool" && seen.get(part.id) !== part.state?.status) {
              seen.set(part.id, part.state?.status);
              yield { type: "tool_call", text: `OpenCode tool ${part.tool}: ${part.state?.status}`, toolCallId: part.callID, title: part.tool, status: part.state?.status };
            }
          }
          if (message.info.time?.completed && message.info.finish && !["tool-calls", "unknown"].includes(message.info.finish)) complete = true;
        }
        if (complete) {
          const latest = await this.record(input.handle);
          delete latest.active; await this.save(key, latest);
          yield { type: "done", stopReason: "end_turn" }; return;
        }
        const statuses = await this.request("/session/status", { cwd: record.cwd, signal: input.signal });
        if (!statuses[record.id] || statuses[record.id].type === "idle") idleSince ??= Date.now(); else idleSince = undefined;
        if (idleSince && Date.now() - idleSince > 60000) throw fail("server became idle without a completed response; inspect the retained session before retrying");
        if (Date.now() - lastHeartbeat >= 20000) {
          const permissions = await this.request("/permission", { cwd: record.cwd, signal: input.signal });
          const awaiting = permissions.some(item => item.sessionID === record.id);
          if (awaiting) throw fail("permission approval required in the OpenCode UI; task is blocked and the transcript is retained");
          const retrying = statuses[record.id]?.type === "retry";
          yield { type: "status", text: awaiting ? "Coding task is waiting: opencode-server/permission — approve or reject the pending request in the OpenCode UI." : retrying ? `Coding task is waiting: opencode-server/provider retry — provider request failed; OpenCode is waiting before attempt ${statuses[record.id].attempt}. Inspect the session for the provider response.` : `Coding task is running: opencode-server/turn — session ${record.id} remains active; elapsed ${Math.round((Date.now() - record.active.startedAt) / 1000)} seconds.` };
          lastHeartbeat = Date.now();
        }
        await delay(this.pollMs, undefined, { signal: input.signal });
      }
    } catch (error) {
      if (submitted) await this.cancel({ handle: input.handle }).catch(() => {});
      throw error;
    } finally { this.running.delete(key); }
  }
  async cancel({ handle }) {
    const record = await this.record(handle);
    await this.request(`/session/${record.id}/abort`, { method: "POST", cwd: record.cwd });
    delete record.active; await this.save(handle.sessionKey, record);
  }
  async close({ handle }) {
    await this.cancel({ handle });
    const record = await this.record(handle); record.closed = true; await this.save(handle.sessionKey, record);
  }
}
