import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OpenClawConfigStore, REDACTED, redact, restore } from "./openclaw-config.js";

const sample = {
  gateway: { bind: "loopback", auth: { mode: "token", token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } } },
  channels: { telegram: { botToken: "123456:LITERAL-SECRET", groupPolicy: "allowlist" } },
  models: { providers: { cpa: { apiKey: "sk-literal", baseUrl: "https://cpa.example" } } },
  plugins: { entries: { stream: { config: { tokenFile: "/home/node/.openclaw/stream.token" } } } },
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-"));
  const file = path.join(dir, "shared", "openclaw.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(sample, null, 2) + "\n");
  return { dir, file, store: new OpenClawConfigStore({ file, backupDir: path.join(dir, "backups"), keep: 2 }) };
}

test("redaction masks literal secrets but keeps SecretRefs and file paths", () => {
  const masked = redact(sample);
  assert.equal(masked.channels.telegram.botToken, REDACTED);
  assert.equal(masked.models.providers.cpa.apiKey, REDACTED);
  assert.deepEqual(masked.gateway.auth.token, sample.gateway.auth.token);
  assert.equal(masked.plugins.entries.stream.config.tokenFile, sample.plugins.entries.stream.config.tokenFile);
  assert.ok(!JSON.stringify(masked).includes("LITERAL-SECRET"));
  assert.deepEqual(restore(masked, sample), sample);
  assert.throws(() => restore({ added: { token: REDACTED } }, sample), /no stored original/);
});

test("saves are validated, concurrency-checked, backed up, and atomic", () => {
  const { dir, file, store } = fixture();
  try {
    const view = store.view();
    assert.equal(view.config.channels.telegram.botToken, REDACTED);
    assert.throws(() => store.save("{ not json", view.hash), error => error.status === 400 && /invalid JSON/.test(error.message));
    assert.throws(() => store.save("[]", view.hash), error => error.status === 400);
    assert.throws(() => store.save(JSON.stringify(view.config), "stale"), error => error.status === 409);
    assert.equal(store.save(JSON.stringify(view.config), view.hash).changed, false, "an unchanged config is not rewritten");

    const edited = structuredClone(view.config);
    edited.channels.telegram.groupPolicy = "disabled";
    const saved = store.save(JSON.stringify(edited), view.hash);
    assert.equal(saved.changed, true);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(written.channels.telegram.groupPolicy, "disabled");
    assert.equal(written.channels.telegram.botToken, "123456:LITERAL-SECRET", "masked secret restored from the live file");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["openclaw.json"], "no temp files left beside the config");
    assert.equal(fs.readdirSync(path.join(dir, "backups")).length, 1);
    assert.throws(() => store.save(JSON.stringify(edited), view.hash), error => error.status === 409, "old hash rejected after a save");

    for (const policy of ["open", "allowlist", "disabled"]) {
      const current = store.view();
      store.save(JSON.stringify({ ...current.config, channels: { telegram: { ...current.config.channels.telegram, groupPolicy: policy } } }), current.hash);
    }
    assert.equal(fs.readdirSync(path.join(dir, "backups")).length, 2, "backups are pruned to the configured count");
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("missing or unwritable config reports a clear status", () => {
  const { dir, file, store } = fixture();
  try {
    fs.chmodSync(path.dirname(file), 0o500);
    const view = store.view();
    if (process.getuid?.() !== 0) assert.throws(() => store.save(JSON.stringify({ ...view.config, x: 1 }), view.hash), error => error.status === 503 && /not writable/.test(error.message));
    fs.chmodSync(path.dirname(file), 0o700);
    fs.rmSync(file);
    assert.throws(() => store.view(), error => error.status === 503);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
