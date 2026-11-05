import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS, builtinLayout, defaultSettings, imageUrlAllowed, isDefaultBackdrop, mergeWidget, migrateWidget, normalizeAllowlist, normalizeSettings, validateLayout, validateWidget, withDefaults } from "../public/scene/schema.js";
import { liveDiff } from "../public/scene/diff.js";
import { contentSecurityPolicy, embedPaths, embedSecurityPolicy } from "./scene/routes.js";
import { fitRect } from "../public/scene/editor.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const base = { id: "t1", type: "text", x: 0.1, y: 0.1, w: 0.3, h: 0.1 };
const rejects = (input, pattern, options) => assert.throws(() => validateWidget(input, options), error => error.status === 400 && pattern.test(error.reason), `expected ${pattern}`);

test("valid widgets are normalized with defaults for every type", () => {
  assert.deepEqual(validateWidget(base), { ...base, z: 100, props: { text: "Hello from the stream", size: 28, color: "snow", align: "left", card: true } });
  assert.equal(validateWidget({ ...base, x: 0.123456789 }).x, 0.1235);
  for (const type of ["metric", "avatar", "cat", "clock"]) assert.equal(validateWidget({ ...base, type }).type, type);
  assert.equal(validateWidget({ ...base, type: "metric", props: { source: "tokens.7d" } }).props.source, "tokens.7d");
  assert.deepEqual(validateLayout({ widgets: builtinLayout() }).map(widget => widget.type), ["avatar", "cat"]);
  const avatar = builtinLayout()[0];
  assert.ok(Math.abs(avatar.w * 16 - avatar.h * 9) < 0.01, "the avatar's default box is square on the 16:9 stage");
  const cat = builtinLayout()[1];
  assert.ok(cat.x + cat.w > 0.9 && cat.y + cat.h > 0.85, "the cat defaults to the lower-right");
});

test("unknown types, fields, values, and oversize widgets are rejected", () => {
  rejects({ ...base, type: "video" }, /type 'video' is not supported/);
  rejects({ ...base, type: "__proto__" }, /not supported/);
  rejects({ ...base, type: "constructor" }, /not supported/);
  rejects({ ...base, props: JSON.parse('{"__proto__": {"text": "x"}}') }, /no field 'props.__proto__'/);
  rejects({ ...base, props: { constructor: "x" } }, /no field 'props.constructor'/);
  rejects({ ...base, html: "<b>x</b>" }, /unknown widget field 'html'/);
  rejects({ ...base, props: { text: "x", onclick: "alert(1)" } }, /no field 'props.onclick'/);
  rejects({ ...base, props: { color: "#ff0000" } }, /color' must be one of/);
  rejects({ ...base, props: { size: 500 } }, /size' must be a whole number from 10 to 96/);
  rejects({ ...base, props: { text: "x".repeat(121) } }, /1-120 characters/);
  rejects({ ...base, props: { text: "spoof\u202egnp.exe" } }, /control characters/);
  rejects({ ...base, props: { text: 7 } }, /must be text/);
  rejects({ ...base, type: "metric", props: { source: "cpa.account.emails" } }, /source' must be one of/);
  rejects({ ...base, id: "Bad ID" }, /widget ID/);
  rejects({ ...base, x: 0.9, w: 0.3 }, /inside the stage/);
  rejects({ ...base, w: 0.001 }, /at least 2%/);
  rejects({ ...base, x: Infinity }, /must be a number/);
  rejects({ ...base, z: 5000 }, /'z' must be a whole number/);
  rejects([], /must be an object/);
  rejects({ ...base, props: [] }, /'props' must be an object/);
  assert.throws(() => validateLayout({ widgets: Array.from({ length: LIMITS.widgets + 1 }, (_, i) => ({ ...base, id: `w${i}` })) }), /at most 24 widgets/);
  assert.throws(() => validateLayout({ widgets: [base, base] }), /appears twice/);
  assert.throws(() => mergeWidget(validateWidget(base), { type: "image" }), /'type' cannot be changed/);
  assert.equal(mergeWidget(validateWidget(base), { props: { size: 40 } }).props.text, "Hello from the stream", "props merge field by field");
});

test("image URLs must be HTTPS and match an administrator allowlist prefix", () => {
  const allowlist = normalizeAllowlist(["https://img.example.com/stream", "https://cdn.example.org/"]);
  assert.deepEqual(allowlist, ["https://img.example.com/stream/", "https://cdn.example.org/"]);
  const image = url => ({ ...base, type: "image", props: { url } });
  assert.equal(validateWidget(image("https://img.example.com/stream/cat.png"), { allowlist }).props.url, "https://img.example.com/stream/cat.png");
  rejects(image("https://img.example.com/streamevil/cat.png"), /not on the administrator's image allowlist/, { allowlist });
  rejects(image("http://img.example.com/stream/cat.png"), /allowlist/, { allowlist });
  rejects(image("javascript:alert(1)"), /allowlist/, { allowlist });
  rejects(image("https://user:pw@img.example.com/stream/a.png"), /allowlist/, { allowlist });
  rejects(image("https://img.example.com/stream/a.png"), /allowlist/, { allowlist: [] });
  rejects({ ...base, type: "image" }, /'props.url' is required/, { allowlist });
  rejects(image(`https://cdn.example.org/${"a".repeat(600)}`), /at most 512 characters/, { allowlist });
  assert.equal(imageUrlAllowed("https://cdn.example.org/x.png#frag", allowlist), false);
  assert.throws(() => normalizeAllowlist(["http://insecure.example/"]), /HTTPS prefixes/);
  assert.throws(() => normalizeAllowlist(Array.from({ length: 17 }, (_, i) => `https://h${i}.example/`)), /at most 16/);
});

test("the CSP is strict and adds only allowlisted image origins", () => {
  const policy = contentSecurityPolicy(["https://img.example.com/stream/"]);
  for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: https://img.example.com", "connect-src 'self'", "frame-src 'self';", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(policy.includes(directive), directive);
  assert.ok(!/unsafe/.test(policy));
  assert.equal(contentSecurityPolicy().includes("img-src 'self' data:;"), true);
});

test("editor rectangles stay on stage and avatars stay square", () => {
  assert.deepEqual(fitRect({ x: 0.95, y: -0.2, w: 0.2, h: 0.2 }, "text"), { x: 0.8, y: 0, w: 0.2, h: 0.2 });
  const avatar = fitRect({ x: 0, y: 0, w: 0.9, h: 0.1 }, "avatar");
  assert.equal(avatar.h, 1);
  assert.ok(Math.abs(avatar.w - 9 / 16) < 1e-3);
});

test("embeds accept only dashboard-served allowlisted paths and default to a faint log-component backdrop", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "embed-dir-"));
  assert.deepEqual(embedPaths({ circtimeEmbedDir: dir }), [], "an empty mount point leaves the embed off");
  writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
  const embeds = embedPaths({ circtimeEmbedDir: dir });
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(embeds, ["/embed/circtime/"]);
  assert.deepEqual(embedPaths({ circtimeEmbedDir: "" }), [], "no directory, no embeds");
  const embed = props => ({ id: "e1", type: "embed", x: 0, y: 0, w: 1, h: 1, props });
  assert.deepEqual(validateWidget(embed({ src: "/embed/circtime/" }), { embeds }).props, { src: "/embed/circtime/", attach: "log", opacity: 0.3, theme: "system" });
  rejects(embed({ src: "/embed/circtime/", attach: "player" }), /attach' must be one of log, stage/, { embeds });
  rejects(embed({ src: "/embed/circtime/", theme: "neon" }), /theme' must be one of system, dark, light/, { embeds });
  for (const src of ["/embed/other/", "https://circtime.example/", "//evil.example/embed/circtime/", "/embed/circtime/../../api/scene/layout", "javascript:alert(1)", "/embed/circtime"]) rejects(embed({ src }), /dashboard-served embeds/, { embeds });
  rejects(embed({ src: "/embed/circtime/" }), /none configured/, { embeds: [] });
  rejects(embed({}), /'props.src' is required/, { embeds });
  rejects(embed({ src: "/embed/circtime/", opacity: 0 }), /opacity' must be a number from 0.05 to 1/, { embeds });
  rejects(embed({ src: "/embed/circtime/", sandbox: "allow-same-origin" }), /no field 'props.sandbox'/, { embeds });
  const [backdrop, ...rest] = builtinLayout({ embeds });
  assert.deepEqual(backdrop, { id: "backdrop", type: "embed", x: 0, y: 0, w: 1, h: 1, z: 0, props: { src: "/embed/circtime/", attach: "log", opacity: 0.3, theme: "system" } });
  assert.deepEqual(rest.map(widget => widget.type), ["avatar", "cat"]);
  assert.deepEqual(validateLayout({ widgets: builtinLayout({ embeds }) }, { embeds }).length, 3);
  assert.equal(builtinLayout().some(widget => widget.type === "embed"), false, "no embed without a served page");
});

test("embed pages get their own policy: framable only by the dashboard, nothing external", () => {
  const policy = embedSecurityPolicy();
  for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'self'", "object-src 'none'", "frame-src 'none'", "form-action 'none'"]) assert.ok(policy.includes(directive), directive);
  assert.ok(!/unsafe|https?:|\*/.test(policy), "no unsafe-*, wildcard, or external origin");
  assert.ok(!contentSecurityPolicy().includes("frame-src 'none'") && contentSecurityPolicy().includes("frame-src 'self'"), "the dashboard frames only itself");
});


test("migration moves only the default circtime backdrop into the log component", () => {
  const embeds = ["/embed/circtime/"];
  const legacy = { id: "backdrop", type: "embed", x: 0, y: 0, w: 1, h: 1, z: 0, props: { src: "/embed/circtime/", opacity: 0.45 } };
  assert.ok(isDefaultBackdrop(legacy));
  assert.deepEqual(migrateWidget(legacy).props, { src: "/embed/circtime/", opacity: 0.45, attach: "log" }, "the owner's opacity is kept");
  // User-placed embeds stay exactly where they were: pinned to the stage.
  for (const placed of [{ ...legacy, id: "radar" }, { ...legacy, x: 0.5, w: 0.5 }, { ...legacy, id: "backdrop", props: { src: "/embed/other/", opacity: 0.3 } }]) {
    assert.equal(migrateWidget(placed).props.attach, "stage", JSON.stringify(placed));
  }
  const already = { ...legacy, props: { ...legacy.props, attach: "stage" } };
  assert.equal(migrateWidget(already), already, "an explicit attachment is never changed");
  const text = { id: "t", type: "text", x: 0, y: 0, w: 0.2, h: 0.1, props: { text: "Hi" } };
  assert.equal(migrateWidget(text), text);
  // PATCHing a widget recorded before 0.2.4 migrates it first.
  assert.equal(mergeWidget(legacy, { props: { opacity: 0.5 } }, { embeds }).props.attach, "log");
  assert.equal(mergeWidget({ ...legacy, id: "radar" }, { props: { opacity: 0.5 } }, { embeds }).props.attach, "stage");
});

test("widgets can be hidden without changing the shape of visible widgets", () => {
  const widget = { id: "t1", type: "text", x: 0.1, y: 0.1, w: 0.3, h: 0.1 };
  assert.equal("hidden" in validateWidget(widget), false);
  assert.equal("hidden" in validateWidget({ ...widget, hidden: false }), false);
  assert.equal(validateWidget({ ...widget, hidden: true }).hidden, true);
  assert.throws(() => validateWidget({ ...widget, hidden: "yes" }), /'hidden' must be true or false/);
  const hidden = mergeWidget(validateWidget(widget), { hidden: true });
  assert.equal(hidden.hidden, true);
  assert.equal("hidden" in mergeWidget(hidden, { hidden: false }), false, "showing again removes the flag");
});

test("scene settings validate and merge; defaults fill new widgets", () => {
  const base = defaultSettings();
  assert.deepEqual(base.defaults, { metric: { source: "cpa.codex.5h", color: "snow" }, avatar: { mirror: false }, cat: { mirror: false }, embed: { attach: "log", opacity: 0.3, theme: "system" } });
  assert.deepEqual(base.metricRefresh, { minutes: 5, cpa: true });
  const next = normalizeSettings({ defaults: { embed: { opacity: 0.5 }, metric: { source: "tokens.7d" } }, metricRefresh: { minutes: 10 } }, base);
  assert.deepEqual([next.defaults.embed, next.defaults.metric.source, next.metricRefresh], [{ attach: "log", opacity: 0.5, theme: "system" }, "tokens.7d", { minutes: 10, cpa: true }]);
  const kept = normalizeSettings({ imageAllowlist: ["https://img.example.com/a"] }, next);
  assert.deepEqual([kept.imageAllowlist, kept.defaults.embed.opacity, kept.metricRefresh.minutes], [["https://img.example.com/a/"], 0.5, 10], "missing keys keep their current values");
  for (const [input, pattern] of [
    [{ colour: 1 }, /unknown settings field 'colour'/],
    [{ defaults: { text: { text: "x" } } }, /type 'text' has no defaults/],
    [{ defaults: { embed: { src: "/embed/x/" } } }, /no field 'src'/],
    [{ defaults: { embed: { opacity: 2 } } }, /opacity' must be a number from 0.05 to 1/],
    [{ defaults: { metric: { source: "cpa.claude" } } }, /source' must be one of/],
    [{ metricRefresh: { minutes: 1 } }, /one of 2, 5, 10, 15, 30, 60 minutes/],
    [{ metricRefresh: { cpa: "no" } }, /'cpa' must be true or false/],
    [{ disabledEmbeds: ["https://evil.example/"] }, /dashboard embed paths/],
    [{ builtin: { clock: true } }, /no option 'clock'/],
    [{ defaults: { __proto__: { x: 1 } } }, /./],
  ]) assert.throws(() => normalizeSettings(input, base), error => pattern.test(error.reason), JSON.stringify(input));
  const filled = withDefaults({ type: "embed", props: { src: "/embed/circtime/", theme: "dark" } }, next.defaults);
  assert.deepEqual(filled.props, { src: "/embed/circtime/", theme: "dark", attach: "log", opacity: 0.5 }, "explicit props win over defaults");
  assert.deepEqual(withDefaults({ type: "metric" }, next.defaults).props, { source: "tokens.7d", color: "snow" });
  assert.deepEqual(withDefaults({ type: "text", props: { text: "Hi" } }, next.defaults).props, { text: "Hi" });
  const builtin = builtinLayout({ embeds: ["/embed/circtime/"], settings: normalizeSettings({ builtin: { cat: false }, defaults: { avatar: { mirror: true }, embed: { theme: "light" } } }, base) });
  assert.deepEqual(builtin.map(widget => widget.id), ["backdrop", "avatar"]);
  assert.deepEqual([builtin[0].props.theme, builtin[1].props.mirror], ["light", true]);
});

test("Canvas settings turns the live scene into the draft with the fewest operations", () => {
  const a = { id: "a", type: "text", x: 0.1, y: 0.1, w: 0.2, h: 0.1, z: 100, props: { text: "A", size: 28, color: "snow", align: "left", card: true } };
  const b = { id: "b", type: "cat", x: 0.7, y: 0.6, w: 0.2, h: 0.2, z: 101, props: { mirror: false } };
  const legacy = { id: "backdrop", type: "embed", x: 0, y: 0, w: 1, h: 1, z: 0, props: { src: "/embed/circtime/", opacity: 0.3 } };
  const migrated = { ...legacy, props: { src: "/embed/circtime/", attach: "log", opacity: 0.3, theme: "system" } };
  assert.deepEqual(liveDiff([a, b], [a, b]), []);
  assert.deepEqual(liveDiff([a, { ...b, props: { mirror: false } }], [{ ...a, props: { card: true, align: "left", color: "snow", size: 28, text: "A" } }, b]), [], "key order does not matter");
  const ops = liveDiff([a, b, legacy], [{ ...a, hidden: true }, migrated, { ...a, id: "c" }]);
  assert.deepEqual(ops.map(item => `${item.op}:${item.id}`), ["delete:b", "create:c", "update:a", "update:backdrop"]);
  assert.deepEqual(liveDiff([{ ...legacy, props: { ...legacy.props, theme: "system" } }], [{ ...migrated, props: { ...migrated.props } }]), [], "a legacy backdrop that only lacks attach still matches its migrated form");
});
