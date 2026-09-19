/**
 * task-queue store — durable, importance-ordered task records.
 *
 * Persists to `~/.codex/task-queue.json`. A task binds a continuation prompt to
 * an existing Codex session, plus the model route to resume under. Display
 * order is derived at read time (importance desc, then oldest update, then id).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const STORE_PATH = path.join(CODEX_HOME, 'task-queue.json');

export function storePath() {
  return STORE_PATH;
}

export async function loadTasks() {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(await readFile(STORE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveTasks(tasks) {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(tasks, null, 2) + '\n', 'utf8');
}

function now() {
  return new Date().toISOString();
}

/** importance desc, then oldest update, then id. */
function ordered(tasks) {
  return tasks.slice().sort((a, b) => {
    if (b.importance !== a.importance) return (b.importance ?? 0) - (a.importance ?? 0);
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

export async function createTask(input) {
  const tasks = await loadTasks();
  const importance = Number(input?.importance ?? 3);
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) throw new Error('importance 必须是 1–5 的整数');
  const sessionId = String(input?.sessionId ?? '').trim();
  const prompt = String(input?.prompt ?? '').trim();
  if (sessionId === '') throw new Error('sessionId 不能为空');
  if (prompt === '') throw new Error('prompt 不能为空');

  const task = {
    id: randomUUID(),
    title: String(input?.title ?? '').trim() || prompt.slice(0, 40),
    importance,
    model: typeof input?.model === 'string' && input.model.trim() !== '' ? input.model.trim() : null,
    reasoningEffort: typeof input?.reasoningEffort === 'string' && input.reasoningEffort.trim() !== '' ? input.reasoningEffort.trim() : null,
    sessionId,
    prompt,
    status: 'pending',
    createdAt: now(),
    updatedAt: now(),
  };
  tasks.push(task);
  await saveTasks(tasks);
  return task;
}

export async function listTasks() {
  return ordered(await loadTasks());
}

export async function getTask(id) {
  const tasks = await loadTasks();
  return tasks.find((task) => task.id === id);
}

export async function setStatus(id, status) {
  if (!['pending', 'running', 'done', 'failed'].includes(status)) throw new Error('未知状态: ' + status);
  const tasks = await loadTasks();
  const task = tasks.find((entry) => entry.id === id);
  if (task === undefined) return null;
  if (task.status === status) return task;
  task.status = status;
  task.updatedAt = now();
  await saveTasks(tasks);
  return task;
}

export async function deleteTask(id) {
  const tasks = await loadTasks();
  const next = tasks.filter((task) => task.id !== id);
  if (next.length !== tasks.length) await saveTasks(next);
  return next.length !== tasks.length;
}

export async function pickNext() {
  const pending = (await listTasks()).filter((task) => task.status === 'pending');
  return pending[0] ?? null;
}
