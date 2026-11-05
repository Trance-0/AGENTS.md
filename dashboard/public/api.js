// Shared browser helpers: DOM lookup, same-origin JSON requests, escaping.

export const $ = selector => document.querySelector(selector);

// Every request carries the same-origin X-Dashboard-Request header that admin
// mutations require (see requireCsrf in server/index.js).
export async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", "X-Dashboard-Request": "1", ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request unavailable: dashboard/browser request — server returned HTTP ${response.status}.`);
  }
  return response.json();
}

export function report(error, element = $("#page-status")) {
  element.hidden = false;
  element.textContent = error.message || String(error);
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
