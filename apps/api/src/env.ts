import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load the repo-root .env regardless of which app directory we run from.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });
config();

/**
 * Detect the machine's LAN IPv4 so phones on the same Wi-Fi can reach
 * Metro for the Expo Go QR code. Prefers home-router ranges (192.168.x)
 * over VPN/virtual adapters (10.x, 172.16-31.x).
 */
function detectLanIp(): string | null {
  const candidates: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        candidates.push(iface.address);
      }
    }
  }
  const score = (ip: string): number => {
    if (ip.startsWith("192.168.")) return 3;
    if (ip.startsWith("10.")) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
    return 0;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] ?? null;
}

function resolvePublicHost(): string {
  const configured = process.env.PUBLIC_HOST ?? "auto";
  if (configured !== "auto" && configured !== "localhost") return configured;
  const lan = detectLanIp();
  if (lan) {
    console.log(`[env] PUBLIC_HOST=${configured} -> using LAN IP ${lan} for preview/QR URLs`);
    return lan;
  }
  return "localhost";
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const env = {
  databaseUrl: req("DATABASE_URL"),
  redisUrl: req("REDIS_URL", "redis://localhost:6379"),
  jwtSecret: req("JWT_SECRET", "dev-secret"),

  deepinfraApiKey: req("DEEPINFRA_API_KEY"),
  deepinfraBaseUrl: req("DEEPINFRA_BASE_URL", "https://api.deepinfra.com/v1/openai"),
  fireworksApiKey: process.env.FIREWORKS_API_KEY ?? "",
  fireworksBaseUrl: req("FIREWORKS_BASE_URL", "https://api.fireworks.ai/inference/v1"),
  modelBuild: req("MODEL_BUILD", "moonshotai/Kimi-K2.6"),
  modelChat: req("MODEL_CHAT", "Qwen/Qwen3.6-35B-A3B"),
  /** Edits run on Fireworks for speed; falls back to MODEL_BUILD on DeepInfra if unset. */
  modelEdit: process.env.MODEL_EDIT ?? "accounts/fireworks/models/kimi-k2p6",

  apiPort: Number(req("API_PORT", "4000")),
  proxyPort: Number(req("PROXY_PORT", "4100")),
  publicHost: resolvePublicHost(),

  goldenImage: req("GOLDEN_IMAGE", "appable/expo-template:latest"),
  idleTimeoutMinutes: Number(req("IDLE_TIMEOUT_MINUTES", "15")),
};
