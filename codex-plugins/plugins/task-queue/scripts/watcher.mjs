#!/usr/bin/env node
/**
 * task-queue watcher — background daemon.
 *
 * Polls CPA quota and, on the unavailable→available reset edge, resumes the
 * highest-importance pending task headless via `codex exec resume`. This is the
 * Codex port of the dsh `task-runner` + `cliproxy-quota` auto-start loop.
 *
 * Usage:
 *   node watcher.mjs [pollIntervalSeconds]
 *
 * Run it detached (e.g. a scheduled task or a terminal) so it keeps watching
 * while the workstation idles. A transient network failure never flips the
 * reset edge: only a definitive provider response does.
 */

import { pickNext, setStatus, listTasks } from './store.mjs';
import { runResume } from './resume.mjs';
import { checkQuota } from './quota.mjs';

const interval = Number(process.argv[2] ?? 30);
const pollSeconds = Number.isFinite(interval) && interval >= 5 ? interval : 30;

let previousAvailable = null;
let driving = false;

async function drive() {
  if (driving) return;
  driving = true;
  try {
    const task = await pickNext();
    if (task === null) {
      console.log('[task-queue] 没有待办任务');
      return;
    }
    console.log('[task-queue] 配额已恢复，恢复任务', task.title, '(重要度 ' + task.importance + ')');
    await setStatus(task.id, 'running');
    const result = await runResume(task, 0);
    await setStatus(task.id, result.ok ? 'done' : 'failed');
    console.log('[task-queue] 任务', task.id, result.ok ? '完成' : '失败', result.error ? '：' + result.error : '');
  } finally {
    driving = false;
  }
}

async function tick() {
  const quota = await checkQuota();

  if (quota.available === true && previousAvailable === false) {
    // unavailable → available reset edge.
    await drive();
  }
  if (quota.available !== null) {
    previousAvailable = quota.available;
  }

  const pending = (await listTasks()).filter((task) => task.status === 'pending').length;
  console.log(
    '[task-queue] 配额可用=' + quota.available +
    (quota.remaining !== null ? '，剩余=' + quota.remaining : '') +
    '，待办=' + pending,
  );

  setTimeout(tick, pollSeconds * 1000);
}

console.log('[task-queue] 守护进程已启动，轮询间隔 ' + pollSeconds + ' 秒');
tick().catch((error) => {
  console.error('[task-queue] 轮询失败:', String(error?.message ?? error));
  setTimeout(tick, pollSeconds * 1000);
});
