// Theme preference (dark / light / system), stored per browser.
//
// Loaded as a blocking classic script in <head>, before the stylesheets, so
// the resolved theme is on <html data-theme> before first paint (no flash).
// "system" follows prefers-color-scheme and tracks changes live. Nothing is
// sent to the server. Exposed as globalThis.dashboardTheme for app.js and tests.
(function (root) {
  const KEY = "agent-dashboard.theme";
  const THEMES = ["system", "light", "dark"];
  const normalize = value => (THEMES.includes(value) ? value : "system");
  const resolve = (preference, prefersDark) => {
    const theme = normalize(preference);
    return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  };
  // Cycle order used by the top-bar button: system -> light -> dark -> system.
  const next = preference => THEMES[(THEMES.indexOf(normalize(preference)) + 1) % THEMES.length];
  const media = typeof root.matchMedia === "function" ? root.matchMedia("(prefers-color-scheme: dark)") : null;
  const read = () => {
    try { return normalize(root.localStorage.getItem(KEY)); } catch { return "system"; }
  };
  const apply = (preference = read()) => {
    const element = root.document?.documentElement;
    const theme = resolve(preference, media ? media.matches : true);
    if (element) {
      element.dataset.theme = theme;
      element.dataset.themePreference = normalize(preference);
      element.style.colorScheme = theme;
    }
    return theme;
  };
  const set = preference => {
    const value = normalize(preference);
    try { root.localStorage.setItem(KEY, value); } catch {}
    const theme = apply(value);
    root.dispatchEvent?.(new root.CustomEvent("dashboard-theme", { detail: { preference: value, theme } }));
    return value;
  };
  media?.addEventListener?.("change", () => {
    if (read() !== "system") return;
    const theme = apply("system");
    root.dispatchEvent?.(new root.CustomEvent("dashboard-theme", { detail: { preference: "system", theme } }));
  });
  root.dashboardTheme = { KEY, THEMES, normalize, resolve, next, read, apply, set };
  apply();
})(globalThis);
