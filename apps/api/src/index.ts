import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import { getDb } from "@appable/db";
import { env } from "./env.js";
import { authRoutes } from "./auth.js";
import { ideaRoutes } from "./ideas.js";
import { projectRoutes } from "./projects.js";
import { wsRoutes } from "./ws.js";
import { startIdleSweeper } from "./orchestrator.js";

/**
 * If the API died mid-build (deploy, crash, tsx restart), projects stay
 * stuck in "building" forever. Recover them to a sane state on boot.
 */
async function recoverStuckBuilds(): Promise<void> {
  const db = getDb();
  const stuck = await db.project.updateMany({
    where: { status: "building" },
    data: { status: "error" },
  });
  if (stuck.count > 0) {
    console.log(`[recovery] reset ${stuck.count} project(s) stuck in 'building' to 'error'`);
  }
}

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: "info" } });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.jwtSecret });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(ideaRoutes);
  await app.register(projectRoutes);
  await app.register(wsRoutes);

  await recoverStuckBuilds();
  startIdleSweeper();

  await app.listen({ port: env.apiPort, host: "0.0.0.0" });
  console.log(`[api] listening on :${env.apiPort}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
