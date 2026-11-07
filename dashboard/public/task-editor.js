import { el } from "/api.js";
import { section, field, input, select, toggle } from "/settings-controls.js";
import { scheduleFields } from "/task-schedule.js";
import { modelOptions } from "/config-editor.js";

export function renderTaskForm(host, draft, config, changed) {
  host.replaceChildren();
  const details = section("Task details", "Give this automation a name and choose which assistant runs it.");
  const grid = el("div", "form-grid");
  const name = input(draft.name, value => { draft.name = value; changed(); }); name.required = true;
  const agents = { "": "Default agent", ...Object.fromEntries((config.agents?.list || []).map(agent => [agent.id, agent.name || agent.id])) };
  grid.append(field("Name", name), field("Agent", select(draft.agentId || "", agents, value => { draft.agentId = value || null; changed(); })), field("Description", input(draft.description || "", value => { draft.description = value; changed(); })));
  details.append(grid, toggle("Enabled", draft.enabled, value => { draft.enabled = value; changed(); }), toggle("Delete after it runs", draft.deleteAfterRun, value => { draft.deleteAfterRun = value; changed(); }));
  const schedule = section("Schedule", "Choose when OpenClaw should run this task."); scheduleFields(schedule, draft, changed);
  const instructions = section("Instructions", "Set the prompt and model used for this scheduled run.");
  const kind = select(draft.payload.kind, { agentTurn: "Run an assistant", systemEvent: "Send a system event" }, value => {
    const message = draft.payload.message || draft.payload.text || "";
    draft.payload = value === "agentTurn" ? { kind: value, message } : { kind: value, text: message };
    draft.sessionTarget = value === "agentTurn" ? "isolated" : "main";
    if (value === "systemEvent") draft.delivery = { mode: "none" };
    changed(); renderTaskForm(host, draft, config, changed);
  });
  instructions.append(field("Action", kind));
  const prompt = el("textarea", "task-prompt"); prompt.rows = 8; prompt.value = draft.payload.message || draft.payload.text || ""; prompt.required = true;
  prompt.oninput = () => { draft.payload[draft.payload.kind === "agentTurn" ? "message" : "text"] = prompt.value; changed(); };
  instructions.append(field(draft.payload.kind === "agentTurn" ? "Prompt" : "Event text", prompt));
  if (draft.payload.kind === "agentTurn") {
    const model = input(draft.payload.model || "", value => { draft.payload.model = value; changed(); }); model.setAttribute("list", "task-model-options"); model.placeholder = "Inherit agent model";
    const options = el("datalist"); options.id = "task-model-options"; for (const value of modelOptions(config)) options.append(new Option(value));
    const execution = el("div", "form-grid"); execution.append(options, field("Model", model, "Choose a provider/model ID or an existing model alias."), field("Thinking", select(draft.payload.thinking || "", { "": "Agent default", off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" }, value => { draft.payload.thinking = value; changed(); })), field("Timeout (seconds)", input(draft.payload.timeoutSeconds, value => { draft.payload.timeoutSeconds = value; changed(); }, "number")));
    instructions.append(execution, toggle("Use lightweight context", draft.payload.lightContext, value => { draft.payload.lightContext = value; changed(); }));
  }
  const session = section("Session & delivery", "Choose where the task runs and where its result goes.");
  const execution = el("div", "form-grid");
  const target = select(draft.sessionTarget, { isolated: "Separate session", main: "Main conversation" }, value => { draft.sessionTarget = value; changed(); });
  // OpenClaw pairs agent turns with isolated sessions and system events with main.
  target.disabled = true;
  execution.append(field("Run in", target), field("Wake mode", select(draft.wakeMode, { now: "At the scheduled time", "next-heartbeat": "Next heartbeat" }, value => { draft.wakeMode = value; changed(); })), field("Session key", input(draft.sessionKey || "", value => { draft.sessionKey = value || null; changed(); }), "Optional session routing override."));
  session.append(execution);
  const delivery = el("div", "form-grid");
  const deliveryFields = () => {
    delivery.replaceChildren(); const current = draft.delivery || { mode: "none" };
    const mode = select(current.mode, { none: "Do not deliver", announce: "Send to a channel", webhook: "Send to a webhook" }, value => { draft.delivery = { ...current, mode: value }; changed(); deliveryFields(); });
    if (draft.payload.kind === "systemEvent") mode.disabled = true;
    delivery.append(field("Result delivery", mode));
    if (current.mode !== "none") {
      if (current.mode === "announce") delivery.append(field("Channel", select(current.channel || "last", ["last", ...Object.keys(config.channels || {})], value => { current.channel = value; draft.delivery = current; changed(); })));
      delivery.append(field(current.mode === "webhook" ? "Webhook URL" : "Recipient", input(current.to || "", value => { current.to = value; draft.delivery = current; changed(); }, current.mode === "webhook" ? "url" : "text")), field("Channel account", input(current.accountId || "", value => { current.accountId = value || undefined; draft.delivery = current; changed(); })));
      delivery.append(toggle("Continue if delivery fails", current.bestEffort, value => { current.bestEffort = value; draft.delivery = current; changed(); }));
    }
  };
  deliveryFields(); session.append(delivery); host.append(details, schedule, instructions, session);
}
