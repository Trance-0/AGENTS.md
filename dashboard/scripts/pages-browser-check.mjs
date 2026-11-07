// Chromium check for the grouped, tabbed pages and the Settings page:
// group/tab navigation (mouse, keyboard, deep links, legacy links), the usage
// summary, real per-browser settings (theme, motion, autoplay, speed), the
// admin panel-switch list, and layout at 390 px in both themes. Spawned by
// server/auth.test.js with DASHBOARD_BROWSER_CHECK=1.
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
const baseURL = process.env.DASHBOARD_TEST_URL;
const shots = process.env.DASHBOARD_SCREENSHOT_DIR || "/tmp";
const errors = [];

async function context(cookie, { width = 1440, colorScheme = "dark" } = {}) {
  const ctx = await browser.newContext({ baseURL, colorScheme, viewport: { width, height: 900 }, extraHTTPHeaders: { "x-forwarded-proto": "https" } });
  if (cookie) { const [name, ...rest] = cookie.split("="); await ctx.addCookies([{ name, value: rest.join("="), url: baseURL, httpOnly: true, sameSite: "Lax" }]); }
  await ctx.route("**/api/**", async route => {
    if (route.request().method() === "GET") return route.continue();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: "https://live.example.test" } });
    await route.fulfill({ response });
  });
  return ctx;
}
async function open(ctx, path = "/") {
  const page = await ctx.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(path);
  // Deep links open a group page, so the player title may be hidden.
  await page.waitForSelector("#stream-title", { state: "attached" });
  await page.waitForFunction(() => document.body.classList.contains("guest") || document.querySelector("#panel-nav .nav-item"));
  return page;
}
const tabs = page => page.evaluate(() => [...document.querySelectorAll(".tabs [role=tab]")].map(tab => [tab.textContent.replace(/off$/, "").trim(), tab.getAttribute("aria-selected")]));
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

try {
  // Guests see only Live: no sidebar, no group pages even through a deep link.
  const guest = await context(undefined);
  const guestPage = await open(guest, "/#usage/usage-summary");
  assert.equal(await guestPage.locator("#sidebar").isVisible(), false);
  assert.equal(await guestPage.locator("#view-live-stream").isVisible(), true, "guests stay on Live");
  await guest.close();

  // Members: OpenClaw has Status/Backends (no admin-only Config tab); no Usage group.
  const viewer = await context(process.env.DASHBOARD_VIEWER_COOKIE);
  const viewerPage = await open(viewer);
  await viewerPage.waitForSelector("#panel-nav .nav-item");
  assert.equal(await viewerPage.locator('[data-view="usage"]').count(), 0);
  await viewerPage.locator('[data-view="openclaw"]').click();
  assert.deepEqual(await tabs(viewerPage), [["Status", "true"], ["Backends", "false"]]);
  const highlighted = await viewerPage.evaluate(() => [...document.querySelectorAll("#sidebar .nav-item")].map(item => [item.dataset.view, item.className, item.getAttribute("aria-current"), getComputedStyle(item).backgroundColor]));
  assert.deepEqual(highlighted.filter(([, className]) => className.includes("active")).map(([view]) => view), ["openclaw"], JSON.stringify(highlighted));
  assert.deepEqual(highlighted.filter(([, , current]) => current === "page").map(([view]) => view), ["openclaw"]);
  await viewerPage.waitForSelector(".tab-body .data-table");
  assert.match(await viewerPage.locator(".tab-body").innerText(), /dashboard-host[\s\S]*cpa\/gpt-6-astra/);
  assert.match(await viewerPage.locator(".tab-body").innerText(), /cpa\/claude-opus-5-5-high → cpa\/gpt-6-astra → openai\/gpt-6-astra/, "fallback chain is shown in order");
  await viewerPage.screenshot({ path: `${shots}/pages-openclaw-status.png`, fullPage: true });
  // Keyboard: arrow keys move between tabs and update the URL.
  await viewerPage.locator('[data-tab="openclaw-status"]').focus();
  await viewerPage.keyboard.press("ArrowRight");
  await viewerPage.waitForSelector('[data-tab="openclaw-backends"][aria-selected="true"]');
  assert.equal(await viewerPage.evaluate(() => document.activeElement.dataset.tab), "openclaw-backends");
  assert.equal(new URL(viewerPage.url()).hash, "#openclaw/openclaw-backends");
  await viewerPage.waitForFunction(() => document.querySelector(".tab-body")?.textContent.includes("OPENAI_API_KEY"));
  assert.equal(await viewerPage.locator("#panel-enabled").count(), 0, "members get no admin switch");
  // Settings as a member: no admin section.
  await viewerPage.locator('[data-view="settings"]').click();
  assert.equal(await viewerPage.locator("#panel-switches").count(), 0);
  await viewer.close();

  // Admins: every group, tabs, deep links and legacy panel links.
  const admin = await context(process.env.DASHBOARD_TEST_COOKIE);
  const page = await open(admin, "/#usage/usage-metrics");
  await page.waitForSelector('[data-tab="usage-metrics"][aria-selected="true"]');
  assert.deepEqual(await tabs(page), [["Summary", "false"], ["CPA quota", "false"], ["Token metrics", "true"]], "deep link opens the requested tab");
  const usageIcons = await page.evaluate(() => [...document.querySelectorAll("#sidebar .nav-item svg")].map(svg => svg.innerHTML));
  assert.equal(new Set(usageIcons).size, usageIcons.length, "group icons are distinct");
  await page.goto("/#cpa-quota");
  await page.waitForSelector('[data-tab="cpa-quota"][aria-selected="true"]');
  assert.equal(new URL(page.url()).hash, "#usage/cpa-quota", "legacy panel links resolve to their group tab");
  await page.locator('[data-tab="usage-summary"]').click();
  await page.waitForSelector('.summary-quota[data-window="week"]');
  assert.match(await page.locator(".summary-view").innerText(), /5-hour window[\s\S]*Unknown[\s\S]*0 of 0 accounts/i);
  assert.match(await page.locator(".summary-tokens").innerText(), /3\.6K/);
  await page.screenshot({ path: `${shots}/pages-usage-summary-dark.png`, fullPage: true });
  await page.locator('[data-view="openclaw"]').click();
  assert.deepEqual((await tabs(page)).map(([title]) => title), ["Status", "Backends", "Settings", "Scheduled tasks"]);

  // Settings: every control is real and takes effect immediately.
  await page.locator('[data-view="settings"]').click();
  await page.waitForSelector("#panel-switches");
  await page.locator('label[for="setting-motion-reduce"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), "reduce");
  assert.equal(await page.evaluate(() => localStorage.getItem("agent-dashboard.motion")), "reduce");
  assert.equal(await page.locator(".switch-track").first().evaluate(element => getComputedStyle(element).transitionDuration), "0s", "reduced motion disables transitions");
  await page.locator('label[for="setting-motion-system"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), "full", "system follows the (no-preference) device");
  await page.locator("#setting-speed").selectOption("1.5");
  assert.equal(await page.evaluate(() => localStorage.getItem("agent-dashboard.playbackRate")), "1.5");
  await page.locator('[data-view="live"]').click();
  await page.locator(".rec-card").first().click();
  await page.waitForFunction(() => document.querySelector("#live-label").textContent === "REPLAY");
  assert.equal(await page.locator("#speed-label").textContent(), "1.5x", "recordings open at the chosen speed");
  await page.locator('[data-view="settings"]').click();
  await page.waitForSelector("#panel-switches");
  assert.equal(await page.locator("#setting-speed").inputValue(), "1.5");
  await page.locator("#setting-speed").selectOption("1");
  const switches = await page.evaluate(() => [...document.querySelectorAll("#panel-switches [data-panel]")].map(row => row.dataset.panel));
  assert.deepEqual([...switches].sort(), ["astrbot", "build-status", "cpa-quota", "live-stream", "openclaw", "openclaw-config", "settings", "usage-metrics", "usage-summary"]);
  assert.equal(await page.locator("#panel-switch-live-stream").isDisabled(), true, "the player cannot be switched off");
  await page.screenshot({ path: `${shots}/pages-settings-admin-dark.png`, fullPage: true });
  const toggled = page.waitForResponse(response => response.url().endsWith("/api/panels/astrbot/toggle"));
  await page.locator('label:has(#panel-switch-astrbot)').click();
  assert.equal((await toggled).status(), 200);
  await page.waitForFunction(() => document.querySelector('#sidebar .nav-item[data-view="adapters"] .dot')?.textContent === "off");
  assert.equal(await page.locator("#panel-switch-astrbot").isChecked(), false);
  await page.locator('label:has(#panel-switch-astrbot)').click();
  await page.waitForFunction(() => !document.querySelector('#sidebar .nav-item[data-view="adapters"] .dot'));
  // Light theme and 390 px: cards stack, nothing overflows horizontally.
  await page.locator('label[for="setting-theme-light"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/pages-settings-admin-light.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.ok(await noOverflow(page), "settings fit a 390 px screen");
  await page.screenshot({ path: `${shots}/pages-settings-mobile-light.png`, fullPage: true });
  await page.locator('label[for="setting-theme-dark"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/pages-settings-mobile-dark.png`, fullPage: true });
  await page.goto("/#usage/usage-summary");
  await page.waitForSelector('.summary-quota[data-window="week"]');
  assert.ok(await noOverflow(page), "usage tabs fit a 390 px screen");
  await page.screenshot({ path: `${shots}/pages-usage-mobile-dark.png`, fullPage: true });
  await page.evaluate(() => globalThis.dashboardTheme.set("system"));
  await admin.close();
  assert.deepEqual(errors, []);
  console.info("Pages Chromium passed: guest Live-only, member groups/tabs, keyboard tabs and URLs, deep and legacy links, usage summary, OpenClaw agents and fallback chain, motion/speed/theme settings, admin panel switch list, 390 px in both themes.");
} finally { await browser.close(); }
