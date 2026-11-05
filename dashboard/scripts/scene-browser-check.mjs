// Chromium check for the stream scene: admin canvas editor (draw, left-click
// menu actions, drag, keyboard, undo), saved-layout vs. live recording of
// edits, replay of edits at seek times and at 2x, avatar expressions driven by
// recorded OpenClaw activity (including sleepy on the paid fallback), the cat
// widget, guest read-only rendering, and zero CSP violations. Spawned by
// server/auth.test.js with DASHBOARD_BROWSER_CHECK=1.
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
const baseURL = process.env.DASHBOARD_TEST_URL;
const shots = process.env.DASHBOARD_SCREENSHOT_DIR || "/tmp";
const streamToken = process.env.DASHBOARD_STREAM_TOKEN;
const errors = [];
const csp = [];

async function context(cookie, { width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ baseURL, viewport: { width, height }, extraHTTPHeaders: { "x-forwarded-proto": "https" } });
  if (cookie) { const [name, ...rest] = cookie.split("="); await ctx.addCookies([{ name, value: rest.join("="), url: baseURL, httpOnly: true, sameSite: "Lax" }]); }
  await ctx.route("**/api/**", async route => {
    if (route.request().method() === "GET") return route.continue();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: "https://live.example.test" } });
    await route.fulfill({ response });
  });
  await ctx.addInitScript(() => document.addEventListener("securitypolicyviolation", event => { (window.__csp ||= []).push(`${event.violatedDirective} ${event.blockedURI}`); }));
  return ctx;
}
async function open(ctx) {
  const page = await ctx.newPage();
  page.on("pageerror", error => errors.push(`${error.message} ${(error.stack || "").split("\n").slice(1, 3).join(" ").trim()}`));
  page.on("console", message => { if (/Content Security Policy/i.test(message.text())) csp.push(message.text()); });
  await page.goto("/#live");
  await page.waitForSelector("#stream-title");
  return page;
}
const cspOf = async page => csp.push(...(await page.evaluate(() => window.__csp || [])));
const stageBox = page => page.locator(".scene-stage").boundingBox();
const at = async (page, fx, fy) => { const box = await stageBox(page); return [box.x + box.width * fx, box.y + box.height * fy]; };
const drag = async (page, [x1, y1], [x2, y2]) => { await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 }); await page.mouse.move(x2, y2, { steps: 4 }); await page.mouse.up(); };
const widgetCount = page => page.locator(".scene-stage .scene-widget").count();
const layout = page => page.evaluate(() => fetch("/api/scene/layout").then(response => response.json()));
const byText = (page, text) => page.locator(".scene-widget", { hasText: text });
const clickWidget = async (page, text) => { const box = await byText(page, text).first().boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.waitForSelector(".scene-menu"); };
const menu = (page, action) => page.locator(`.scene-menu [data-action="${action}"]`).click();
async function seek(page, seconds) {
  const bar = await page.locator("#progress-bar").boundingBox();
  const duration = Number(await page.locator("#progress-bar").getAttribute("aria-valuemax")) || 1;
  await page.mouse.click(bar.x + bar.width * Math.min(1, seconds / duration), bar.y + bar.height / 2);
  await page.waitForTimeout(150);
}
const openclaw = (path, body) => fetch(baseURL + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${streamToken}`, "x-forwarded-proto": "https" }, body: JSON.stringify(body) });

try {
  const admin = await context(process.env.DASHBOARD_TEST_COOKIE);
  const page = await open(admin);
  // Offline with nothing loaded the stage is empty: scenes come only from recorded events.
  assert.equal(await widgetCount(page), 0, "no recording, no scene");
  await page.locator("#btn-edit-scene").click();
  await page.waitForSelector(".scene-stage .scene-avatar");
  assert.equal(await widgetCount(page), 3, "built-in layout: embed backdrop, avatar, and cat");
  const cat = await page.locator(".scene-cat").boundingBox(), stage = await stageBox(page);
  assert.ok(cat.x + cat.width > stage.x + stage.width * 0.9 && cat.y + cat.height > stage.y + stage.height * 0.85, "cat sits lower-right");
  const avatarBox = await page.locator(".scene-avatar").boundingBox();
  assert.ok(Math.abs(avatarBox.width - avatarBox.height) <= 2, "avatar widget is 1:1");
  assert.ok(await page.locator(".scene-cat canvas").evaluate(canvas => { const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data; let painted = 0; for (let i = 3; i < data.length; i += 4) if (data[i]) painted++; return painted > data.length / 40; }), "the cat is drawn on its canvas");
  await page.waitForFunction(() => { const canvas = document.querySelector(".scene-avatar canvas"); const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data; return data.some((value, index) => index % 4 === 3 && value > 0); });

  // ---------- Offline: edits change the saved layout ----------
  await page.waitForFunction(() => document.querySelector("#scene-mode").textContent.includes("saved default layout"));
  assert.equal(await page.locator("#player-chrome").isVisible(), false, "player controls step aside while editing");
  await drag(page, await at(page, 0.06, 0.08), await at(page, 0.42, 0.2));
  await page.waitForSelector('.scene-menu [data-action="add-text"]');
  await page.screenshot({ path: `${shots}/scene-editor-add-menu.png` });
  await page.locator('.scene-menu [data-action="add-text"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".scene-stage .scene-widget").length === 4);
  assert.equal((await layout(page)).layout.version, 1, "drawing a widget saves the layout");
  await clickWidget(page, "Hello from the stream");
  assert.deepEqual(await page.locator(".scene-menu [role=menuitem]").allTextContents(), ["Edit properties…", "Create new…", "Duplicate", "Bring forward", "Send back", "Delete"]);
  await menu(page, "edit");
  await page.locator("#scene-field-text").fill("Scene check title");
  await page.locator("#scene-field-size").fill("40");
  await page.locator("#scene-field-color").selectOption("cream");
  await page.screenshot({ path: `${shots}/scene-editor-properties.png` });
  await page.locator(".scene-form button[type=submit]").click();
  await page.waitForSelector('.scene-widget[data-color="cream"] >> text=Scene check title');
  const title = (await layout(page)).layout.widgets.find(widget => widget.props.text === "Scene check title");
  assert.equal(title.props.size, 40);
  // Invalid input is rejected in the form with the validator's reason.
  await clickWidget(page, "Scene check title");
  await menu(page, "edit");
  await page.locator("#scene-field-size").fill("500");
  await page.locator(".scene-form button[type=submit]").click();
  assert.match(await page.locator(".scene-form-status").textContent(), /^Widget not saved: dashboard\/scene editor — text field 'props.size' must be a whole number from 10 to 96\.$/);
  await page.keyboard.press("Escape");
  await clickWidget(page, "Scene check title");
  await menu(page, "duplicate");
  await page.waitForFunction(() => document.querySelectorAll(".scene-stage .scene-widget").length === 5);
  const duplicate = (await layout(page)).layout.widgets.filter(widget => widget.props.text === "Scene check title").find(widget => widget.id !== title.id);
  await page.locator(`.scene-widget[data-widget-id="${duplicate.id}"]`).click();
  await page.waitForSelector(".scene-menu");
  await menu(page, "back");
  await page.waitForFunction(id => document.querySelector(`[data-widget-id="${id}"]`).style.zIndex === "0", duplicate.id);
  // Now behind the original: click the corner the original does not cover.
  const behind = await page.locator(`.scene-widget[data-widget-id="${duplicate.id}"]`).boundingBox();
  await page.mouse.click(behind.x + behind.width - 20, behind.y + behind.height - 6);
  await page.waitForSelector(".scene-menu");
  await menu(page, "forward");
  await page.waitForFunction(id => Number(document.querySelector(`[data-widget-id="${id}"]`).style.zIndex) > 102, duplicate.id);
  const zs = Object.fromEntries((await layout(page)).layout.widgets.map(widget => [widget.id, widget.z]));
  assert.ok(Object.entries(zs).every(([id, z]) => id === duplicate.id || z < zs[duplicate.id]), "bring forward puts it on top");
  // Keyboard: Delete removes the focused widget, Ctrl+Z restores it, the menu deletes it again.
  await page.locator(`.scene-widget[data-widget-id="${duplicate.id}"]`).focus();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll(".scene-stage .scene-widget").length === 4);
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => document.querySelectorAll(".scene-stage .scene-widget").length === 5);
  await page.locator(`.scene-widget[data-widget-id="${duplicate.id}"]`).click();
  await menu(page, "delete");
  await page.waitForFunction(() => document.querySelectorAll(".scene-stage .scene-widget").length === 4);
  // Drag to move, corner handle to resize, arrows to nudge.
  const before = (await layout(page)).layout.widgets.find(widget => widget.id === title.id);
  const titleBox = await byText(page, "Scene check title").boundingBox();
  await drag(page, [titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2], [titleBox.x + titleBox.width / 2 + stage.width * 0.1, titleBox.y + titleBox.height / 2 + stage.height * 0.1]);
  await page.waitForFunction(([id, x]) => fetch("/api/scene/layout").then(r => r.json()).then(view => view.layout.widgets.find(widget => widget.id === id).x > x + 0.08), [title.id, before.x]);
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  await clickWidget(page, "Scene check title");
  await page.keyboard.press("Escape");
  const handle = await page.locator(`[data-widget-id="${title.id}"] .scene-handle.se`).boundingBox();
  await drag(page, [handle.x + 6, handle.y + 6], [handle.x + 6 + stage.width * 0.05, handle.y + 6 + stage.height * 0.05]);
  await page.waitForFunction(([id, w]) => fetch("/api/scene/layout").then(r => r.json()).then(view => view.layout.widgets.find(widget => widget.id === id).w > w + 0.04), [title.id, before.w]);
  const moved = (await layout(page)).layout.widgets.find(widget => widget.id === title.id);
  await page.locator(`.scene-widget[data-widget-id="${title.id}"]`).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(([id, x]) => fetch("/api/scene/layout").then(r => r.json()).then(view => Math.abs(view.layout.widgets.find(widget => widget.id === id).x - (x - 0.03)) < 0.002), [title.id, moved.x]);
  await page.screenshot({ path: `${shots}/scene-editor-selected.png` });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#btn-edit-scene").getAttribute("aria-pressed"), "false", "Esc exits the editor");
  assert.equal(await page.locator(".scene-stage").evaluate(element => getComputedStyle(element).pointerEvents), "none");

  // ---------- Live: the saved layout opens the stream; edits are recorded ----------
  await page.locator("#broadcast-title").fill("Scene verification stream");
  await page.locator("#btn-start").click();
  await page.waitForFunction(() => document.querySelector("#live-label").textContent === "LIVE");
  await page.waitForSelector(".scene-stage >> text=Scene check title");
  const recordingId = (await page.evaluate(() => fetch("/api/broadcast").then(r => r.json()))).stream.id;
  // The embed backdrop: sandboxed same-origin page on the back layer, behind the log.
  const frame = page.locator(".scene-back .scene-embed iframe");
  await frame.waitFor({ state: "attached" });
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts", "no allow-same-origin");
  assert.match(await frame.getAttribute("src"), /^\/embed\/circtime\/\?theme=(dark|light)&preference=/);
  const layers = await page.evaluate(() => ({ back: getComputedStyle(document.querySelector(".scene-back")).zIndex, log: getComputedStyle(document.querySelector("#stream-log")).zIndex, events: getComputedStyle(document.querySelector(".scene-back iframe")).pointerEvents, opacity: getComputedStyle(document.querySelector(".scene-back .scene-embed")).opacity, box: document.querySelector(".scene-back .scene-embed").getBoundingClientRect().width / document.querySelector(".scene-stage").getBoundingClientRect().width }));
  assert.deepEqual(layers, { back: "0", log: "1", events: "none", opacity: "0.3", box: 1 }, "full stage, behind the log, faint, never interactive");
  const embedded = () => page.frames().find(item => item.url().includes("/embed/circtime/"));
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && !(await embedded()?.evaluate(() => document.documentElement.dataset.loadedAt).catch(() => null)); i++) await page.waitForTimeout(100);
  const themeNow = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.equal(await embedded().evaluate(() => document.documentElement.dataset.theme), themeNow, "the embed receives the dashboard theme");
  const loadedAt = await embedded().evaluate(() => document.documentElement.dataset.loadedAt);
  await page.locator("#theme-toggle").click();
  await page.waitForFunction(() => document.documentElement.dataset.theme !== "");
  const themeNext = await page.evaluate(() => document.documentElement.dataset.theme);
  for (let i = 0; i < 30 && (await embedded().evaluate(() => document.documentElement.dataset.theme)) !== themeNext; i++) await page.waitForTimeout(100);
  assert.equal(await embedded().evaluate(() => document.documentElement.dataset.theme), themeNext, "theme changes arrive by postMessage");
  assert.equal(await embedded().evaluate(() => document.documentElement.dataset.loadedAt), loadedAt, "without reloading the embed");
  await page.evaluate(() => globalThis.dashboardTheme.set("system"));
  // Log text over the embed stays selectable and copyable; pointer input never lands in the frame.
  const line = page.locator("#stream-log .log-line .msg").first();
  const lineBox = await line.boundingBox();
  assert.notEqual(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [lineBox.x + 5, lineBox.y + lineBox.height / 2]), "IFRAME");
  await page.mouse.move(lineBox.x + 1, lineBox.y + lineBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lineBox.x + Math.min(lineBox.width, 300), lineBox.y + lineBox.height / 2, { steps: 5 });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection().toString());
  assert.ok(selected.length > 5 && (await line.textContent()).startsWith(selected.trim().slice(0, 5)), `log text over the embed is selectable (got "${selected}")`);
  const copied = await page.evaluate(() => { let data = ""; const listener = event => { data = getSelection().toString(); }; document.addEventListener("copy", listener); document.execCommand("copy"); document.removeEventListener("copy", listener); return data; });
  assert.equal(copied, selected, "copy carries the selected log text");
  await page.screenshot({ path: `${shots}/scene-embed-backdrop.png` });
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForTimeout(500);
  await page.locator("#btn-edit-scene").click();
  await page.waitForFunction(() => document.querySelector("#scene-mode").textContent.includes("live scene"));
  await drag(page, await at(page, 0.06, 0.4), await at(page, 0.36, 0.52));
  await page.locator('.scene-menu [data-action="add-text"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".scene-stage .scene-widget").length === 5);
  const liveWidget = (await layout(page)).live.widgets.find(widget => !["avatar", "cat", "backdrop", title.id].includes(widget.id));
  await clickWidget(page, "Hello from the stream");
  await menu(page, "edit");
  await page.locator("#scene-field-text").fill("Live widget");
  await page.locator(".scene-form button[type=submit]").click();
  await page.waitForSelector(".scene-stage >> text=Live widget");
  await page.waitForTimeout(2000);
  const liveBox = await byText(page, "Live widget").boundingBox();
  await drag(page, [liveBox.x + 20, liveBox.y + 10], [liveBox.x + 20 + stage.width * 0.3, liveBox.y + 10]);
  await page.waitForFunction(id => fetch("/api/scene/layout").then(r => r.json()).then(view => view.live.widgets.find(widget => widget.id === id).x > 0.3), liveWidget.id);
  await page.locator("#btn-scene-done").click();

  // Recorded OpenClaw activity drives the avatar and the cat.
  const event = (type, extra = {}) => openclaw("/api/openclaw/events", { recordingId, type, agentId: "main", sessionRef: "c".repeat(64), eventId: `scene-${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`, ...extra });
  const expression = () => page.locator(".scene-avatar").getAttribute("data-expression");
  assert.equal((await event("model_start", { model: "gpt-6-astra", provider: "cpa" })).status, 201);
  await page.waitForFunction(() => document.querySelector(".scene-avatar").dataset.expression === "think");
  assert.equal(await page.locator(".scene-cat").getAttribute("data-pose"), "typing", "the cat types while the host thinks");
  await event("tool_start", { toolName: "read" });
  await page.waitForFunction(() => document.querySelector(".scene-cat").dataset.pose === "tap");
  await page.screenshot({ path: `${shots}/scene-live-think.png` });
  await event("tool_end", { toolName: "read" });
  await event("model_output", { model: "gpt-6-astra", provider: "cpa" });
  await page.waitForFunction(() => document.querySelector(".scene-avatar").dataset.expression === "talk");
  await page.waitForFunction(() => ["idle", "blink"].includes(document.querySelector(".scene-avatar").dataset.expression), null, { timeout: 4000 });
  await page.waitForTimeout(1500);
  await event("model_output", { model: "gpt-6-astra", provider: "openai" });
  await page.waitForFunction(() => document.querySelector(".scene-avatar").dataset.expression === "sleepy");
  await page.screenshot({ path: `${shots}/scene-live-sleepy.png` });
  await page.waitForTimeout(1200);
  await event("model_output", { model: "gpt-6-astra", provider: "cpa" });
  await page.waitForFunction(() => document.querySelector(".scene-avatar").dataset.expression !== "sleepy", null, { timeout: 4000 });
  await page.waitForTimeout(800);
  await page.locator("#btn-end").click();
  await page.waitForFunction(() => document.querySelector("#live-label").textContent === "REPLAY");
  assert.ok((await layout(page)).layout.widgets.some(widget => widget.props.text === "Live widget"), "live admin edits also update the saved layout");

  // ---------- Replay: seek times and 2x speed reproduce the recorded edits ----------
  const recorded = (await page.evaluate(id => fetch(`/api/recordings/${id}/events`).then(r => r.json()), recordingId)).events;
  const created = recorded.find(item => item.kind === "widget" && item.op === "create" && item.target === liveWidget.id);
  const renamed = recorded.find(item => item.kind === "widget" && item.op === "update" && item.target === liveWidget.id && item.data.widget.props.text === "Live widget");
  const movedEvent = recorded.filter(item => item.kind === "widget" && item.op === "update" && item.target === liveWidget.id).at(-1);
  const sleepyAt = recorded.find(item => item.openclawEvent === "model_output" && item.provider === "openai").t;
  assert.ok(created && renamed && movedEvent.t - renamed.t >= 1.5, "edits are recorded as widget events with their own times");
  assert.ok(!recorded.some(item => item.kind === "widget" && item.op === "metrics"), "no metric events without metric widgets");
  const guest = await context(undefined);
  const viewer = await open(guest);
  await viewer.locator(".rec-card", { hasText: "Scene verification stream" }).first().click();
  await viewer.waitForFunction(() => document.querySelector("#live-label").textContent === "REPLAY");
  assert.equal(await viewer.locator("#btn-edit-scene").isVisible(), false, "guests get no editor");
  await seek(viewer, Math.max(0, created.t - 0.6));
  assert.equal(await byText(viewer, "Live widget").count(), 0, "before the edit the widget is absent");
  assert.equal(await byText(viewer, "Scene check title").count(), 1, "the opening layout is present from the start");
  await seek(viewer, renamed.t + (movedEvent.t - renamed.t) / 2);
  await viewer.waitForSelector(".scene-stage >> text=Live widget");
  const x1 = (await byText(viewer, "Live widget").boundingBox()).x;
  await seek(viewer, movedEvent.t + 0.5);
  await viewer.waitForFunction(x => document.querySelector(".scene-stage .scene-widget:not(.scene-avatar):not(.scene-cat)") && [...document.querySelectorAll(".scene-widget")].find(element => element.textContent.includes("Live widget")).getBoundingClientRect().x > x + 100, x1);
  await seek(viewer, sleepyAt + 0.3);
  await viewer.waitForFunction(() => document.querySelector(".scene-avatar").dataset.expression === "sleepy");
  await viewer.screenshot({ path: `${shots}/scene-guest-replay-sleepy.png` });
  assert.equal(await viewer.locator(".scene-stage").evaluate(element => getComputedStyle(element).pointerEvents), "none", "guest stage is read-only");
  // 2x: from 2 s before the creation, the widget appears after about 1 s of wall time.
  await viewer.locator("#player").hover();
  await viewer.locator("#btn-speed").click();
  await viewer.locator('#speed-menu [data-rate="2"]').click();
  const start = Math.max(0, created.t - 2);
  await seek(viewer, start);
  await viewer.waitForFunction(() => ![...document.querySelectorAll(".scene-widget")].some(element => /Live widget|Hello from the stream/.test(element.textContent)));
  const began = Date.now();
  await viewer.locator("#btn-play").click();
  await viewer.waitForSelector(".scene-stage .scene-text:not(:has-text('Scene check title'))", { timeout: 6000 });
  const wall = (Date.now() - began) / 1000;
  const expected = (created.t - start) / 2;
  assert.ok(wall >= expected - 0.4 && wall <= expected + 0.9, `2x replay showed the created widget after ${wall}s (expected about ${expected}s)`);
  await viewer.locator("#btn-play").click();
  await viewer.setViewportSize({ width: 390, height: 844 });
  await viewer.waitForTimeout(300);
  await viewer.screenshot({ path: `${shots}/scene-guest-mobile.png` });
  const mobileStage = await stageBox(viewer), mobileCat = await viewer.locator(".scene-cat").boundingBox();
  assert.ok(mobileCat.x + mobileCat.width <= mobileStage.x + mobileStage.width + 1, "widgets scale with the stage at 390 px");
  await cspOf(viewer);
  await guest.close();

  // Theater mode keeps the 16:9 stage; settings expose the scene defaults.
  await page.locator("#btn-theater").click();
  await page.waitForTimeout(300);
  const theater = await stageBox(page);
  assert.ok(Math.abs(theater.width / theater.height - 16 / 9) < 0.02, "the stage stays 16:9 in theater mode");
  await page.screenshot({ path: `${shots}/scene-admin-theater.png` });
  await page.locator("#btn-theater").click();
  await page.locator('[data-view="settings"]').click();
  await page.waitForSelector("#scene-defaults");
  await page.locator("#scene-allowlist").fill("https://img.example.com/stream");
  await page.locator("#scene-defaults button", { hasText: "Save allowlist" }).click();
  await page.waitForFunction(() => document.querySelector("#scene-allowlist").value === "https://img.example.com/stream/");
  const policy = await page.evaluate(() => fetch("/").then(response => response.headers.get("content-security-policy")));
  assert.match(policy, /img-src 'self' data: https:\/\/img\.example\.com;/);
  await page.screenshot({ path: `${shots}/scene-settings-defaults.png`, fullPage: true });
  await page.locator("#scene-defaults button", { hasText: "Reset to built-in" }).click();
  await page.waitForFunction(() => document.querySelector("#scene-defaults").textContent.includes("3 widgets"));
  await cspOf(page);
  await admin.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(csp, [], "no Content-Security-Policy violations");
  console.info("Scene Chromium passed: draw a widget, left-click menu (edit/create/duplicate/z-order/delete), drag/resize/nudge/undo/Esc, saved layout opens the stream, live edits recorded, replay at seek times and 2x, avatar think/talk/sleepy and cat paws from recorded activity, sandboxed embed backdrop behind selectable log text with theme hand-off, guest read-only, 16:9 stage in theater and at 390 px, allowlist and CSP, zero CSP violations.");
} finally { await browser.close(); }
