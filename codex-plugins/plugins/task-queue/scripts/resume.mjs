/**
 * resume — run a queued task by resuming its Codex session non-interactively.
 *
 * Uses `codex exec resume <sessionId> -` and writes the continuation prompt to
 * stdin (`-` reads the prompt from stdin), which avoids shell-quoting a prompt
 * that contains spaces. The model route is overridden when the task records one.
 */

import { spawn } from 'node:child_process';

function resolveCodexCommand() {
  if (process.env.CODEX_CLI_PATH) return { command: process.env.CODEX_CLI_PATH, useShell: false };
  // `codex` is a .cmd shim on Windows; a shell resolves PATHEXT.
  return { command: 'codex', useShell: process.platform === 'win32' };
}

export function runResume(task, timeoutMs = 0) {
  return new Promise((resolve) => {
    const { command, useShell } = resolveCodexCommand();
    const args = ['exec', 'resume', task.sessionId, '-'];
    if (task.model) args.push('-c', 'model=' + task.model);
    if (task.reasoningEffort) args.push('-c', 'model_reasoning_effort=' + task.reasoningEffort);

    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: useShell, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }

    let output = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish({ ok: false, error: 'resume timed out after ' + timeoutMs + 'ms', output: output.slice(-2000) });
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.on('error', (err) => finish({ ok: false, error: String(err?.message ?? err), output: output.slice(-2000) }));
    child.on('close', (code) => finish({ ok: code === 0, code, output: output.slice(-4000) }));

    child.stdin.write(task.prompt + '\n');
    child.stdin.end();
  });
}
