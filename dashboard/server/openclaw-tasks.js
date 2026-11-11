import crypto from "node:crypto";
import express from "express";
import { emit } from "./log-bus.js";

export const TASK_ROUTE = "/api/admin/openclaw-tasks";
const EDITABLE = ["name", "description", "agentId", "sessionKey", "enabled", "deleteAfterRun", "schedule", "sessionTarget", "wakeMode", "payload", "delivery", "failureAlert"];
export const taskConfig = job => Object.fromEntries(EDITABLE.filter(key => Object.hasOwn(job, key)).map(key => [key, job[key]]));
export const taskHash = job => crypto.createHash("sha256").update(JSON.stringify(taskConfig(job))).digest("hex");
const fail = (status, cause) => Object.assign(new Error(`Task cannot be changed: dashboard/scheduled tasks — ${cause}.`), { status });

export class OpenClawTasks {
  constructor(call) { this.call = call; this.pending = Promise.resolve(); }
  async list() {
    const jobs = []; let offset = 0;
    do {
      const page = await this.call("cron.list", { includeDisabled: true, limit: 200, offset, sortBy: "name", sortDir: "asc" });
      if (!Array.isArray(page.jobs)) throw fail(502, "gateway returned no task list");
      jobs.push(...page.jobs);
      if (!page.hasMore) break;
      const next = page.nextOffset ?? offset + page.jobs.length;
      if (next <= offset || !page.jobs.length) throw fail(502, "gateway pagination did not advance");
      offset = next;
    } while (true);
    return jobs.map(job => ({ ...job, hash: taskHash(job) }));
  }
  mutate(action, id, body) {
    const operation = this.pending.then(async () => {
      let current;
      if (action !== "add") {
        const job = (await this.list()).find(item => item.id === id);
        if (!job) throw fail(404, "task no longer exists; reload the list");
        current = job;
        if (body.baseHash !== job.hash) throw fail(409, "task changed after it was loaded; reload before saving");
      }
      if (action === "remove") return this.call("cron.remove", { id });
      const patch = body.task;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw fail(400, "task configuration must be an object");
      if (Object.keys(patch).some(key => !EDITABLE.includes(key))) throw fail(400, "configuration contains read-only or unsupported fields");
      if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim())) throw fail(400, "task name is required");
      // Stored jobs can contain legacy fields rejected by current write schemas.
      // Do not resend those untouched fields for a toggle-only edit.
      const changed = action === "add" ? patch : Object.fromEntries(Object.entries(patch).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key])));
      if (action !== "add" && !Object.keys(changed).length) return current;
      const saved = await this.call(action === "add" ? "cron.add" : "cron.update", action === "add" ? changed : { id, patch: changed });
      return { ...saved, hash: taskHash(saved) };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

export function mountOpenClawTasks(app, service, { requireAuth, requireAdmin, requireCsrf, isEnabled }) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(error => error.status ? res.status(error.status).json({ error: error.message }) : next(error));
  const available = (req, res, next) => Promise.resolve(isEnabled("openclaw-config")).then(enabled => enabled ? next() : res.status(404).json({ error: "Tasks unavailable: dashboard/scheduled tasks — OpenClaw settings are disabled." })).catch(next);
  const guards = [requireAuth, requireAdmin, available];
  app.get(TASK_ROUTE, ...guards, route(async (_req, res) => res.set("Cache-Control", "no-store").json({ jobs: await service.list() })));
  for (const [verb, suffix, action] of [["post", "", "add"], ["put", "/:id", "update"], ["delete", "/:id", "remove"]]) {
    app[verb](TASK_ROUTE + suffix, ...guards, requireCsrf, express.json({ limit: "600kb" }), route(async (req, res) => {
      const result = await service.mutate(action, req.params.id, req.body || {});
      emit({ source: "dashboard", level: "info", msg: `Scheduled task ${action} completed: dashboard/scheduled tasks — gateway accepted the administrator change.` });
      res.set("Cache-Control", "no-store").json(result);
    }));
  }
}
