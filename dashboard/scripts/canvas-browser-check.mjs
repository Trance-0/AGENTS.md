// Chromium check for Settings → Canvas settings: admin-only (members and
// guests never see it, its APIs refuse them), the widget list (add, edit with
// the schema form and the shared validator, duplicate, delete, reorder,
// show/hide, keyboard), the live preview, the log-component embed attachment,
// scene configuration, Save layout vs. Apply to live stream (with its
// confirmation and recorded events), both themes, 390 px, and zero CSP
// violations. Spawned by server/auth.test.js with DASHBOARD_BROWSER_CHECK=1.
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
const baseURL = process.env.DASHBOARD_TEST_URL;
const shots = process.env.DASHBOARD_SCREENSHOT_DIR || "/tmp";
const errors = [];
const csp = [];

async function context(cookie, { width = 1440, height = 900, colorScheme = "dark" } = {}) {
  const ctx = await browser.newContext({ baseURL, colorScheme, viewport: { width, height }, extraHTTPHeaders: { "x-forwarded-proto": "https" } });
  if (cookie) { const [name, ...rest] = cookie.split("="); await ctx.addCookies([{ name, value: rest.join("="), url: baseURL, httpOnly: true, sameSite: "Lax" }]); }
  await ctx.route("**/api/**", async route => {
    if (route.request().method() === "GET") return route.continue();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: "https://live.example.test" } });
    await route.fulfill({ response });
  });
  await ctx.addInitScript(() => document.addEventListener("securitypolicyviolation", event => { (window.__csp ||= []).push(`${event.violatedDirective} ${event.blockedURI}`); }));
  return ctx;
}
async function open(ctx, path = "/#settings") {
  const page = await ctx.newPage();
  page.on("pageerror", error => {
    const text = `${error.message} ${(error.stack || "").split("\n").slice(1, 3).join(" ").trim()}`;
    // Switching an embed's theme or layer reloads its frame on purpose; the
    // frame's own in-flight fetches then abort inside the sandbox.
    if (/^Failed to fetch at \S+\/embed\/circtime\//.test(text)) return;
    errors.push(text);
  });
  page.on("console", message => { if (/Content Security Policy/i.test(message.text())) csp.push(message.text()); });
  await page.goto(path);
  await page.waitForSelector("#stream-title", { state: "attached" });
  return page;
}
const cspOf = async page => csp.push(...(await page.evaluate(() => window.__csp || [])));
const json = (page, url, init) => page.evaluate(([u, i]) => fetch(u, { ...i, headers: { "content-type": "application/json", "x-dashboard-request": "1" } }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) })), [url, init]);
const view = page => json(page, "/api/scene/layout").then(result => result.body);
const rows = page => page.locator("#canvas-widgets .canvas-row");
const rowOf = (page, id) => page.locator(`#canvas-widgets .canvas-row[data-widget-id="${id}"]`);
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
// Design audit without looking at pixels: text contrast (WCAG AA, 4.5:1 for
// body text, 3:1 for 18px+/bold 14px+), nothing spilling out of its row or
// the card, and no clipped single-line labels.
const audit = page => page.evaluate(() => {
  const parse = value => {
    const srgb = value.match(/color\(srgb ([^)]+)\)/);
    if (srgb) { const [r, g, b, a = 1] = srgb[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: r * 255, g: g * 255, b: b * 255, a }; }
    const m = value.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const background = element => { for (let node = element; node; node = node.parentElement) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c.a > 0.5) return c; } return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255 }; };
  const problems = [];
  const root = document.querySelector("#canvas-settings");
  const card = root.getBoundingClientRect();
  for (const element of root.querySelectorAll("h2, h3, h4, p, span, strong, label, legend, button, option, li")) {
    if (!element.offsetParent || element.closest(".canvas-preview") || !element.textContent.trim() || [...element.childNodes].every(node => node.nodeType !== 3 || !node.textContent.trim())) continue;
    const style = getComputedStyle(element);
    if (Number(style.opacity) < 1 || element.closest("[disabled], .is-hidden, :disabled")) continue;
    const fg = parse(style.color), bg = background(element);
    const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    const large = parseFloat(style.fontSize) >= 18 || (parseFloat(style.fontSize) >= 14 && Number(style.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) problems.push(`contrast ${ratio.toFixed(2)} for "${element.textContent.trim().slice(0, 40)}"`);
    const box = element.getBoundingClientRect();
    if (box.right > card.right + 1 || box.left < card.left - 1) problems.push(`outside the card: "${element.textContent.trim().slice(0, 40)}"`);
  }
  for (const row of root.querySelectorAll(".canvas-row")) {
    const outer = row.getBoundingClientRect();
    for (const child of row.children) { const box = child.getBoundingClientRect(); if (box.right > outer.right + 1 || box.bottom > outer.bottom + 1) problems.push(`row ${row.dataset.widgetId}: ${child.className} spills out`); }
  }
  return problems;
});

try {
  // ---------- Guests and members never see it ----------
  const guest = await context(undefined);
  const guestPage = await open(guest, "/#settings");
  assert.equal(await guestPage.locator("#canvas-settings").count(), 0, "guests have no canvas settings");
  assert.equal((await json(guestPage, "/api/scene/layout")).status, 401);
  assert.equal((await json(guestPage, "/api/scene/settings", { method: "PUT", body: "{}" })).status, 401);
  await guest.close();
  const member = await context(process.env.DASHBOARD_VIEWER_COOKIE);
  const memberPage = await open(member, "/#settings");
  await memberPage.waitForSelector(".settings-page");
  assert.equal(await memberPage.locator("#canvas-settings").count(), 0, "members do not get the canvas settings section");
  assert.equal((await json(memberPage, "/api/scene/layout")).status, 403);
  assert.equal((await json(memberPage, "/api/scene/layout", { method: "PUT", body: JSON.stringify({ widgets: [] }) })).status, 403);
  assert.equal((await json(memberPage, "/api/scene/widgets?scope=live", { method: "POST", body: JSON.stringify({ widget: { type: "text", x: 0, y: 0, w: 0.2, h: 0.1 } }) })).status, 403);
  await member.close();

  // ---------- Admin: a known starting point ----------
  const admin = await context(process.env.DASHBOARD_TEST_COOKIE);
  const page = await open(admin, "/#settings");
  await page.waitForSelector("#canvas-settings .canvas-row");
  // The settings call must carry the same-origin header: without it the server refuses.
  assert.equal(await page.evaluate(() => fetch("/api/scene/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }).then(r => r.status)), 403);
  await page.locator("#canvas-builtin").click();
  await page.waitForFunction(() => document.querySelectorAll("#canvas-widgets .canvas-row").length === 3);
  if (!(await page.locator("#canvas-save").isDisabled())) {
    await page.locator("#canvas-save").click();
    await page.waitForFunction(() => /Layout saved as version/.test(document.querySelector("#canvas-settings .canvas-status").textContent));
  }
  const start = await view(page);
  assert.deepEqual(start.layout.widgets.map(widget => widget.id).sort(), ["avatar", "backdrop", "cat"]);
  // The default circtime embed belongs to the log component.
  const backdropRow = rowOf(page, "backdrop");
  assert.equal(await backdropRow.locator("xpath=ancestor::section[1]").getAttribute("data-group"), "log");
  assert.match(await backdropRow.textContent(), /Embed.*circtime uptime radar.*0%, 0% · 100% × 100% of the log box.*Layer 0/);
  await page.waitForSelector(".canvas-preview .scene-log-back .scene-embed iframe");
  assert.equal(await page.locator(".canvas-preview .scene-log-back .scene-embed iframe").getAttribute("sandbox"), "allow-scripts");
  assert.equal(await page.locator(".canvas-preview .scene-log-back .scene-embed").evaluate(element => getComputedStyle(element).opacity), "0.3");
  await page.waitForFunction(() => document.querySelectorAll(".canvas-preview .scene-stage .scene-widget").length === 2);
  await page.locator("#canvas-settings").screenshot({ path: `${shots}/canvas-settings-dark.png` });
  assert.deepEqual(await audit(page), [], "dark theme design audit");

  // ---------- Add, edit (schema form + validator), preview ----------
  await page.locator("#canvas-add-type").selectOption("text");
  await page.locator("#canvas-add-btn").click();
  await page.waitForFunction(() => document.querySelectorAll("#canvas-widgets .canvas-row").length === 4);
  const added = await page.locator("#canvas-widgets .canvas-row.selected").getAttribute("data-widget-id");
  assert.match(added, /^w-[0-9a-f]{8}$/);
  assert.equal(await page.evaluate(() => document.activeElement.id), "canvas-geo-x", "the properties form takes focus");
  await page.locator("#canvas-field-text").fill("Canvas title");
  await page.waitForFunction(() => document.querySelector(".canvas-preview .scene-stage").innerText.includes("Canvas title"));
  assert.match(await page.locator(".canvas-summary").textContent(), /Unsaved changes/);
  await page.locator("#canvas-field-size").fill("500");
  await page.locator("#canvas-field-size").dispatchEvent("change");
  await page.waitForFunction(() => /Not valid yet: text field 'props.size' must be a whole number from 10 to 96/.test(document.querySelector("#canvas-editor .canvas-problem").textContent));
  assert.equal(await page.locator("#canvas-save").isDisabled(), true, "an invalid widget blocks Save");
  assert.equal(await rowOf(page, added).evaluate(element => element.classList.contains("invalid")), true);
  await page.locator("#canvas-field-size").fill("40");
  await page.locator("#canvas-field-color").selectOption("teal");
  await page.locator("#canvas-geo-x").fill("60");
  await page.locator("#canvas-geo-x").press("Enter");
  await page.waitForFunction(() => document.querySelector('.canvas-preview .scene-text[data-color="teal"]'));
  assert.equal(await page.locator("#canvas-save").isDisabled(), false);
  // Geometry is clamped into the stage on commit.
  await page.locator("#canvas-geo-w").fill("80");
  await page.locator("#canvas-geo-w").dispatchEvent("change");
  await page.waitForFunction(() => Number(document.querySelector("#canvas-geo-x").value) <= 20.1);
  await page.locator("#canvas-geo-w").fill("34");
  await page.locator("#canvas-geo-w").dispatchEvent("change");

  // ---------- Duplicate, delete, reorder, show/hide (keyboard) ----------
  await rowOf(page, added).locator('[data-action="duplicate"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#canvas-widgets .canvas-row").length === 5);
  const copy = await page.locator("#canvas-widgets .canvas-row.selected").getAttribute("data-widget-id");
  assert.notEqual(copy, added);
  await rowOf(page, copy).locator('[data-action="delete"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#canvas-widgets .canvas-row").length === 4);
  const stageOrder = () => page.locator('#canvas-widgets section[data-group="stage"] .canvas-row').evaluateAll(items => items.map(item => item.dataset.widgetId));
  assert.equal((await stageOrder())[0], added, "a new widget starts on the top layer");
  await rowOf(page, added).locator('[data-action="down"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(id => document.querySelector('#canvas-widgets section[data-group="stage"] .canvas-row:nth-child(2)')?.dataset.widgetId === id, added);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), "down", "focus stays on the moved row's control");
  await rowOf(page, added).locator('[data-action="up"]').click();
  await page.waitForFunction(id => document.querySelector('#canvas-widgets section[data-group="stage"] .canvas-row')?.dataset.widgetId === id, added);
  await rowOf(page, added).locator('input[role="switch"]').focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => !document.querySelector(".canvas-preview .scene-stage").innerText.includes("Canvas title"));
  assert.match(await page.locator(".canvas-preview-caption").textContent(), /1 hidden not shown/);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector(".canvas-preview .scene-stage").innerText.includes("Canvas title"));
  // Select with the keyboard: Enter on the row opens its form.
  await rowOf(page, "cat").locator(".canvas-row-main").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#canvas-editor-title").textContent.includes("cat"));
  await page.locator("#canvas-field-mirror").check();
  await page.waitForFunction(() => document.querySelector(".canvas-preview .scene-cat.mirrored"));

  // ---------- The embed's attachment target ----------
  await rowOf(page, "backdrop").locator(".canvas-row-main").click();
  await page.locator("#canvas-field-attach").selectOption("stage");
  await page.waitForSelector(".canvas-preview .scene-back .scene-embed");
  assert.equal(await page.locator(".canvas-preview .scene-log-back .scene-embed").count(), 0);
  assert.equal(await rowOf(page, "backdrop").locator("xpath=ancestor::section[1]").getAttribute("data-group"), "back");
  await page.locator("#canvas-field-attach").selectOption("log");
  await page.waitForSelector(".canvas-preview .scene-log-back .scene-embed");
  await page.locator("#canvas-field-theme").selectOption("light");
  await page.waitForFunction(() => new URL(document.querySelector(".canvas-preview .scene-log-back iframe").src).searchParams.get("theme") === "light");
  await page.locator("#canvas-field-theme").selectOption("system");

  // ---------- Save layout ----------
  await page.locator("#canvas-save").click();
  await page.waitForFunction(() => /Layout saved as version/.test(document.querySelector("#canvas-settings .canvas-status").textContent));
  const saved = await view(page);
  assert.equal(saved.layout.version, start.layout.version + 1);
  const savedTitle = saved.layout.widgets.find(widget => widget.id === added);
  assert.deepEqual([savedTitle.props.text, savedTitle.props.size, savedTitle.props.color, savedTitle.x], ["Canvas title", 40, "teal", 0.2], "x was clamped to 20% when the width grew to 80%");
  assert.equal(saved.layout.widgets.find(widget => widget.id === "cat").props.mirror, true);
  assert.deepEqual(saved.layout.widgets.find(widget => widget.id === "backdrop").props, { src: "/embed/circtime/", attach: "log", opacity: 0.3, theme: "system" });
  assert.match(await page.locator(".canvas-summary").textContent(), /Draft matches the saved layout/);
  assert.equal(saved.live, null);
  assert.equal(await page.locator("#canvas-apply").isDisabled(), true, "Apply needs a live stream");

  // ---------- Scene configuration ----------
  await page.locator("#canvas-allowlist").fill("https://img.example.com/stream");
  await page.locator("#canvas-default-opacity").fill("0.5");
  await page.locator("#canvas-refresh-minutes").selectOption("10");
  await page.locator("#canvas-default-source").selectOption("tokens.today");
  await page.locator("#canvas-config-save").click();
  await page.waitForFunction(() => /Configuration saved/.test(document.querySelector("#canvas-config + .canvas-status").textContent));
  const settings = (await json(page, "/api/scene/settings")).body;
  assert.deepEqual([settings.imageAllowlist, settings.defaults.embed.opacity, settings.metricRefresh, settings.defaults.metric.source, settings.embeds], [["https://img.example.com/stream/"], 0.5, { minutes: 10, cpa: true }, "tokens.today", ["/embed/circtime/"]]);
  assert.match(await page.evaluate(() => fetch("/").then(response => response.headers.get("content-security-policy"))), /img-src 'self' data: https:\/\/img\.example\.com;/);
  // Disabling the embed page asks first; cancelling keeps it.
  await page.locator("#canvas-embed-embed-circtime").uncheck();
  await page.locator("#canvas-config-save").click();
  await page.waitForSelector("#canvas-confirm[open]");
  assert.match(await page.locator("#canvas-confirm").textContent(), /1 widget uses it/);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => /Configuration not saved/.test(document.querySelector("#canvas-config + .canvas-status").textContent));
  assert.deepEqual((await json(page, "/api/scene/settings")).body.disabledEmbeds, []);
  await page.locator("#canvas-embed-embed-circtime").check();
  await page.screenshot({ path: `${shots}/canvas-settings-desktop-dark.png`, fullPage: true });

  // ---------- Apply to live stream: confirm, recorded, saved layout untouched ----------
  assert.equal((await json(page, "/api/broadcast/start", { method: "POST", body: JSON.stringify({ title: "Canvas settings stream" }) })).status, 201);
  await page.reload();
  await page.waitForSelector("#canvas-settings .canvas-row");
  await page.waitForFunction(() => /Stream live/.test(document.querySelector(".canvas-summary").textContent));
  const live = await view(page);
  assert.deepEqual(live.live.widgets.map(widget => widget.id).sort(), saved.layout.widgets.map(widget => widget.id).sort(), "the saved layout opened the stream");
  assert.equal(await page.locator("#canvas-apply").isDisabled(), true, "nothing to apply yet");
  await rowOf(page, added).locator(".canvas-row-main").click();
  await page.locator("#canvas-field-text").fill("Applied live");
  await rowOf(page, "avatar").locator('[data-action="delete"]').click();
  await page.locator(`label[for="canvas-preview-live"]`).click();
  await page.waitForFunction(() => document.querySelector(".canvas-preview").dataset.mode === "live" && document.querySelector(".canvas-preview .scene-avatar"));
  await page.locator(`label[for="canvas-preview-draft"]`).click();
  await page.waitForFunction(() => !document.querySelector(".canvas-preview .scene-avatar"));
  const eventsBefore = (await json(page, `/api/recordings/${live.live.recordingId}/events`)).body.events.filter(event => event.kind === "widget").length;
  await page.locator("#canvas-apply").click();
  await page.waitForSelector("#canvas-confirm[open]");
  assert.equal(await page.evaluate(() => document.activeElement.id), "canvas-confirm-cancel", "the confirmation focuses Cancel");
  assert.match(await page.locator("#canvas-confirm").textContent(), /recorded in the public recording: 1 changed, 1 removed/);
  await page.screenshot({ path: `${shots}/canvas-settings-apply-confirm.png` });
  await page.locator("#canvas-confirm-cancel").click();
  await page.waitForFunction(() => /Nothing was applied/.test(document.querySelector("#canvas-settings .canvas-status").textContent));
  await page.locator("#canvas-apply").click();
  await page.locator("#canvas-confirm-ok").click();
  await page.waitForFunction(() => /Applied 2 changes to the live stream/.test(document.querySelector("#canvas-settings .canvas-status").textContent), null, { timeout: 15000 });
  const applied = await view(page);
  assert.deepEqual(applied.live.widgets.map(widget => widget.id).sort(), saved.layout.widgets.map(widget => widget.id).filter(id => id !== "avatar").sort());
  assert.equal(applied.live.widgets.find(widget => widget.id === added).props.text, "Applied live");
  assert.equal(applied.layout.version, saved.layout.version, "Apply never changes the saved layout");
  assert.ok(applied.layout.widgets.some(widget => widget.id === "avatar"));
  const recorded = (await json(page, `/api/recordings/${live.live.recordingId}/events`)).body.events.filter(event => event.kind === "widget");
  assert.deepEqual(recorded.slice(eventsBefore).map(event => `${event.op}:${event.target}:${event.source}`), [`delete:avatar:admin`, `update:${added}:admin`], "recorded as widget events, like the on-stage editor");
  assert.equal(await page.locator("#canvas-apply").isDisabled(), true, "the live scene matches the draft");
  assert.match(await page.locator(".canvas-summary").textContent(), /Unsaved changes/);
  // The Live page shows the applied change.
  const viewer = await open(admin, "/#live");
  await viewer.waitForSelector(".scene-stage >> text=Applied live");
  await viewer.close();
  assert.equal((await json(page, "/api/broadcast/end", { method: "POST", body: "{}" })).status, 200);
  await page.locator("#canvas-revert").click();

  // ---------- Light theme and 390 px ----------
  await page.evaluate(() => globalThis.dashboardTheme.set("light"));
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.locator("#canvas-settings").screenshot({ path: `${shots}/canvas-settings-light.png` });
  assert.deepEqual(await audit(page), [], "light theme design audit");
  for (const theme of ["light", "dark"]) {
    const mobile = await context(process.env.DASHBOARD_TEST_COOKIE, { width: 390, height: 844, colorScheme: theme });
    const phone = await open(mobile, "/#settings");
    await phone.evaluate(value => globalThis.dashboardTheme.set(value), theme);
    await phone.waitForSelector("#canvas-settings .canvas-row");
    await phone.waitForFunction(() => document.querySelector(".canvas-preview .scene-stage .scene-widget"));
    assert.ok(await noOverflow(phone), `no horizontal scrolling at 390 px (${theme})`);
    const box = await phone.locator("#canvas-settings").boundingBox();
    assert.ok(box.width <= 390, "the section fits the phone width");
    for (const id of ["#canvas-save", "#canvas-apply", "#canvas-add-btn"]) {
      const target = await phone.locator(id).boundingBox();
      assert.ok(target.height >= 32 && target.x >= 0 && target.x + target.width <= 390, `${id} is a usable target`);
    }
    await phone.locator(`#canvas-widgets .canvas-row[data-widget-id="${added}"] .canvas-row-main`).click();
    assert.ok(await noOverflow(phone), "the properties form fits too");
    assert.deepEqual(await audit(phone), [], `390 px ${theme} design audit`);
    await phone.screenshot({ path: `${shots}/canvas-settings-390-${theme}.png`, fullPage: true });
    await cspOf(phone);
    await mobile.close();
  }
  await cspOf(page);
  await admin.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(csp, [], "no Content-Security-Policy violations");
  console.info("Canvas Chromium passed: admin-only (guest/member hidden and refused), widget list add/edit/validate/duplicate/delete/reorder/show-hide with keyboard, live preview, log-component vs. stage embed attachment and theme, Save layout (versioned), scene configuration (allowlist, enabled embeds with confirmation, embed/metric defaults, refresh), Apply to live stream with confirmation recorded as widget events without touching the saved layout, light/dark, 390 px in both themes, zero CSP violations.");
} finally { await browser.close(); }
