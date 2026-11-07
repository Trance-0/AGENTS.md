import { el } from "/api.js";
import { field, input, select } from "/settings-controls.js";

export const localDate = value => {
  if (!value) return ""; const date = new Date(value); if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function recurringParts(schedule) {
  if (schedule?.kind !== "cron") return null;
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(schedule.expr || "");
  return match && Number(match[1]) < 60 && Number(match[2]) < 24 ? { mode: match[3] === "*" ? "daily" : "weekly", time: `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`, day: match[3] } : null;
}
export function scheduleDescription(schedule) {
  if (schedule?.kind === "at") return `Once · ${new Date(schedule.at).toLocaleString()}`;
  if (schedule?.kind === "every") {
    const hours = schedule.everyMs / 3600000; return hours >= 1 ? `Every ${hours} hours` : `Every ${schedule.everyMs / 60000} minutes`;
  }
  const recurring = recurringParts(schedule);
  if (recurring) return `${recurring.mode === "daily" ? "Every day" : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(recurring.day)]} at ${recurring.time} · ${schedule.tz || "Gateway time zone"}`;
  return `${schedule?.expr || "No schedule"} · ${schedule?.tz || "Gateway time zone"}`;
}
export function scheduleFields(host, draft, changed) {
  let mode = recurringParts(draft.schedule)?.mode || draft.schedule.kind;
  const fields = el("div", "form-grid");
  const type = select(mode, { at: "Once", every: "At an interval", daily: "Every day", weekly: "Every week", cron: "Custom cron schedule" }, value => {
    mode = value;
    const tz = draft.schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    draft.schedule = value === "at" ? { kind: "at", at: new Date(Date.now() + 3600000).toISOString() } : value === "every" ? { kind: "every", everyMs: 3600000 } : { kind: "cron", expr: value === "weekly" ? "0 9 * * 1" : "0 9 * * *", tz };
    changed(); draw();
  });
  host.append(field("Repeat", type), fields);
  const draw = () => {
    fields.replaceChildren(); const schedule = draft.schedule;
    if (mode === "at") {
      const date = input(localDate(schedule.at), value => { if (value) { schedule.at = new Date(value).toISOString(); changed(); } }, "datetime-local"); date.required = true;
      fields.append(field("Run at", date, `Shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`));
    } else if (mode === "every") {
      let unit = schedule.everyMs % 3600000 === 0 ? 3600000 : schedule.everyMs % 60000 === 0 ? 60000 : 1000;
      const amount = input(schedule.everyMs / unit, value => { schedule.everyMs = value * unit; changed(); }, "number"); amount.min = "1"; amount.step = "1";
      fields.append(field("Repeat every", amount), field("Time unit", select(String(unit), { 1000: "Seconds", 60000: "Minutes", 3600000: "Hours", 86400000: "Days" }, value => { unit = Number(value); schedule.everyMs = Number(amount.value) * unit; changed(); })), field("Start from", input(localDate(schedule.anchorMs), value => { if (value) schedule.anchorMs = new Date(value).getTime(); else delete schedule.anchorMs; changed(); }, "datetime-local"), "Optional anchor for recurring runs."));
    } else {
      const timeZone = input(schedule.tz || "", value => { if (value) schedule.tz = value; else delete schedule.tz; changed(); }); timeZone.setAttribute("list", "task-time-zones"); timeZone.placeholder = "Gateway time zone";
      const zones = el("datalist"); zones.id = "task-time-zones"; for (const zone of Intl.supportedValuesOf?.("timeZone") || ["UTC"]) zones.append(new Option(zone)); fields.append(zones);
      if (mode === "daily" || mode === "weekly") {
        const initial = recurringParts(schedule);
        let time = initial?.time || "09:00", day = initial?.day === "*" ? "1" : initial?.day || "1";
        const update = () => { const [h, m] = time.split(":").map(Number); schedule.expr = `${m} ${h} * * ${mode === "weekly" ? day : "*"}`; changed(); };
        fields.append(field("Time of day", input(time, value => { time = value; update(); }, "time")));
        if (mode === "weekly") fields.append(field("Day", select(day, { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 0: "Sunday" }, value => { day = value; update(); })));
      } else fields.append(field("Cron expression", input(schedule.expr, value => { schedule.expr = value; changed(); }), "Minute, hour, day, month, weekday. For example: 0 9 * * 1-5."));
      fields.append(field("Time zone", timeZone), field("Stagger window (seconds)", input((schedule.staggerMs ?? 0) / 1000, value => { schedule.staggerMs = Math.max(0, value || 0) * 1000; changed(); }, "number"), "Zero runs at the exact scheduled time."));
    }
  };
  draw();
}
