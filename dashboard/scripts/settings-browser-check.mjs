import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
const baseURL = process.env.DASHBOARD_TEST_URL;
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, colorScheme: "light", extraHTTPHeaders: { "x-forwarded-proto": "https" } });
const [name, ...rest] = process.env.DASHBOARD_TEST_COOKIE.split("=");
await context.addCookies([{ name, value: rest.join("="), url: baseURL, httpOnly: true, sameSite: "Lax" }]);
let jobs = [{ id: "daily", name: "Morning briefing", enabled: true, agentId: "main", description: "Your daily update", schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Los_Angeles", staggerMs: 0 }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "Summarize my priorities for today.", model: "cpa/gpt-6-astra", lightContext: true }, delivery: { mode: "announce", channel: "telegram", to: "fixture-owner" }, state: { lastRunStatus: "ok", nextRunAtMs: Date.now() + 86400000 }, hash: "first" }, { id: "paused", name: "Weekly review", enabled: false, schedule: { kind: "every", everyMs: 604800000, anchorMs: 1700000000000 }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "Review this week." }, delivery: { mode: "none" }, state: {}, hash: "paused" }];
const saved = [];
await context.route("**/api/**", async route => {
  const request = route.request();
  if (new URL(request.url()).pathname.startsWith("/api/admin/openclaw-tasks")) {
    if (request.method() === "GET") return route.fulfill({ json: { jobs } });
    const data = request.postDataJSON(); saved.push(data);
    if (request.method() === "PUT") { jobs[0] = { ...jobs[0], ...data.task, hash: "second" }; return route.fulfill({ json: jobs[0] }); }
    if (request.method() === "POST") { const job = { ...data.task, id: "new", hash: "new", state: {} }; jobs.push(job); return route.fulfill({ json: job }); }
    return route.fulfill({ json: { removed: true } });
  }
  if (request.method() === "GET") return route.continue();
  const response = await route.fetch({ headers: { ...request.headers(), origin: "https://live.example.test" } }); await route.fulfill({ response });
});
const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
const shots = process.env.DASHBOARD_SCREENSHOT_DIR || "/tmp";
try {
  await page.goto("/#openclaw/openclaw-config");
  await page.getByRole("navigation", { name: "Configuration sections" }).waitFor();
  assert.equal(await page.locator(".config-text").isVisible(), false);
  await page.getByLabel("Primary model", { exact: true }).fill("openai/gpt-6-astra");
  await page.getByRole("tab", { name: "JSON", exact: true }).click();
  assert.equal(JSON.parse(await page.getByLabel("OpenClaw JSON configuration").inputValue()).agents.defaults.model.primary, "openai/gpt-6-astra");
  await page.getByRole("tab", { name: "UI editor", exact: true }).click();
  assert.equal(await page.getByLabel("Primary model", { exact: true }).inputValue(), "openai/gpt-6-astra");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".editor-status")?.textContent.includes("Saved"));
  await page.getByRole("navigation", { name: "Configuration sections" }).getByRole("button", { name: "Connected channels" }).click();
  assert.equal(await page.getByLabel("Bot token", { exact: true }).inputValue(), "");
  await page.screenshot({ path: `${shots}/settings-configuration-light.png`, fullPage: true });
  await page.getByRole("tab", { name: "Scheduled tasks", exact: true }).click();
  await page.getByLabel("Prompt", { exact: true }).waitFor();
  assert.equal(await page.locator(".task-list-item").count(), 2);
  assert.equal(await page.getByLabel("Repeat", { exact: true }).inputValue(), "daily");
  assert.equal(await page.getByLabel("Time of day").inputValue(), "09:00");
  await page.getByLabel("Prompt", { exact: true }).fill("Prepare a concise morning briefing.");
  await page.getByLabel("Model", { exact: true }).fill("openai/gpt-6-astra");
  await page.getByLabel("Time of day").fill("10:30");
  await page.getByRole("tab", { name: "JSON", exact: true }).click();
  const raw = JSON.parse(await page.getByLabel("Task JSON configuration").inputValue());
  assert.equal(raw.schedule.expr, "30 10 * * *"); assert.equal(raw.payload.message, "Prepare a concise morning briefing.");
  await page.getByRole("tab", { name: "UI editor", exact: true }).click();
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".editor-status")?.textContent.includes("Task saved"));
  assert.equal(saved[0].baseHash, "first"); assert.equal(saved[0].task.delivery.to, "fixture-owner"); assert.equal(saved[0].task.payload.lightContext, true);
  assert.equal(saved[0].task.schedule.tz, "America/Los_Angeles"); assert.equal(saved[0].task.payload.model, "openai/gpt-6-astra");
  await page.evaluate(() => { for (const node of document.querySelectorAll("*")) if (node.scrollTop) node.scrollTop = 0; });
  await page.screenshot({ path: `${shots}/settings-tasks-light.png`, fullPage: true });
  await page.evaluate(() => globalThis.dashboardTheme.set("dark"));
  await page.screenshot({ path: `${shots}/settings-tasks-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${shots}/settings-tasks-mobile.png`, fullPage: true });
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("New reminder"); await page.getByLabel("Prompt", { exact: true }).fill("Remember the plan.");
  assert.equal(await page.getByRole("switch", { name: "Enabled", exact: true }).isChecked(), false);
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".task-count")?.textContent.includes("3 tasks"));
  assert.deepEqual(errors, []);
  console.info("Settings Chromium passed: forms/JSON round-trip, private secrets, complete task list, prompt/model/schedule saves, preserved delivery, new disabled tasks, mobile and both themes.");
} finally { await browser.close(); }
