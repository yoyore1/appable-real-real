import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import http from "node:http";

// Load the repo-root .env regardless of which app directory we run from.
config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });
config();
import httpProxy from "http-proxy";
import { Redis } from "ioredis";

/**
 * Preview proxy. Routes path-prefixed requests to the right project
 * container:
 *
 *   /p/<projectId>/...  ->  127.0.0.1:<port>/...
 *
 * Port registry lives in Redis (written by the API's orchestrator).
 * In production this becomes wildcard-subdomain routing; the lookup
 * logic stays identical.
 */

const PROXY_PORT = Number(process.env.PROXY_PORT ?? "4100");
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const redis = new Redis(REDIS_URL);
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

proxy.on("error", (err, _req, res) => {
  console.error("[proxy] upstream error:", err.message);
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("App preview is not running");
  }
});

interface Route {
  port: number;
  rest: string;
}

async function resolveRoute(url: string): Promise<Route | null> {
  const match = url.match(/^\/p\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const [, projectId, rest] = match;
  const port = await redis.get(`appable:route:${projectId}`);
  if (!port) return null;
  return { port: Number(port), rest: rest || "/" };
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const route = await resolveRoute(req.url ?? "");
  if (!route) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Unknown preview");
    return;
  }

  req.url = route.rest;
  proxy.web(req, res, { target: `http://127.0.0.1:${route.port}` });
});

server.on("upgrade", async (req, socket, head) => {
  const route = await resolveRoute(req.url ?? "");
  if (!route) {
    socket.destroy();
    return;
  }
  req.url = route.rest;
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${route.port}` });
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`[proxy] listening on :${PROXY_PORT}`);
});
