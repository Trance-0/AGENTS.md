import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodingConfigStore } from "./coding-config.js";

test("coding policy validates model order and effort, masks provider credentials, and detects conflicting edits", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ provider: { cpa: { options: { baseURL: "https://example.test/v1", apiKey: "must-stay-private" }, models: { opus: { name: "Opus" } } }, deepseek: { options: { baseURL: "https://api.deepseek.com", apiKey: "" }, models: { flash: {} } } } }));
  const store = new CodingConfigStore({ file: path.join(dir, "policy.json"), backupDir: path.join(dir, "backups") });
  const view = store.view();
  assert.equal(view.config.chain.length, 4);
  assert.equal(JSON.stringify(view).includes("must-stay-private"), false);
  assert.equal(view.models.find(model => model.ref === "deepseek/flash").configured, false);
  for (const chain of [[], [{ model: "bad", effort: "high" }], [{ model: "cpa/opus", effort: "bogus" }], [{ model: "cpa/opus", effort: "high" }, { model: "cpa/opus", effort: "low" }]]) {
    assert.throws(() => store.save(JSON.stringify({ chain }), view.hash), { status: 400 });
  }
  const saved = store.save(JSON.stringify({ chain: [...view.config.chain].reverse() }), view.hash);
  assert.equal(saved.config.chain[0].model, "vllm/nvidia/Qwen3.8-27B-NVFP4");
  assert.equal(store.listBackups().backups.length, 1);
  assert.throws(() => store.save(JSON.stringify(view.config), view.hash), { status: 409 });
});
