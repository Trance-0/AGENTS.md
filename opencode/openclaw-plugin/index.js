import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";
import { OpenCodeRuntime } from "./runtime.js";

export default {
  id: "opencode-server",
  name: "OpenCode Server",
  register(api) {
    const runtime = new OpenCodeRuntime(api.pluginConfig);
    api.on("before_prompt_build", () => ({
      appendSystemContext: "OpenCode is available as a persistent coding harness through ACP. For complex coding/debugging tasks needing repeated tool/test cycles, delegate with sessions_spawn({runtime:'acp', agentId:'opencode', mode:'run', streamTo:'parent', cwd:<the relevant workspace directory>, task:<complete task and relevant context>}). Use a host working directory, or the current workspace (translated by the backend). Preserve user authorization and identity boundaries when passing context. Do not report completion from a queued acknowledgement: use sessions_yield to release the parent turn and wait for the final result and verification. AstrBot broker tasks are durably monitored by PCP and report progress and completion/blockers back to the original chat; do not launch duplicate workers to poll. The owner can inspect the same session in the OpenCode desktop UI. Resume with resumeSessionId; do not launch a competing turn while the UI is running the session. Use /acp model provider/model and /acp set variant high when a model change is requested. Permissions and questions are handled in the OpenCode UI; never silently approve them.",
    }));
    api.registerService({
      id: "opencode-server-runtime",
      async start(ctx) {
        registerAcpRuntimeBackend({ id: "opencode-server", runtime });
        const report = await runtime.doctor();
        ctx.logger[report.ok ? "info" : "warn"](report.message);
      },
      async stop() { unregisterAcpRuntimeBackend("opencode-server"); },
    });
  },
};
