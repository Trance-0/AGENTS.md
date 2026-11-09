// Chromium check for theme switching/persistence, the sidebar for viewers vs
// admins, and in-browser admin panel toggles. Spawned by server/auth.test.js
// with DASHBOARD_BROWSER_CHECK=1 against the isolated OIDC fixture.
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
const baseURL = process.env.DASHBOARD_TEST_URL;
const shots = process.env.DASHBOARD_SCREENSHOT_DIR || "/tmp";
const errors = [];
const VIEWER_PANELS = ["Live", "OpenClaw", "Adapters", "Builds", "Settings"];
const ADMIN_PANELS = ["Live", "OpenClaw", "Usage", "Adapters", "Canvas", "Builds", "Settings"];

async function context(cookie, { width = 1440, colorScheme = "dark" } = {}) {
  const ctx = await browser.newContext({ baseURL, colorScheme, viewport: { width, height: 900 }, extraHTTPHeaders: { "x-forwarded-proto": "https" } });
  if (cookie) { const [name, ...rest] = cookie.split("="); await ctx.addCookies([{ name, value: rest.join("="), url: baseURL, httpOnly: true, sameSite: "Lax" }]); }
  // The fixture's configured origin is HTTPS while Chromium reaches loopback HTTP;
  // supply that origin on mutations exactly as the real browser would.
  await ctx.route("**/api/**", async route => {
    if (route.request().method() === "GET") return route.continue();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: "https://live.example.test" } });
    await route.fulfill({ response });
  });
  return ctx;
}
const open = async ctx => {
  const page = await ctx.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.waitForSelector("#stream-title");
  return page;
};
const themeOf = page => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, preference: document.documentElement.dataset.themePreference, bg: getComputedStyle(document.body).backgroundColor }));
const activeNav = page => page.evaluate(() => [...document.querySelectorAll(".nav-item.active")].map(item => item.dataset.view));
const navLabels = page => page.evaluate(() => [...document.querySelectorAll("#sidebar .nav-item")].map(item => item.querySelector("span")?.textContent.trim()));
const DARK_BG = "rgb(15, 15, 15)", LIGHT_BG = "rgb(255, 255, 255)";

try {
  // Guests: no sidebar, but the theme switch works and follows the OS by default.
  for (const [scheme, theme, bg] of [["dark", "dark", DARK_BG], ["light", "light", LIGHT_BG]]) {
    const ctx = await context(undefined, { colorScheme: scheme });
    const page = await open(ctx);
    assert.deepEqual(await themeOf(page), { theme, preference: "system", bg }, `system theme follows prefers-color-scheme: ${scheme}`);
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    assert.ok(await page.locator("#theme-toggle").isVisible(), "guests get the theme switch");
    await ctx.close();
  }
  const guest = await context(undefined, { colorScheme: "dark" });
  const guestPage = await open(guest);
  await guestPage.locator("#theme-toggle").click();
  assert.deepEqual(await themeOf(guestPage), { theme: "light", preference: "light", bg: LIGHT_BG }, "top-bar switch: system -> light");
  assert.match(await guestPage.locator("#theme-toggle").getAttribute("aria-label"), /Theme: Light/);
  // No flash on reload: the stored theme is on <html> before any stylesheet or module runs.
  await guestPage.addInitScript(() => {
    new MutationObserver(() => {
      if (document.body && window.__themeAtBody === undefined) window.__themeAtBody = document.documentElement.dataset.theme;
    }).observe(document, { childList: true, subtree: true });
  });
  await guestPage.reload();
  await guestPage.waitForSelector("#stream-title");
  assert.equal(await guestPage.evaluate(() => window.__themeAtBody), "light", "theme applied before <body> is parsed");
  assert.equal((await themeOf(guestPage)).bg, LIGHT_BG);
  // The player surface stays dark in light theme.
  assert.equal(await guestPage.locator("#player").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(0, 0, 0)");
  await guestPage.screenshot({ path: `${shots}/dashboard-light-guest.png`, fullPage: true });
  await guestPage.locator("#theme-toggle").click();
  assert.deepEqual(await themeOf(guestPage), { theme: "dark", preference: "dark", bg: DARK_BG }, "light -> dark");
  await guestPage.locator("#theme-toggle").click();
  assert.equal((await themeOf(guestPage)).preference, "system", "dark -> system");
  await guest.close();

  // Viewers: the sidebar lists member panels only, with distinct icons; the menu button collapses and restores it.
  const viewer = await context(process.env.DASHBOARD_VIEWER_COOKIE);
  const viewerPage = await open(viewer);
  await viewerPage.waitForSelector('#panel-nav .nav-item');
  assert.deepEqual(await navLabels(viewerPage), VIEWER_PANELS);
  assert.match(await viewerPage.locator("#uptime-chip").textContent(), /^Server up \d/);
  const icons = await viewerPage.evaluate(() => [...document.querySelectorAll("#sidebar .nav-item svg")].map(svg => svg.innerHTML));
  assert.equal(icons.length, VIEWER_PANELS.length, "every sidebar item has an icon");
  assert.equal(new Set(icons).size, icons.length, "sidebar icons are distinct per panel");
  assert.equal(await viewerPage.locator("#hamburger").getAttribute("aria-expanded"), "true");
  await viewerPage.locator("#hamburger").click();
  await viewerPage.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().width === 72, null, { timeout: 2000 });
  assert.equal(await viewerPage.locator("#hamburger").getAttribute("aria-expanded"), "false");
  assert.equal(await viewerPage.locator('#sidebar .nav-item[data-view="settings"]').getAttribute("title"), "Settings", "collapsed rail items keep a tooltip");
  await viewerPage.screenshot({ path: `${shots}/dashboard-sidebar-rail.png` });
  await viewerPage.locator("#hamburger").click();
  await viewerPage.waitForFunction(() => document.querySelector("#sidebar").getBoundingClientRect().width === 220, null, { timeout: 2000 });
  // Settings: live controls, applied immediately, persisted, synced with the top-bar switch.
  await viewerPage.locator('[data-view="settings"]').click();
  assert.deepEqual(await activeNav(viewerPage), ["settings"], "only the open panel is highlighted");
  const checkedTheme = () => viewerPage.locator('input[name="setting-theme"]:checked').inputValue();
  const pickTheme = value => viewerPage.locator(`label[for="setting-theme-${value}"]`).click();
  assert.equal(await checkedTheme(), "system");
  assert.equal(await viewerPage.getByText("Alert volume").count(), 0, "no fake controls");
  await pickTheme("light");
  assert.deepEqual(await themeOf(viewerPage), { theme: "light", preference: "light", bg: LIGHT_BG });
  assert.equal(await viewerPage.evaluate(() => localStorage.getItem("agent-dashboard.theme")), "light");
  await viewerPage.locator("#theme-toggle").click();
  assert.equal(await checkedTheme(), "dark", "settings theme control follows the top-bar switch");
  await pickTheme("light");
  const autoplay = viewerPage.locator("#setting-autoplay");
  assert.equal(await autoplay.isChecked(), true);
  await autoplay.uncheck();
  assert.equal(await viewerPage.evaluate(() => localStorage.getItem("agent-dashboard.autoplay")), "false");
  assert.equal(await viewerPage.locator("#panel-admin input").count(), 0, "viewers get no admin switch");
  await viewerPage.screenshot({ path: `${shots}/dashboard-settings-light.png`, fullPage: true });
  await viewerPage.reload();
  await viewerPage.waitForSelector('#panel-nav .nav-item');
  assert.equal((await themeOf(viewerPage)).theme, "light", "theme persists across reload");
  assert.equal(await viewerPage.locator('[data-view="settings"]').getAttribute("aria-current"), "page", "reload keeps the open page (#settings)");
  // Autoplay off: opening a recording leaves it paused at the start.
  await viewerPage.locator('[data-view="live"]').click();
  await viewerPage.locator(".rec-card").first().click();
  await viewerPage.waitForFunction(() => document.querySelector("#live-label").textContent === "REPLAY");
  assert.equal(await viewerPage.locator("#btn-play").getAttribute("aria-label"), "Play", "autoplay off keeps recordings paused");
  assert.equal(await viewerPage.locator("#progress-bar").getAttribute("aria-valuenow"), "0");
  // Panel settings that are deployment configuration render read-only.
  await viewerPage.locator('[data-view="openclaw"]').click();
  await viewerPage.waitForSelector(".setting-row output");
  assert.equal(await viewerPage.locator("#view-panel .setting-row input, #view-panel .setting-row select").count(), 0, "deployment settings are read-only");
  // Narrow screens: the menu slides the sidebar in, and choosing a panel closes it.
  await viewerPage.setViewportSize({ width: 390, height: 844 });
  await viewerPage.waitForTimeout(250);
  assert.ok((await viewerPage.locator("#sidebar").boundingBox()).x < 0, "sidebar starts off-canvas on mobile");
  await viewerPage.locator("#hamburger").click();
  await viewerPage.waitForTimeout(300);
  assert.equal((await viewerPage.locator("#sidebar").boundingBox()).x, 0);
  await viewerPage.screenshot({ path: `${shots}/dashboard-sidebar-mobile-light.png` });
  await viewerPage.locator('[data-view="settings"]').click();
  await viewerPage.waitForTimeout(300);
  assert.ok((await viewerPage.locator("#sidebar").boundingBox()).x < 0, "choosing a panel closes the mobile sidebar");
  await viewer.close();

  // Admins: all panels, plus a working in-browser panel switch (session + same-origin header, no bearer).
  const admin = await context(process.env.DASHBOARD_TEST_COOKIE);
  const adminPage = await open(admin);
  await adminPage.waitForSelector('#panel-nav .nav-item');
  assert.deepEqual(await navLabels(adminPage), ADMIN_PANELS);
  await adminPage.locator('[data-view="builds"]').click();
  const enabled = adminPage.locator("#panel-enabled");
  assert.equal(await enabled.isChecked(), true);
  const toggled = adminPage.waitForResponse(response => response.url().endsWith("/api/panels/build-status/toggle"));
  await enabled.uncheck();
  const response = await toggled;
  assert.equal(response.status(), 200, await response.text());
  assert.equal(response.request().headers().authorization, undefined, "the browser sends no bearer token");
  await adminPage.waitForSelector(".panel-disabled");
  await adminPage.waitForFunction(() => document.querySelector('#sidebar .nav-item[data-view="builds"] .dot'));
  assert.deepEqual(await activeNav(adminPage), ["builds"], "the toggled panel stays highlighted");
  assert.equal(await adminPage.locator('#sidebar .nav-item[data-view="builds"] .dot').textContent(), "off");
  await adminPage.screenshot({ path: `${shots}/dashboard-admin-panel-disabled.png`, fullPage: true });
  const viewerAgain = await context(process.env.DASHBOARD_VIEWER_COOKIE);
  const viewerAgainPage = await open(viewerAgain);
  await viewerAgainPage.waitForSelector('#panel-nav .nav-item');
  assert.ok(!(await navLabels(viewerAgainPage)).includes("Builds"), "a group whose only panel is disabled leaves the member sidebar");
  await viewerAgain.close();
  await adminPage.locator("#panel-enabled").check();
  await adminPage.waitForFunction(() => !document.querySelector('#sidebar .nav-item[data-view="builds"] .dot'));
  assert.equal(await adminPage.locator(".panel-disabled").count(), 0);
  // The config editor (admin-only) still loads.
  await adminPage.locator('[data-view="openclaw"]').click();
  await adminPage.locator('[data-tab="openclaw-config"]').click();
  await adminPage.waitForFunction(() => document.querySelector(".config-editor .editor-status")?.textContent === "Settings are up to date");
  await admin.close();
  assert.deepEqual(errors, []);
  console.info("UI Chromium passed: system/light/dark theme with persistence and no flash, settings sync and autoplay, read-only deployment settings, viewer/admin sidebars with icons and uptime, rail and mobile menu, in-browser admin panel toggle.");
} finally { await browser.close(); }
