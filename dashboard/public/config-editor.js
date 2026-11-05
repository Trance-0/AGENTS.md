import { api } from "/api.js";

// Administrator editor for OpenClaw's live openclaw.json. Masked secrets
// round-trip as placeholders and are restored server-side; invalid JSON is
// rejected before it is sent.
export async function renderConfigEditor(body, isAdmin) {
  const box = document.createElement("div");
  box.className = "config-editor";
  if (!isAdmin) {
    box.innerHTML = `<p class="config-status">Administrator group required to view or edit the OpenClaw config.</p>`;
    return body.appendChild(box);
  }
  box.innerHTML = `
    <p class="config-help">Secret values appear as <code>__dashboard_redacted__</code> and are kept unchanged on save. Prefer env SecretRefs such as <code>{"source":"env","provider":"default","id":"NAME"}</code> over literal credentials. Saves are backed up and hot-reloaded by OpenClaw.</p>
    <textarea class="config-text mono" spellcheck="false" rows="32" aria-label="openclaw.json"></textarea>
    <div class="config-actions"><button type="button" class="config-reload">Reload</button><button type="button" class="config-save primary">Save</button><span class="config-status" role="status"></span></div>`;
  body.appendChild(box);
  const text = box.querySelector(".config-text");
  const status = box.querySelector(".config-status");
  let baseHash = null;
  const load = async () => {
    status.textContent = "Loading…";
    try {
      const view = await api("/api/admin/openclaw-config");
      text.value = JSON.stringify(view.config, null, 2);
      baseHash = view.hash;
      status.textContent = `Loaded; last modified ${view.modifiedAt}.`;
    } catch (error) { status.textContent = error.message; }
  };
  box.querySelector(".config-reload").addEventListener("click", load);
  box.querySelector(".config-save").addEventListener("click", async () => {
    try { JSON.parse(text.value); }
    catch (error) { status.textContent = `Config cannot be saved: dashboard/browser validation — invalid JSON (${error.message}).`; return; }
    status.textContent = "Saving…";
    try {
      const view = await api("/api/admin/openclaw-config", { method: "PUT", body: JSON.stringify({ text: text.value, baseHash }) });
      text.value = JSON.stringify(view.config, null, 2);
      baseHash = view.hash;
      status.textContent = view.changed ? `Saved at ${view.modifiedAt}; OpenClaw will hot-reload it.` : "No changes to save.";
    } catch (error) { status.textContent = error.message; }
  });
  await load();
}
