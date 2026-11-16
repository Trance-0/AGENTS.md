import { api, el } from "/api.js";
import { button, field, input, section, select } from "/settings-controls.js";
import { orderedModels } from "/model-order.js";
import { renderObject } from "/config-fields.js";

const TOOLS = [["opencode", "OpenCode"], ["codex", "Codex"], ["claude", "Claude Code"]];
export async function renderCodingEditor(body, isAdmin) {
  if (!isAdmin) return body.append(el("p", "", "Settings unavailable: dashboard/admin authorization — administrator access is required."));
  const box = el("div", "apple-settings coding-editor"); body.append(box);
  const status = el("p", "editor-status"); status.setAttribute("role", "status"); box.append(status);
  let gateway, coding, providers, selected = "opencode", dirty = false, saving = false;
  const changed = () => { dirty = true; status.textContent = "Unsaved changes"; };
  const wired = id => gateway.config.acp?.enabled === true && gateway.config.acp?.allowedAgents?.includes(id)
    && (id === "opencode" ? gateway.config.acp.backend === "opencode-server" && gateway.config.plugins?.entries?.["opencode-server"]?.enabled === true : gateway.config.acp.backend === "acpx" && gateway.config.plugins?.entries?.acpx?.enabled === true);
  function draw() {
    box.replaceChildren(status);
    const workspace = el("div", "configuration-workspace"), nav = el("nav", "config-section-nav"), content = el("div", "config-section-content");
    nav.setAttribute("aria-label", "Coding tools");
    nav.append(el("p", "settings-note", "Coding agents"));
    const tools = [...TOOLS];
    for (const id of gateway.config.acp?.allowedAgents || []) if (!tools.some(([tool]) => tool === id)) tools.push([id, id]);
    for (const [id, name] of tools) {
      const item = button(name, () => { selected = id; draw(); });
      item.append(el("small", "tool-availability", wired(id) ? "Connected to OpenClaw" : "Not connected to OpenClaw"));
      if (selected === id) item.setAttribute("aria-current", "true"); nav.append(item);
    }
    const name = tools.find(([id]) => id === selected)[1];
    content.append(section(name, "A coding agent can read project files, edit code, and run development tools. OpenClaw delegates coding tasks to the connected agent."));
    if (selected !== "opencode") {
      const settings = section(`${name} connection`, wired(selected) ? "Allowed by this instance's ACP configuration. ACP is the connection OpenClaw uses to send tasks to an external coding agent." : `${name} is not connected to this OpenClaw instance. Installing its desktop or terminal app alone does not connect it to OpenClaw.`);
      const cli = gateway.config.agents?.defaults?.cliBackends?.[`${selected}-cli`];
      if (cli) { const fields = el("div", "config-fields"); renderObject(fields, cli, changed, { path: `agents.defaults.cliBackends.${selected}-cli` }); settings.append(fields); }
      else settings.append(el("p", "settings-note", "No command-line backend settings are configured. Connect a supported backend before sending tasks to this tool."));
      content.append(settings);
    } else {
      const card = section("Models & reasoning", "Try models from top to bottom. If a provider is unavailable, the next model takes over. The last model is the final fallback. Drag the handle or use the arrow buttons to change the order.");
      if (coding) {
        const catalog = coding.models || [];
        const options = el("datalist"); options.id = "coding-model-options";
        for (const model of catalog) options.append(new Option(model.name, model.ref)); card.append(options);
        card.append(orderedModels(coding.config.chain, (row, entry, index) => {
          const model = input(entry.model, next => { entry.model = next; changed(); }); model.setAttribute("list", options.id);
          row.append(field(`Model ${index + 1}`, model, index === 0 ? "Tried first for coding tasks." : "Used when earlier models cannot respond."));
          const data = catalog.find(item => item.ref === entry.model);
          row.append(field(`Effort ${index + 1}`, select(entry.effort, data?.efforts || ["default", "none", "minimal", "low", "medium", "high", "xhigh"], next => { entry.effort = next; changed(); }), "Reasoning effort is how much computation the model spends before answering. Higher can be slower. Default uses the provider's setting; support varies by model."));
          if (!data?.configured) row.append(el("p", "settings-note model-unavailable", "Provider/model is not configured on this OpenCode server. Add it to the server configuration before it can run."));
        }, changed, { addValue: () => ({ model: "", effort: "default" }) }));
        if (coding.catalogError) card.append(el("p", "settings-note", coding.catalogError));
      } else card.append(el("p", "settings-note", "Model policy unavailable: dashboard/coding editor — the shared OpenCode configuration is not mounted. Connection settings remain available below."));
      content.append(card);
      if (providers) {
        const deepseek = providers.config.provider?.deepseek;
        const providerCard = section("DeepSeek connection", "DeepSeek is a hosted model provider. Add its API key here to make its fallback available. An empty key leaves DeepSeek unavailable; the next configured model can still run.");
        if (deepseek) {
          const key = input(deepseek.options?.apiKey === "__dashboard_redacted__" ? "" : deepseek.options?.apiKey || "", next => { deepseek.options ||= {}; deepseek.options.apiKey = next || (providers.originalKey ? "__dashboard_redacted__" : ""); changed(); }, "password");
          key.placeholder = providers.originalKey ? "Saved securely · leave blank to keep" : "Enter your DeepSeek API key"; key.autocomplete = "new-password";
          providerCard.append(field("DeepSeek API key", key, "Stored on the OpenCode server. The dashboard masks saved keys and backs up the previous configuration."));
          providerCard.append(field("DeepSeek API URL", input(deepseek.options?.baseURL || "", next => { deepseek.options ||= {}; deepseek.options.baseURL = next; changed(); }), "The service endpoint receiving DeepSeek requests. Keep the API path supplied by the provider."));
        } else providerCard.append(el("p", "settings-note", "DeepSeek is not yet listed in the OpenCode provider configuration."));
        content.append(providerCard);
      }
      const connection = section("OpenClaw connection", "ACP (Agent Client Protocol) is the bridge that lets OpenClaw start and resume tasks in OpenCode. These settings are read from the running instance's configuration.");
      const plugin = gateway.config.plugins?.entries?.["opencode-server"];
      const fields = el("div", "config-fields");
      if (plugin) renderObject(fields, plugin, changed, { path: "plugins.entries.opencode-server" });
      else fields.append(el("p", "settings-note", "The opencode-server plugin is not configured on this instance."));
      connection.append(fields); content.append(connection);
      const acpCard = section("Coding task routing", "ACP connects the chat agent to coding tools. The default agent handles delegated coding work; the allowlist limits which agents can be started. This instance uses the OpenCode backend.");
      const acpFields = el("div", "config-fields");
      if (gateway.config.acp) renderObject(acpFields, gateway.config.acp, changed, { path: "acp" });
      acpCard.append(acpFields); content.append(acpCard);
    }
    workspace.append(nav, content); box.append(workspace);
    const save = button("Save changes", async () => {
      saving = true; save.disabled = true;
      try {
        // Only changed stores are written; a policy edit does not rewrite chat configuration.
        if (providers && JSON.stringify(providers.config) !== providers.original) {
          providers = await api("/api/admin/opencode-providers", { method: "PUT", body: JSON.stringify({ text: JSON.stringify(providers.config), baseHash: providers.hash }) });
          providers.original = JSON.stringify(providers.config); providers.originalKey = providers.config.provider?.deepseek?.options?.apiKey === "__dashboard_redacted__";
        }
        if (coding && JSON.stringify(coding.config) !== coding.original) {
          coding = await api("/api/admin/opencode-config", { method: "PUT", body: JSON.stringify({ text: JSON.stringify(coding.config), baseHash: coding.hash }) });
          coding.original = JSON.stringify(coding.config);
        }
        if (JSON.stringify(gateway.config) !== gateway.original) {
          gateway = await api("/api/admin/openclaw-config", { method: "PUT", body: JSON.stringify({ text: JSON.stringify(gateway.config), baseHash: gateway.hash }) });
          gateway.original = JSON.stringify(gateway.config);
        }
        dirty = false;
        if (coding) { coding = await api("/api/admin/opencode-config"); coding.original = JSON.stringify(coding.config); }
        saving = false; draw(); status.textContent = "Saved · previous settings backed up. Model order, effort, and provider credentials apply to the next request.";
      } catch (error) { status.textContent = `Settings not fully saved: dashboard/coding editor — ${error.message}`; }
      finally { saving = false; save.disabled = false; }
    }, true); save.disabled = saving;
    const actions = el("div", "editor-toolbar"); actions.append(button("Reload", async () => { if (!dirty || confirm("Discard your unsaved coding settings?")) await load(); }), save); box.append(actions);
  }
  async function load() {
    status.textContent = "Loading coding agents…";
    try {
      const results = await Promise.allSettled([api("/api/admin/openclaw-config"), api("/api/admin/opencode-config"), api("/api/admin/opencode-providers")]);
      if (results[0].status === "rejected") throw results[0].reason;
      gateway = results[0].value; gateway.original = JSON.stringify(gateway.config);
      coding = results[1].status === "fulfilled" ? results[1].value : null;
      if (coding) coding.original = JSON.stringify(coding.config);
      providers = results[2].status === "fulfilled" ? results[2].value : null;
      if (providers) { providers.original = JSON.stringify(providers.config); providers.originalKey = providers.config.provider?.deepseek?.options?.apiKey === "__dashboard_redacted__"; }
      dirty = false; draw(); status.textContent = "Settings are up to date";
    } catch (error) { status.textContent = `Coding settings unavailable: dashboard/coding editor — ${error.message}`; }
  }
  await load();
}
