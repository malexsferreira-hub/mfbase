// MF Base (Touchline) server — plain Node core `http` (no Express), so the
// only external runtime dependency for the whole app is `pg`. Serves the
// static frontend, gates it behind a shared-password login, and exposes a
// tiny JSON API (GET/PUT /api/db) backed by Postgres for real, durable,
// cross-device persistence.
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const auth = require("./lib/auth");

const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const LOGIN_PAGE = function (error) {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>MF Base</title><style>" +
    "body{font-family:-apple-system,system-ui,sans-serif;background:#f4f1ea;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}" +
    ".card{background:#fff;padding:32px 28px;border-radius:14px;box-shadow:0 2px 20px rgba(0,0,0,.08);width:100%;max-width:320px;}" +
    "h1{font-size:20px;margin:0 0 18px;}" +
    "input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:12px;}" +
    "button{width:100%;padding:11px;border:none;border-radius:8px;background:#b8860b;color:#fff;font-size:15px;font-weight:600;cursor:pointer;}" +
    ".err{color:#b3261e;font-size:13px;margin:-6px 0 12px;}" +
    "</style></head><body><div class=\"card\"><h1>MF Base</h1>" +
    "<form method=\"POST\" action=\"/login\">" +
    (error ? "<div class=\"err\">Password incorreta.</div>" : "") +
    "<input type=\"password\" name=\"password\" placeholder=\"Password\" autofocus required>" +
    "<button type=\"submit\">Entrar</button>" +
    "</form></div></body></html>"
  );
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, headers || {}));
  res.end(body);
}
function sendJson(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}));
}
function readBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > limitBytes) {
        // Stop buffering (avoid holding an unbounded body in memory) but keep draining the
        // stream to a normal end — destroying the socket mid-stream causes an abrupt
        // connection reset on the client instead of a clean 413 response.
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      if (tooLarge) return reject(Object.assign(new Error("payload too large"), { code: "TOO_LARGE" }));
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}
function parseFormOrJson(bodyBuf, contentType) {
  const text = bodyBuf.toString("utf8");
  if (contentType && contentType.indexOf("application/json") >= 0) {
    try { return JSON.parse(text || "{}"); } catch (e) { return {}; }
  }
  const out = {};
  text.split("&").forEach(function (pair) {
    if (!pair) return;
    const idx = pair.indexOf("=");
    const k = decodeURIComponent((idx === -1 ? pair : pair.slice(0, idx)).replace(/\+/g, " "));
    const v = idx === -1 ? "" : decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " "));
    out[k] = v;
  });
  return out;
}

function safeStaticPath(reqPath) {
  // Serve "/" as index.html; block any path traversal outside PUBLIC_DIR.
  let rel = reqPath === "/" ? "/index.html" : reqPath;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

function serveStatic(res, reqPath) {
  const full = safeStaticPath(reqPath);
  if (!full) return send(res, 400, "Bad request");
  fs.readFile(full, function (err, data) {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(full);
    send(res, 200, data, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600" });
  });
}

// `db` implements {init, getDb, saveDb} — either lib/db.js (real Postgres) in
// production, or lib/db.memory.js in tests. `opts.appPassword` / `opts.sessionSecret`
// are read from env in the production entry point (bin/www.js).
function createServer(db, opts) {
  opts = opts || {};
  const appPassword = opts.appPassword;
  const sessionSecret = opts.sessionSecret;
  const secureCookies = opts.secureCookies !== false;

  if (!appPassword || !sessionSecret) {
    throw new Error("createServer requires opts.appPassword and opts.sessionSecret");
  }

  return http.createServer(function (req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsed.pathname || "/");
    const authed = auth.isAuthenticated(req.headers.cookie, sessionSecret);

    (async function () {
      try {
        // ---- Auth routes (public) ----
        if (pathname === "/login" && req.method === "GET") {
          return send(res, 200, LOGIN_PAGE(parsed.query && parsed.query.error === "1"), { "Content-Type": "text/html; charset=utf-8" });
        }
        if (pathname === "/login" && req.method === "POST") {
          const bodyBuf = await readBody(req, 10 * 1024);
          const fields = parseFormOrJson(bodyBuf, req.headers["content-type"]);
          if (auth.checkPassword(fields.password, appPassword)) {
            return send(res, 302, "", { Location: "/", "Set-Cookie": auth.setCookieHeader(sessionSecret, { secure: secureCookies }) });
          }
          return send(res, 302, "", { Location: "/login?error=1" });
        }
        if (pathname === "/logout") {
          return send(res, 302, "", { Location: "/login", "Set-Cookie": auth.clearCookieHeader() });
        }

        // ---- Everything else requires a valid session ----
        if (!authed) {
          if (pathname.indexOf("/api/") === 0) return sendJson(res, 401, { error: "unauthorized" });
          return send(res, 302, "", { Location: "/login" });
        }

        // ---- API ----
        if (pathname === "/api/db" && req.method === "GET") {
          const result = await db.getDb();
          return sendJson(res, 200, result);
        }
        if (pathname === "/api/db" && req.method === "PUT") {
          const bodyBuf = await readBody(req, 25 * 1024 * 1024); // 25MB ceiling — plenty for this app's data
          let data;
          try { data = JSON.parse(bodyBuf.toString("utf8")); } catch (e) { return sendJson(res, 400, { error: "invalid_json" }); }
          if (!data || typeof data !== "object") return sendJson(res, 400, { error: "invalid_body" });
          const result = await db.saveDb(data);
          return sendJson(res, 200, { ok: true, updatedAt: result.updatedAt });
        }
        if (pathname.indexOf("/api/") === 0) {
          return sendJson(res, 404, { error: "not_found" });
        }

        // ---- Static app shell ----
        if (req.method === "GET" || req.method === "HEAD") {
          return serveStatic(res, pathname);
        }
        return send(res, 405, "Method not allowed");
      } catch (err) {
        if (err && err.code === "TOO_LARGE") return sendJson(res, 413, { error: "payload_too_large" });
        console.error("Request error:", err);
        return sendJson(res, 500, { error: "server_error" });
      }
    })();
  });
}

module.exports = { createServer };
