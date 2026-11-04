export function hostReply(body) {
  const choice = body?.choices?.[0];
  const text = choice?.message?.content;
  if (body?.error || choice?.finish_reason === "error") throw new Error("gateway reported a provider failure");
  if (typeof text !== "string" || !text.trim()) throw new Error("gateway returned no assistant text");
  const reply = text.trim();
  // OpenClaw can return its user-facing failure text inside an HTTP 200 completion.
  // Such responses must not be displayed as a successful host utterance.
  if (/^(?:\u26a0\uFE0F?\s*)?(?:LLM request rejected:|Agent failed before reply:|All models failed\b|API rate limit reached\b)/i.test(reply)) {
    const cause = /(?:invalid|missing).*signature|signature.*(?:invalid|missing)/i.test(reply)
      ? "gateway provider rejected a stored thinking signature"
      : /rate limit/i.test(reply) ? "gateway provider rate limit was reached"
        : "gateway reported a provider failure";
    throw new Error(cause);
  }
  return { text: reply.slice(0, 12000), ...(typeof body.id === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(body.id) ? { runId: body.id } : {}) };
}
