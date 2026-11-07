// Display formatting shared by the scene widgets and the admin usage summary.

// Time to a reset: "y h z m" for the 5-hour window, "x d y h z m" for the weekly one.
export function formatCountdown(ms, withDays = false) {
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return withDays ? `${Math.floor(minutes / 1440)}d ${h % 24}h ${m}m` : `${h}h ${m}m`;
}

// Compact token counts: 950, 12.3K, 1.84M (3 significant figures).
export function formatTokens(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return String(Math.round(value));
  const units = [["K", 1e3], ["M", 1e6], ["B", 1e9], ["T", 1e12]];
  let index = units.findLastIndex(([, size]) => value >= size);
  let scaled = Number((value / units[index][1]).toPrecision(3));
  // 999,999 rounds to 1000K; show it as 1M instead.
  if (scaled >= 1000 && index < units.length - 1) scaled = Number((value / units[++index][1]).toPrecision(3));
  return `${scaled}${units[index][0]}`;
}

// Age of a snapshot, e.g. "4m", "2h 5m", "3d 1h".
export function formatAge(ms) {
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h`;
}
