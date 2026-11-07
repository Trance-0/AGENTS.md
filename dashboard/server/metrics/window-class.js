// Codex quota windows are classified by their length (about 5 hours, about 7
// days), never by the provider's primary/secondary label.
export const FIVE_HOURS = 5 * 3600;
export const ONE_WEEK = 7 * 86400;

export function windowClass(seconds) {
  if (!Number.isFinite(seconds)) return null;
  if (Math.abs(seconds - FIVE_HOURS) <= 3600) return "fiveHour";
  if (Math.abs(seconds - ONE_WEEK) <= 86400) return "week";
  return null;
}
