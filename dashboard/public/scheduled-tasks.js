import { api, el } from "/api.js";
import { button, section, editorTabs } from "/settings-controls.js";
import { scheduleDescription } from "/task-schedule.js";
import { renderTaskForm } from "/task-editor.js";

const KEYS = ["name", "description", "agentId", "sessionKey", "enabled", "deleteAfterRun", "schedule", "sessionTarget", "wakeMode", "payload", "delivery", "failureAlert"];
const editable = job => Object.fromEntries(KEYS.filter(k => Object.hasOwn(job, k)).map(k => [k, structuredClone(job[k])]));
const time = value => value ? new Date(value).toLocaleString() : "—";
export async function renderScheduledTasks(body) {
  const box = el("div", "apple-settings scheduled-tasks"); body.append(box);
  const heading = el("div", "task-heading"); const title = el("div"); title.append(el("h2", "", "Scheduled tasks"), el("p", "settings-note", "Automations across all your OpenClaw agents."));
  const count = el("span", "task-count"); heading.append(title, count);
  const status = el("p", "editor-status"); status.setAttribute("role", "status");
  const workspace = el("div", "task-workspace"), list = el("div", "task-list"), detail = el("div", "task-detail");
  workspace.append(list, detail); box.append(heading, status, workspace);
  let jobs = [], config = {}, current = null, draft = null, dirty = false, busy = false;
  const filter = document.createElement("input"); filter.type = "search"; filter.placeholder = "Search tasks"; filter.setAttribute("aria-label", "Search scheduled tasks"); filter.oninput = () => drawList();
  const toolbar = el("div", "task-toolbar"); toolbar.append(filter, button("Refresh", () => load()), button("New task", () => open(null), true)); box.insertBefore(toolbar, workspace);
  function drawList() {
    list.replaceChildren(); count.textContent = `${jobs.length} tasks · ${jobs.filter(j => j.enabled).length} enabled`;
    for (const job of jobs.filter(j => `${j.name} ${j.agentId || ""} ${j.description || ""}`.toLowerCase().includes(filter.value.toLowerCase()))) {
      const row = button("", () => open(job)); row.className = `task-list-item${current?.id === job.id ? " selected" : ""}`; row.setAttribute("aria-pressed", String(current?.id === job.id));
      const top = el("span", "task-item-heading"); top.append(el("strong", "", job.name), el("span", `task-badge ${job.enabled ? "enabled" : ""}`, job.enabled ? "Enabled" : "Paused"));
      row.append(top, el("span", "task-description", scheduleDescription(job.schedule)), el("span", "task-meta", `${job.agentId || "Default agent"} · ${job.payload.model || "Agent model"}`));
      list.append(row);
    }
    if (!list.children.length) list.append(el("p", "empty-state", jobs.length ? "No matching tasks." : "No scheduled tasks yet. Create one to get started."));
  }
  function open(job) {
    if (dirty && !confirm("Discard unsaved changes to this task?")) return;
    current = job; dirty = false; draft = job ? editable(job) : { name: "", enabled: false, schedule: { kind: "every", everyMs: 3600000 }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "" }, delivery: { mode: "none" } };
    drawList(); drawEditor();
    if (matchMedia("(max-width: 720px)").matches) detail.scrollIntoView({ block: "start" });
  }
  function drawEditor() {
    detail.replaceChildren();
    const caption = el("h3", "task-editor-title", current ? "Edit task" : "New task");
    const form = el("form", "task-form"); form.onsubmit = event => { event.preventDefault(); save(); };
    const raw = el("div", "raw-editor"); const text = el("textarea", "config-text mono"); text.rows = 24; text.spellcheck = false; text.setAttribute("aria-label", "Task JSON configuration"); raw.append(text);
    const changed = () => { dirty = true; status.textContent = "Unsaved task changes"; };
    const parse = () => { const value = JSON.parse(text.value); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("task configuration must be an object"); draft = value; renderTaskForm(form, draft, config, changed); };
    const tabs = editorTabs(form, raw, { label: "Task editor", status, toJson: () => { text.value = JSON.stringify(draft, null, 2); }, toForm: parse }); text.oninput = changed;
    renderTaskForm(form, draft, config, changed);
    const actions = el("div", "editor-toolbar"); const saveButton = button(current ? "Save task" : "Create task", save, true); actions.append(saveButton);
    if (current) actions.append(button("Delete task", async () => {
      if (busy || !confirm(`Delete “${current.name}”? This removes its future scheduled runs.`)) return;
      busy = true;
      try { await api(`/api/admin/openclaw-tasks/${encodeURIComponent(current.id)}`, { method: "DELETE", body: JSON.stringify({ baseHash: current.hash }) }); dirty = false; current = null; await load(false); status.textContent = "Task deleted"; }
      catch (error) { status.textContent = error.message; }
      finally { busy = false; }
    }));
    detail.append(caption, tabs.bar, form, raw, actions);
    if (current) {
      const history = section("Latest activity", "Execution status reported by OpenClaw.");
      const stats = el("dl", "task-state");
      for (const [label, value] of [["Next run", time(current.state?.nextRunAtMs)], ["Last run", time(current.state?.lastRunAtMs)], ["Result", current.state?.lastRunStatus || current.state?.lastStatus || "Not run yet"], ["Delivery", current.state?.lastDeliveryStatus || "—"]]) stats.append(el("dt", "", label), el("dd", "", value));
      history.append(stats); if (current.state?.lastError) history.append(el("p", "task-error", `Last run failed: OpenClaw/scheduled task — ${current.state.lastError}`)); detail.append(history);
    }
    async function save() {
      if (busy) return;
      try {
        if (tabs.isRaw()) parse(); else if (!form.reportValidity()) return;
        if (!draft.name?.trim() || !(draft.payload?.message || draft.payload?.text)?.trim()) throw new Error("a task name and prompt are required");
        if (current?.payload?.model && draft.payload?.kind === "agentTurn" && !draft.payload.model?.trim()) throw new Error("select a model; this gateway cannot clear an existing model override");
        busy = true; saveButton.disabled = true;
        const saved = await api(`/api/admin/openclaw-tasks${current ? `/${encodeURIComponent(current.id)}` : ""}`, { method: current ? "PUT" : "POST", body: JSON.stringify({ task: draft, baseHash: current?.hash }) });
        dirty = false; const id = saved.id || current?.id; await load(false, id); status.textContent = "Task saved · schedule updated in OpenClaw";
      } catch (error) { status.textContent = `Task not saved: dashboard/task editor — ${error.message}`; }
      finally { busy = false; saveButton.disabled = false; }
    }
  }
  async function load(confirmDiscard = true, selectedId = current?.id) {
    if (confirmDiscard && dirty && !confirm("Discard unsaved task changes and refresh?")) return;
    status.textContent = "Loading scheduled tasks…";
    try {
      const [data, view] = await Promise.all([api("/api/admin/openclaw-tasks"), api("/api/admin/openclaw-config")]); jobs = data.jobs; config = view.config; dirty = false;
      const selected = jobs.find(j => j.id === selectedId) || jobs[0];
      if (selected) open(selected); else { current = null; draft = null; drawList(); detail.replaceChildren(el("p", "empty-state", "Choose a task or create a new automation.")); }
      status.textContent = "Tasks are up to date";
    } catch (error) { status.textContent = error.message; }
  }
  await load();
}
