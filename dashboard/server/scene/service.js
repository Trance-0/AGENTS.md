import { randomBytes } from "node:crypto";
import { LIMITS, SCENE_SV, WIDGET_TYPES, mergeWidget, validateAvatarState, validateWidget } from "../../public/scene/schema.js";
import { initialState, reduce } from "../../public/scene/reduce.js";

// Scene widget operations shared by the admin editor and OpenClaw. The server
// only validates, stores, and relays: every change to the live scene is a
// `widget` event in the recording (so replay, seek, and speed show it), and
// the browser folds those events into what it draws.
//
// - Admin edits always update the saved default layout. While a stream is
//   live they are also recorded as events against the live scene.
// - OpenClaw edits change only the live recording (who may act on it is
//   decided by server/stream-control.js); they never rewrite the
//   administrator's default layout.
// - When a stream starts, the saved layout is replayed as opening events.

const fail = (status, consequence, reason) => Object.assign(new Error(`${consequence}: dashboard/scene ${status === 429 ? "rate limit" : "widgets"} — ${reason}.`), { status });

// Token bucket: `rate` events per second with bursts of `burst`.
export function tokenBucket(rate, burst, now = Date.now) {
  let tokens = burst, last = now();
  return {
    take(count = 1) {
      const time = now();
      tokens = Math.min(burst, tokens + (time - last) / 1000 * rate);
      last = time;
      if (tokens < count) return false;
      tokens -= count;
      return true;
    },
  };
}

const TYPE_LABEL = type => (WIDGET_TYPES[type]?.label || "Scene").toLowerCase();
const ACTORS = { admin: "an administrator", openclaw: "OpenClaw", dashboard: "the saved layout" };

export class SceneService {
  constructor({ broadcast, store, emit = () => {}, now = Date.now, limits = {} }) {
    Object.assign(this, { broadcast, store, emit, now });
    this.buckets = { admin: tokenBucket(limits.admin ?? 5, limits.adminBurst ?? 10, now), openclaw: tokenBucket(limits.openclaw ?? 2, limits.openclawBurst ?? 10, now) };
    // All scene-class events share one cap: each costs two fsyncs.
    this.global = tokenBucket(limits.global ?? 10, limits.globalBurst ?? 40, now);
    this.listeners = new Set();
    this.live = null;
    this.sequence = 0;
    // Only a real start opens the scene. A stream recovered after a restart
    // (including one that began before scenes existed) and later status
    // notifications for the same stream (summary updates) never replay it.
    this.lastActiveId = broadcast.active?.id ?? null;
    broadcast.subscribe(type => {
      if (type !== "status") return;
      const id = broadcast.active?.id ?? null;
      const started = id && id !== this.lastActiveId;
      this.lastActiveId = id;
      // Defer until start() has published its "Stream is live" event.
      if (started) queueMicrotask(() => this.openScene(id));
    });
  }

  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  // Live scene state for the active recording, rebuilt from its events after a
  // restart or when a new stream starts.
  liveState() {
    const active = this.broadcast.active;
    if (!active) { this.live = null; return null; }
    if (this.live?.recordingId !== active.id) {
      let state = initialState(), widgetEvents = 0;
      for (const event of this.broadcast.scanEvents(active.id)) {
        if (event.kind !== "widget") continue;
        widgetEvents++;
        state = reduce(state, event);
      }
      this.live = { recordingId: active.id, state, opened: widgetEvents > 0 };
    }
    return this.live;
  }

  liveWidgets() {
    const live = this.liveState();
    return live ? Object.values(live.state.widgets) : null;
  }

  openScene(recordingId) {
    const live = this.liveState();
    if (!live || live.recordingId !== recordingId || live.opened) return;
    live.opened = true;
    const { widgets } = this.store.layout();
    for (const widget of widgets.slice(0, LIMITS.widgets)) this.publish("dashboard", "create", widget.id, { widget }, { force: true });
    this.notify("open");
  }

  notify(reason) { for (const listener of this.listeners) { try { listener(reason); } catch {} } }

  publish(actor, op, target, data, { force = false } = {}) {
    if (!force && !this.global.take()) {
      this.emit({ source: "dashboard", level: "warn", msg: "Scene change dropped: dashboard/scene rate limit — more than 10 scene events per second across all producers." });
      throw fail(429, "Scene change not recorded", "the stream accepts at most 10 scene events per second; retry shortly");
    }
    const previous = this.live?.state.widgets[target];
    const verb = op === "update" && previous && !!previous.hidden !== !!data.widget?.hidden ? (data.widget.hidden ? "hidden" : "shown") : { create: "added", update: "changed", delete: "removed" }[op];
    const what = op === "metrics" ? "Scene metrics updated" : op === "avatar" ? "Avatar expression set" : `Scene ${TYPE_LABEL(data.widget?.type ?? previous?.type)} widget ${verb}`;
    const payload = {
      kind: "widget", sv: SCENE_SV, op, target, data,
      eventRef: `${actor}-${op}-${target}-${this.now().toString(36)}-${(this.sequence++).toString(36)}`,
      source: actor, level: "info",
      msg: op === "metrics" ? `${what}: dashboard/scene metrics — ${Object.keys(data.values).length} pooled public value(s) refreshed.`
        : op === "avatar" ? `${what}: dashboard/scene avatar — by ${ACTORS[actor]}, ${data.expression === "auto" ? "back to automatic expressions" : `${data.expression} for ${data.seconds} s`}.`
        : `${what}: dashboard/scene — by ${ACTORS[actor]}.`,
    };
    if (JSON.stringify(payload).length + 256 > LIMITS.eventBytes) throw fail(400, "Scene change not recorded", `the event would exceed ${LIMITS.eventBytes} bytes`);
    const event = this.broadcast.publish(payload);
    if (event && this.live?.recordingId === event.recordingId) this.live.state = reduce(this.live.state, event);
    return event;
  }

  take(actor) {
    if (!this.buckets[actor].take()) throw fail(429, "Scene change not accepted", actor === "openclaw" ? "OpenClaw may change the scene at most 2 times per second" : "administrators may change the scene at most 5 times per second");
  }

  options() { return this.store.options(); }

  newId(taken) {
    let id;
    do id = `w-${randomBytes(4).toString("hex")}`; while (taken.has(id));
    return id;
  }

  create(actor, input) {
    this.take(actor);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(400, "Widget not created", "send the widget as an object");
    const live = actor === "openclaw" || this.broadcast.active ? this.liveState() : null;
    const layout = actor === "admin" ? this.store.layout() : null;
    const taken = new Set([...(live ? Object.keys(live.state.widgets) : []), ...(layout ? layout.widgets.map(widget => widget.id) : [])]);
    const id = input.id ?? this.newId(taken);
    if (taken.has(id)) throw fail(409, "Widget not created", `widget ID '${id}' already exists`);
    const peers = [...(live ? Object.values(live.state.widgets) : []), ...(layout?.widgets || [])];
    // Back-layer types (embeds) start at the bottom; everything else goes on top.
    const back = typeof input.type === "string" && Object.hasOwn(WIDGET_TYPES, input.type) && WIDGET_TYPES[input.type].back;
    const z = input.z ?? (back ? 0 : Math.min(LIMITS.zMax, Math.max(99, ...peers.map(widget => widget.z)) + 1));
    const widget = this.validate(() => validateWidget({ ...input, id, z }, this.options()), "Widget not created");
    if (live && Object.keys(live.state.widgets).length >= LIMITS.widgets) throw fail(409, "Widget not created", `the live scene already has ${LIMITS.widgets} widgets`);
    if (layout && layout.widgets.length >= LIMITS.widgets) throw fail(409, "Widget not created", `the saved layout already has ${LIMITS.widgets} widgets`);
    if (layout) this.store.saveLayout([...layout.widgets, widget]);
    if (live) this.publish(actor, "create", id, { widget });
    this.notify("create");
    return { widget, recorded: !!live, layoutVersion: layout ? layout.version + 1 : undefined };
  }

  update(actor, id, changes) {
    this.take(actor);
    const live = actor === "openclaw" || this.broadcast.active ? this.liveState() : null;
    const layout = actor === "admin" ? this.store.layout() : null;
    const current = live?.state.widgets[id] ?? layout?.widgets.find(widget => widget.id === id);
    if (!current) throw fail(404, "Widget not changed", `widget '${String(id).slice(0, 40)}' is not in the ${actor === "openclaw" ? "live scene" : "live scene or saved layout"}`);
    const widget = this.validate(() => mergeWidget(current, changes, this.options()), "Widget not changed");
    let layoutVersion;
    if (layout?.widgets.some(item => item.id === id)) layoutVersion = this.store.saveLayout(layout.widgets.map(item => (item.id === id ? widget : item))).version;
    const recorded = !!live?.state.widgets[id];
    if (recorded) this.publish(actor, "update", id, { widget });
    this.notify("update");
    return { widget, recorded, layoutVersion };
  }

  remove(actor, id) {
    this.take(actor);
    const live = actor === "openclaw" || this.broadcast.active ? this.liveState() : null;
    const layout = actor === "admin" ? this.store.layout() : null;
    const inLive = !!live?.state.widgets[id];
    const inLayout = !!layout?.widgets.some(widget => widget.id === id);
    if (!inLive && !inLayout) throw fail(404, "Widget not removed", `widget '${String(id).slice(0, 40)}' is not in the ${actor === "openclaw" ? "live scene" : "live scene or saved layout"}`);
    let layoutVersion;
    if (inLayout) layoutVersion = this.store.saveLayout(layout.widgets.filter(widget => widget.id !== id)).version;
    if (inLive) this.publish(actor, "delete", id, {});
    this.notify("delete");
    return { id, recorded: inLive, layoutVersion };
  }

  // Forced avatar expression on the live scene (every avatar widget), recorded
  // as a `widget` event with op `avatar` so replay shows the same picture.
  avatar(actor, input) {
    this.take(actor);
    const state = this.validate(() => validateAvatarState(input), "Avatar not changed");
    if (!this.liveState()) throw fail(409, "Avatar not changed", "no stream is live");
    this.publish(actor, "avatar", "avatar", state);
    this.notify("avatar");
    return { avatar: state, recorded: true };
  }

  validate(fn, consequence) {
    try { return fn(); }
    catch (error) {
      if (error.reason) throw fail(400, consequence, error.reason);
      throw error;
    }
  }
}
