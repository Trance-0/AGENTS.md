import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

// Static server for one read-only embed build (circtime) under /embed/<name>/.
//
// The embed runs in a sandboxed iframe without allow-same-origin, so its
// document has an opaque origin and every module script, stylesheet, and
// fetch it makes is a cross-origin (CORS) request. This path therefore sends
// Access-Control-Allow-Origin: * (never credentials) for GET/HEAD only: the
// content is a public, sanitized status page and needs no cookies.
// Text assets are gzip/brotli compressed in-process (node:zlib, no new
// dependency) and cached by size + mtime, because circtime rewrites its JSON
// every minute and the history file is several MB.
const COMPRESSIBLE = new Set([".json", ".js", ".mjs", ".css", ".html", ".svg"]);
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const MAX_CACHE = 32;

function cacheControl(relative) {
  if (relative.endsWith(".json") || relative.endsWith(".html")) return "no-cache";
  // Vite emits content-hashed names under assets/.
  if (/^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(relative)) return "public, max-age=31536000, immutable";
  return "no-cache";
}

export function embedStatic(root) {
  const base = path.resolve(root);
  const compressed = new Map();
  const refuse = (res, status, reason) => res.status(status).type("text/plain").send(`Embed unavailable: dashboard/scene embeds — ${reason}.`);
  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Allow", "GET, HEAD");
      return refuse(res, 405, "only GET and HEAD requests are served");
    }
    // Relative asset URLs need the trailing slash on the entry URL.
    const [pathname, query = ""] = req.originalUrl.split("?");
    if (pathname === req.baseUrl) return res.redirect(301, `${req.baseUrl}/${query ? `?${query}` : ""}`);
    let relative;
    try { relative = decodeURIComponent(req.path).replace(/^\/+/, ""); }
    catch { return refuse(res, 400, "the path is not valid URL encoding"); }
    if (relative === "" || relative.endsWith("/")) relative += "index.html";
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep) || relative.split("/").some(part => part.startsWith(".") || part === "")) return refuse(res, 404, "the path is outside the embed or hidden");
    let stat;
    try { stat = await fs.promises.stat(file); }
    catch { return refuse(res, 404, "no such file in the embed build"); }
    if (stat.isDirectory()) return res.redirect(301, `${req.baseUrl}${req.path}/`);
    if (!stat.isFile()) return refuse(res, 404, "not a regular file");
    const extension = path.extname(file).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.set({ "Access-Control-Allow-Origin": "*", "Cache-Control": cacheControl(relative), ETag: etag, Vary: "Accept-Encoding", "Last-Modified": stat.mtime.toUTCString() });
    res.type(extension);
    if (req.get("if-none-match") === etag) return res.status(304).end();
    if (!COMPRESSIBLE.has(extension)) return fs.createReadStream(file).on("error", next).pipe(res);
    const accepts = req.get("accept-encoding") || "";
    const encoding = /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gzip" : null;
    try {
      if (!encoding) { res.set("Content-Length", String(stat.size)); return req.method === "HEAD" ? res.end() : fs.createReadStream(file).on("error", next).pipe(res); }
      const key = `${encoding}:${file}`;
      let entry = compressed.get(key);
      if (!entry || entry.etag !== etag) {
        const raw = await fs.promises.readFile(file);
        const body = encoding === "br" ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : await gzip(raw, { level: 6 });
        entry = { etag, body };
        compressed.delete(key);
        compressed.set(key, entry);
        if (compressed.size > MAX_CACHE) compressed.delete(compressed.keys().next().value);
      }
      res.set({ "Content-Encoding": encoding, "Content-Length": String(entry.body.length) });
      return req.method === "HEAD" ? res.end() : res.end(entry.body);
    } catch (error) { next(error); }
  };
}
