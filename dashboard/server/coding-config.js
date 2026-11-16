import fs from "node:fs";
import path from "node:path";
import { OpenClawConfigStore } from "./openclaw-config.js";

export const EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh"];
const invalid = cause => Object.assign(new Error(`Config cannot be saved: dashboard/openclaw config — coding model policy ${cause}.`), { status: 400 });

export class CodingConfigStore extends OpenClawConfigStore {
  constructor(options) {
    super(options);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, `${JSON.stringify({
      chain: [
        { model: "cpa/claude-opus-5-5-high", effort: "high" },
        { model: "cpa/gpt-6-astra", effort: "high" },
        { model: "deepseek/deepseek-v4-flash", effort: "medium" },
        { model: "vllm/nvidia/Qwen3.8-27B-NVFP4", effort: "default" },
      ],
    }, null, 2)}\n`, { mode: 0o600 });
  }

  view() {
    const view = super.view();
    let providers = {};
    try { providers = JSON.parse(fs.readFileSync(path.join(path.dirname(this.file), "opencode.json"), "utf8")).provider || {}; }
    catch (error) { view.catalogError = `Model availability unknown: dashboard/coding catalog — OpenCode config cannot be read (${error.code || "invalid JSON"}).`; }
    view.models = Object.entries(providers).flatMap(([provider, data]) => Object.entries(data.models || {}).map(([id, model]) => ({
      ref: `${provider}/${id}`, name: model.name || id,
      efforts: model.reasoning === false ? ["default"] : model.variants ? ["default", ...Object.keys(model.variants)] : EFFORTS,
      configured: !!data.options?.baseURL && (provider === "vllm" || provider === "local-vllm" || !!data.options?.apiKey),
    })));
    return view;
  }

  save(text, baseHash) {
    let policy;
    try { policy = JSON.parse(text); } catch { throw invalid("must be valid JSON"); }
    if (!Array.isArray(policy?.chain) || !policy.chain.length || policy.chain.length > 16) throw invalid("needs between 1 and 16 models");
    const seen = new Set();
    const models = this.view().models;
    for (const entry of policy.chain) {
      if (typeof entry?.model !== "string" || !/^[^/\s]+\/\S+$/.test(entry.model)) throw invalid("models must use provider/model IDs");
      if (seen.has(entry.model)) throw invalid("cannot contain duplicate models");
      seen.add(entry.model);
      if (!EFFORTS.includes(entry.effort)) throw invalid("has an unsupported reasoning effort");
      const model = models.find(item => item.ref === entry.model);
      if (model && !model.efforts.includes(entry.effort)) throw invalid(`effort for ${entry.model} must be one of ${model.efforts.join(", ")}`);
    }
    return super.save(text, baseHash);
  }
}
