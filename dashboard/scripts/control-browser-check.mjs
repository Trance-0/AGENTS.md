// Chromium check for OpenClaw live control (0.2.5): title and description
// changes over the stream-controller API, widget move/hide/show and a forced
// avatar expression, administrator chat removal (gone for every viewer and in
// replay, with a content-free moderation line kept), and the public usage line
// after a host reply. Spawned by server/auth.test.js with DASHBOARD_BROWSER_CHECK=1.
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
const baseURL = process.env.DASHBOARD_TEST_URL;
const shots = process.env.DASHBOARD_SCREENSHOT_DIR || "/tmp";
const streamToken = process.env.DASHBOARD_STREAM_TOKEN;
const errors = [];

async function context(cookie) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-proto": "https" } });
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
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/#live");
  await page.waitForSelector("#stream-title");
  return page;
}
const openclaw = async (method, path, body) => {
  const response = await fetch(baseURL + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${streamToken}`, "x-forwarded-proto": "https" }, body: JSON.stringify(body) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${data.error}`);
  return data;
};
const logHas = (page, text) => page.waitForFunction(value => [...document.querySelectorAll("#stream-log .log-line")].some(line => line.textContent.includes(value)), text);

try {
  const admin = await context(process.env.DASHBOARD_TEST_COOKIE);
  const page = await open(admin);
  await page.locator("#broadcast-title").fill("Control verification stream");
  await page.locator("#btn-start").click();
  await page.waitForFunction(() => document.querySelector("#live-label").textContent === "LIVE");
  const guest = await context(undefined);
  const viewer = await open(guest);
  await viewer.waitForFunction(() => document.querySelector("#live-label").textContent === "LIVE");
  const recordingId = (await page.evaluate(() => fetch("/api/broadcast").then(r => r.json()))).stream.id;
  // The owner agent on an administrator-started stream (decision 8).
  const ids = { recordingId, sessionRef: "c".repeat(64), agentId: "main" };

  // Title and description: live for every viewer.
  await openclaw("POST", "/api/openclaw/stream/title", { ...ids, title: "Renamed by OpenClaw" });
  await openclaw("POST", "/api/openclaw/stream/summary", { ...ids, summary: "Description set by OpenClaw" });
  await viewer.waitForFunction(() => document.querySelector("#stream-title").textContent === "Renamed by OpenClaw" && document.querySelector("#stream-summary").textContent === "Description set by OpenClaw");
  await logHas(viewer, "Stream title updated");

  // Widgets: create, move, hide (gone for guests, dimmed in the editor), show; avatar override.
  const { widget } = await openclaw("POST", "/api/openclaw/scene/widgets", { ...ids, widget: { type: "text", x: 0.05, y: 0.6, w: 0.3, h: 0.1, props: { text: "OpenClaw widget" } } });
  const selector = `.scene-stage [data-widget-id="${widget.id}"]`;
  await viewer.waitForSelector(selector);
  const x1 = (await viewer.locator(selector).boundingBox()).x;
  await openclaw("PATCH", `/api/openclaw/scene/widgets/${widget.id}`, { ...ids, changes: { x: 0.4 } });
  await viewer.waitForFunction(([sel, x]) => document.querySelector(sel).getBoundingClientRect().x > x + 100, [selector, x1]);
  await openclaw("PATCH", `/api/openclaw/scene/widgets/${widget.id}`, { ...ids, changes: { hidden: true } });
  await viewer.waitForFunction(sel => getComputedStyle(document.querySelector(sel)).display === "none", selector);
  await logHas(viewer, "Scene text widget hidden");
  await page.locator("#btn-edit-scene").click();
  await page.waitForFunction(sel => document.querySelector(sel)?.classList.contains("scene-hidden") && getComputedStyle(document.querySelector(sel)).display !== "none", selector);
  await page.screenshot({ path: `${shots}/control-editor-hidden-widget.png` });
  await page.locator("#btn-scene-done").click();
  await openclaw("PATCH", `/api/openclaw/scene/widgets/${widget.id}`, { ...ids, changes: { hidden: false } });
  await viewer.waitForFunction(sel => getComputedStyle(document.querySelector(sel)).display !== "none", selector);
  await openclaw("POST", "/api/openclaw/scene/avatar", { ...ids, expression: "sleepy", seconds: 30 });
  await viewer.waitForFunction(() => document.querySelector(".scene-avatar").dataset.expression === "sleepy");
  await logHas(viewer, "Avatar expression set");

  // Chat, the host reply, and the usage line after it.
  await page.locator("#chat-input").fill("Test chat to remove");
  await page.locator("#chat-send").click();
  await viewer.waitForFunction(() => [...document.querySelectorAll("#chat-messages .chat-message")].some(line => line.textContent.includes("Test chat to remove")));
  await logHas(viewer, "Welcome to the stream!");
  await logHas(viewer, "Usage after reply: dashboard/usage — ");
  assert.equal(await viewer.locator(".chat-remove").count(), 0, "guests get no moderation buttons");
  await viewer.screenshot({ path: `${shots}/control-live-guest.png` });
  const remove = page.locator(".chat-message", { hasText: "Test chat to remove" }).locator(".chat-remove");
  await remove.click();
  for (const target of [page, viewer]) await target.waitForFunction(() => ![...document.querySelectorAll("#chat-messages .chat-message")].some(line => line.textContent.includes("Test chat to remove")));
  await logHas(viewer, "Chat message removed: dashboard/live chat moderation — an administrator removed message #");
  await page.screenshot({ path: `${shots}/control-live-admin-after-removal.png` });

  await page.locator("#btn-end").click();
  await page.waitForFunction(() => document.querySelector("#live-label").textContent === "REPLAY");
  const recorded = (await page.evaluate(id => fetch(`/api/recordings/${id}/events`).then(r => r.json()), recordingId)).events;
  assert.ok(!JSON.stringify(recorded).includes("Test chat to remove"), "the removed text is gone from the recording");
  assert.ok(recorded.some(event => event.moderation?.op === "chat_delete" && event.moderation.actor === "admin"));
  // A fresh guest replay: renamed title, no removed chat, moderation line kept.
  const late = await context(undefined);
  const replay = await open(late);
  await replay.locator(".rec-card", { hasText: "Renamed by OpenClaw" }).first().click();
  await replay.waitForFunction(() => document.querySelector("#live-label").textContent === "REPLAY");
  await replay.locator("#btn-play").click();
  const bar = await replay.locator("#progress-bar").boundingBox();
  await replay.mouse.click(bar.x + bar.width - 1, bar.y + bar.height / 2);
  await logHas(replay, "Chat message removed");
  assert.equal(await replay.locator("#chat-messages .chat-message", { hasText: "Test chat to remove" }).count(), 0);
  await replay.screenshot({ path: `${shots}/control-replay-guest.png` });
  for (const target of [page, viewer, replay]) assert.deepEqual(await target.evaluate(() => window.__csp || []), [], "no CSP violations");
  await Promise.all([admin.close(), guest.close(), late.close()]);
  assert.deepEqual(errors, []);
  console.info("Control Chromium passed: OpenClaw title and description, widget create/move/hide/show (dimmed in the editor), forced avatar expression, host reply with the usage line, administrator chat removal for every viewer and in replay with a content-free moderation line, zero CSP violations.");
} finally { await browser.close(); }
