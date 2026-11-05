import assert from "node:assert/strict";
import test from "node:test";
import { AUTOPLAY_STORAGE_KEY, normalizeAutoplay } from "../public/player.js";

// public/theme.js is a classic browser script; run it against minimal stubs.
function stubBrowser({ stored, prefersDark }) {
  const store = new Map(stored === undefined ? [] : [["agent-dashboard.theme", stored]]);
  const listeners = [];
  const media = { matches: prefersDark, addEventListener: (_type, listener) => listeners.push(listener) };
  const element = { dataset: {}, style: {} };
  const events = [];
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("localStorage", { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) });
  define("matchMedia", () => media);
  define("document", { documentElement: element });
  define("dispatchEvent", event => events.push(event.detail));
  define("CustomEvent", class { constructor(type, init) { this.type = type; this.detail = init?.detail; } });
  return { store, media, element, events, flip(dark) { media.matches = dark; listeners.forEach(listener => listener()); } };
}

async function loadTheme(name) {
  delete globalThis.dashboardTheme;
  await import(`../public/theme.js?${name}`);
  return globalThis.dashboardTheme;
}

test("theme preference resolves dark/light/system, persists, and follows the OS in system mode", async () => {
  const browser = stubBrowser({ stored: undefined, prefersDark: false });
  const theme = await loadTheme("first");
  assert.deepEqual(browser.element.dataset, { theme: "light", themePreference: "system" }, "applied on load with no stored value");
  assert.equal(browser.element.style.colorScheme, "light");
  assert.equal(theme.resolve("system", true), "dark");
  assert.equal(theme.resolve("light", true), "light");
  assert.equal(theme.normalize("purple"), "system");
  assert.deepEqual(["system", "light", "dark"].map(theme.next), ["light", "dark", "system"]);
  browser.flip(true);
  assert.equal(browser.element.dataset.theme, "dark", "system mode tracks prefers-color-scheme changes");
  assert.equal(theme.set("light"), "light");
  assert.equal(browser.store.get(theme.KEY), "light");
  assert.equal(browser.element.dataset.theme, "light");
  assert.deepEqual(browser.events.at(-1), { preference: "light", theme: "light" });
  browser.flip(false); browser.flip(true);
  assert.equal(browser.element.dataset.theme, "light", "an explicit choice ignores OS changes");
  theme.set("bogus");
  assert.equal(browser.store.get(theme.KEY), "system");
});

test("a stored theme is applied as soon as the script runs (no flash on reload)", async () => {
  const browser = stubBrowser({ stored: "dark", prefersDark: false });
  await loadTheme("second");
  assert.deepEqual(browser.element.dataset, { theme: "dark", themePreference: "dark" });
  const invalid = stubBrowser({ stored: "neon", prefersDark: true });
  await loadTheme("third");
  assert.deepEqual(invalid.element.dataset, { theme: "dark", themePreference: "system" });
});

test("autoplay preference defaults on and only an explicit false turns it off", () => {
  assert.equal(AUTOPLAY_STORAGE_KEY, "agent-dashboard.autoplay");
  for (const value of [null, undefined, "true", "", "1", true]) assert.equal(normalizeAutoplay(value), true);
  for (const value of ["false", false]) assert.equal(normalizeAutoplay(value), false);
});
