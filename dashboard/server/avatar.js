import { config } from "./config.js";

export function avatarUrl(userinfo) {
  const value = userinfo.picture || userinfo.avatar || userinfo.Avatar;
  if (!value) return null;
  try {
    const url = new URL(value, config.oidc.issuer);
    return url.origin === new URL(config.oidc.issuer).origin ? url.href : null;
  } catch { return null; }
}

export async function serveAvatar(req, res, next) {
  try {
    const url = req.session.user.avatarUrl;
    if (!url) return res.status(404).json({ error: "Avatar unavailable: dashboard/avatar lookup — identity provider has no supported avatar URL." });
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const type = response.headers.get("content-type")?.split(";")[0];
    if (!response.ok || !["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/x-icon"].includes(type)) throw new Error("identity provider did not return a supported image");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("avatar exceeds the 2 MB image limit"); }
      chunks.push(chunk);
    }
    res.set({ "Content-Type": type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }).send(Buffer.concat(chunks));
  } catch (error) { next(Object.assign(new Error(`Avatar unavailable: dashboard/avatar download — ${error.message}`), { status: 502 })); }
}
