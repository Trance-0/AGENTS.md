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

  // Reduced-motion override (system / reduce / full), applied the same way as
  // <html data-motion="reduce|full">. CSS and the scene renderer read the
  // resolved attribute instead of the media query, so the override wins.
  const MOTION_KEY = "agent-dashboard.motion";
  const MOTIONS = ["system", "reduce", "full"];
  const normalizeMotion = value => (MOTIONS.includes(value) ? value : "system");
  const motionMedia = typeof root.matchMedia === "function" ? root.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const resolveMotion = (preference, prefersReduce) => {
    const value = normalizeMotion(preference);
    return value === "system" ? (prefersReduce ? "reduce" : "full") : value;
  };
  const readMotion = () => {
    try { return normalizeMotion(root.localStorage.getItem(MOTION_KEY)); } catch { return "system"; }
  };
  const applyMotion = (preference = readMotion()) => {
    const motion = resolveMotion(preference, !!motionMedia?.matches);
    const element = root.document?.documentElement;
    if (element) {
      element.dataset.motion = motion;
      element.dataset.motionPreference = normalizeMotion(preference);
    }
    return motion;
  };
  const setMotion = preference => {
    const value = normalizeMotion(preference);
    try { root.localStorage.setItem(MOTION_KEY, value); } catch {}
    const motion = applyMotion(value);
    root.dispatchEvent?.(new root.CustomEvent("dashboard-motion", { detail: { preference: value, motion } }));
    return value;
  };
  motionMedia?.addEventListener?.("change", () => { if (readMotion() === "system") applyMotion("system"); });
  root.dashboardMotion = { KEY: MOTION_KEY, VALUES: MOTIONS, normalize: normalizeMotion, resolve: resolveMotion, read: readMotion, apply: applyMotion, set: setMotion, reduced: () => applyMotion() === "reduce" };
  applyMotion();
})(globalThis);
