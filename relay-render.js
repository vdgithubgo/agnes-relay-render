// relay-render.js — Agnes relay for Render (temporary, replaces Cloudflare Worker for HF).
// Why Render, not Workers: HF shared egress IP is blocked by Cloudflare edge itself:
//   HF -> apihub.agnes-ai.com = HTML 403, HF -> *.workers.dev = TLS handshake drop (SSL_ERROR_SYSCALL, 15s).
//   HF -> Render works (n/ models go through new-api on Render), Render -> Agnes works (new-api Agnes channel).
//   So HF -> Render relay -> Agnes should bypass both blocks.
// Deploy: Render -> New Web Service -> from a Git repo containing this file + package.json
//   Build Command: (none, no deps)   Start Command: node relay-render.js
//   Environment: RELAY_TOKEN = <long random string, Secret type>  (reuse the Worker token, or choose a new one)
//   Port: Render sets PORT env, app listens on it. Free tier sleeps after 15 min idle, wake ~60s —
//   first request after sleep may exceed the gateway 15s timeout; ping /health every 13 min in daytime to keep awake.
// Behaviour (same contract as relay-worker.js v2, so o/h v81/v18 need NO code change, only AGNES_RELAY_URL host):
//   GET /health -> {"ok":true,"token_configured":bool}   (does NOT touch Agnes)
//   /r/<RELAY_TOKEN>/... -> forward to https://apihub.agnes-ai.com/... preserving path+query+method,
//     forwarding ONLY Authorization and Content-Type headers, streaming response back (chat SSE works).
//   Wrong token / wrong path -> 404 "not found" (do not leak which part was wrong).
//   No logging of Authorization, prompt, or body. Only method, path prefix, upstream status, and timing.
// Usage in HF: AGNES_RELAY_URL = https://<render-service>.onrender.com/r/<RELAY_TOKEN>  (no trailing slash)
//   then Restart (not rebuild) the Space. Worker URL is then abandoned, do NOT delete Worker yet (keep as fallback).
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = parseInt(process.env.PORT || "10000", 10);
const TOKEN = process.env.RELAY_TOKEN || "";
const UPSTREAM = "https://apihub.agnes-ai.com";

function log(msg) {
  console.log(`[relay-render] ${new Date().toISOString()} ${msg}`);
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, token_configured: !!TOKEN }));
      return;
    }
    const m = u.pathname.match(/^\/r\/([^\/]+)(\/.*)?$/);
    if (!m || !TOKEN || m[1] !== TOKEN) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const rest = m[2] || "/";
    const upstreamUrl = new URL(rest + u.search, UPSTREAM);
    const headers = {};
    if (req.headers["authorization"]) headers["authorization"] = req.headers["authorization"];
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    const t0 = Date.now();
    const up = https.request(
      upstreamUrl,
      { method: req.method, headers },
      (upRes) => {
        const outHeaders = {};
        if (upRes.headers["content-type"]) outHeaders["content-type"] = upRes.headers["content-type"];
        outHeaders["x-relay-route"] = "render";
        res.writeHead(upRes.statusCode || 502, outHeaders);
        upRes.pipe(res);
        upRes.on("end", () => log(`${req.method} ${rest} -> ${upRes.statusCode} ${Date.now() - t0}ms`));
      }
    );
    up.on("error", (e) => {
      log(`upstream error ${rest}: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "relay upstream error" }));
      } else {
        res.end();
      }
    });
    req.pipe(up);
  } catch (e) {
    log(`handler error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "relay error" }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => log(`listening on ${PORT}, token_configured=${!!TOKEN}`));
