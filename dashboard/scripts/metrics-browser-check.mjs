import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
const baseURL = process.env.DASHBOARD_TEST_URL;
const errors = [];
async function context(cookie) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { "x-forwarded-proto": "https" } });
  if (cookie) { const [name, ...rest] = cookie.split("="); await ctx.addCookies([{ name, value: rest.join("="), url: baseURL }]); }
  await ctx.route("**/api/**", async route => {
    if (route.request().method() === "GET") return route.continue();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: "https://live.example.test", "x-dashboard-request": "1" } });
    await route.fulfill({ response });
  });
  return ctx;
}
try {
  for (const cookie of [undefined, process.env.DASHBOARD_VIEWER_COOKIE]) {
    const ctx = await context(cookie); const page = await ctx.newPage(); await page.goto("/");
    await page.waitForSelector("#stream-title");
    if (cookie) await page.waitForSelector("#panel-nav .nav-item");
    assert.equal(await page.locator('[data-view="usage"]').count(), 0, "the Usage group is admin-only");
    assert.equal(await page.locator('[data-tab="usage-metrics"], [data-tab="cpa-quota"]').count(), 0);
    await ctx.close();
  }
  const admin = await context(process.env.DASHBOARD_TEST_COOKIE);
  const page = await admin.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.locator('[data-view="usage"]').click();
  await page.locator('[data-tab="usage-metrics"]').click();
  await page.waitForFunction(() => document.querySelector('.metrics-status')?.textContent.includes('One attempt'));
  assert.match(await page.locator('.metrics-cards').innerText(), /3,600/);
  await page.getByLabel("View", { exact: true }).selectOption("cost");
  assert.match(await page.locator('.metrics-table').innerText(), /\$0\.010935/);
  await page.getByLabel("Group", { exact: true }).selectOption("model");
  assert.match(await page.locator('.metrics-table').innerText(), /claude-test/);
  const chart = page.locator('.metrics-chart svg'); assert.ok(await chart.count());
  assert.ok(await chart.locator('rect title').count());
  await page.getByLabel("Route", { exact: true }).first().selectOption("openai");
  await page.waitForFunction(() => document.querySelector('.metrics-cards')?.textContent.includes('1,800'));
  assert.match(await page.locator('.metrics-table').innerText(), /gpt-test/);
  assert.ok(!(await page.locator('.metrics-table').innerText()).includes('claude-test'));
  await page.getByLabel("Route", { exact: true }).first().selectOption("");
  await page.waitForFunction(() => document.querySelector('.metrics-cards')?.textContent.includes('3,600'));
  await page.screenshot({ path: "/tmp/dashboard-metrics-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.ok(await page.locator('.metrics-toolbar').isVisible());
  assert.ok(await page.locator('.metrics-view').evaluate(el => el.getBoundingClientRect().width <= window.innerWidth));
  await page.screenshot({ path: process.env.METRICS_SCREENSHOT || "/tmp/dashboard-metrics-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-tab="cpa-quota"]').click();
  await page.waitForFunction(() => document.querySelector('.metrics-status')?.textContent.includes('No management key'));
  await page.getByLabel("CPA dashboard URL").fill("https://quota.example");
  await page.getByLabel("Management key").fill("browser-only-test-secret");
  await page.getByRole("button", { name: "Save connection", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.metrics-status')?.textContent.includes('Encrypted credential saved'));
  assert.equal(await page.getByLabel("Management key").inputValue(), "");
  await page.route("**/api/admin/metrics/cpa/refresh", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ snapshot: { updatedAt: Date.now(), note: "Fixture quota windows.", accounts: [{ label: "claude account 1", windows: [{ label: "5 hours", remainingPercent: 72.5, resetsAt: Date.now() + 3600000 }, { label: "7 days", remainingPercent: null, resetsAt: null }] }] } }) }));
  await page.getByRole("button", { name: "Refresh quota", exact: true }).click();
  await page.waitForSelector("meter");
  assert.equal(await page.locator("meter").getAttribute("aria-label"), "claude account 1 5 hours remaining");
  assert.match(await page.locator(".quota-accounts").innerText(), /72.5% remaining/);
  assert.match(await page.locator(".quota-accounts").innerText(), /Unknown remaining/);
  await page.screenshot({ path: "/tmp/dashboard-cpa-quota.png", fullPage: true });
  await page.reload(); await page.waitForSelector('[data-tab="cpa-quota"][aria-selected="true"]');
  await page.waitForFunction(() => document.querySelector('.metrics-status')?.textContent.includes('Encrypted credential saved'));
  assert.ok(!(await page.content()).includes("browser-only-test-secret"));
  await page.getByRole("button", { name: "Remove saved key", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.metrics-status')?.textContent.includes('No management key'));
  assert.deepEqual(errors, []);
  console.info("Metrics Chromium passed: admin-only menu, tokens/prices, route/model filters, trend tooltips, responsive view, encrypted key save/remove.");
} finally { await browser.close(); }
