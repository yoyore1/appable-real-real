import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { parseClientMessage, serializeEvent } from "@appable/shared";
import { getDb } from "@appable/db";
import type { AuthUser } from "./auth.js";
import { addSocket, removeSocket, emit } from "./events.js";
import { handleChat } from "./interview.js";
import { runBuild, runEdit, cancelBuild, isBuilding } from "./agent/loop.js";
import { restoreCheckpoint, touch } from "./orchestrator.js";

/**
 * WS gateway: one socket per open project.
 * Connect with: ws://host/ws?projectId=...&token=<jwt>
 */
export async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, async (socket: WebSocket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const projectId = url.searchParams.get("projectId");
    const token = url.searchParams.get("token");

    // Register the message listener synchronously and buffer anything that
    // arrives while we're still authenticating, so early messages from
    // fast clients are never dropped.
    const pending: string[] = [];
    let ready = false;

    const process = (raw: string) => {
      const msg = parseClientMessage(raw);
      if (!msg || !projectId) return;
      void handleMessage(projectId, msg).catch((err) => {
        console.error(`[ws] error handling ${msg.type} for ${projectId}:`, err);
        emit(projectId, {
          type: "error",
          code: "internal",
          message: err instanceof Error ? err.message : "Internal error",
        });
      });
    };

    socket.on("message", (raw: Buffer) => {
      const text = raw.toString("utf8");
      if (ready) process(text);
      else pending.push(text);
    });

    let user: AuthUser;
    try {
      user = app.jwt.verify<AuthUser>(token ?? "");
    } catch {
      socket.send(serializeEvent({ type: "error", code: "unauthorized", message: "Invalid token" }));
      socket.close();
      return;
    }

    if (!projectId) {
      socket.close();
      return;
    }

    const db = getDb();
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== user.userId) {
      socket.send(serializeEvent({ type: "error", code: "not_found", message: "Project not found" }));
      socket.close();
      return;
    }

    addSocket(projectId, socket);
    socket.on("close", () => removeSocket(projectId, socket));

    socket.send(serializeEvent({ type: "project.status", status: project.status as never }));

    ready = true;
    for (const raw of pending) process(raw);
    pending.length = 0;
  });
}

async function handleMessage(
  projectId: string,
  msg: NonNullable<ReturnType<typeof parseClientMessage>>,
): Promise<void> {
  switch (msg.type) {
    case "chat.send": {
      await touch(projectId).catch(() => {});
      if (msg.conversation === "build") {
        // Edit mode: change requests against the already-built app.
        // Long-running; progress streams via agent.status / build.event.
        void runEdit(projectId, msg.text);
      } else {
        await handleChat(projectId, msg.conversation, msg.text);
      }
      break;
    }
    case "build.start": {
      if (isBuilding(projectId)) {
        emit(projectId, {
          type: "error",
          code: "already_building",
          message: "A build is already in progress",
        });
        return;
      }
      const db = getDb();
      const project = await db.project.findUnique({ where: { id: projectId } });
      if (!project?.paidAt) {
        emit(projectId, {
          type: "error",
          code: "payment_required",
          message: "Complete the $1 payment to start your build",
        });
        return;
      }
      // Long-running; runs in background, streams progress via events.
      void runBuild(projectId);
      break;
    }
    case "build.cancel": {
      cancelBuild(projectId);
      break;
    }
    case "checkpoint.restore": {
      await restoreCheckpoint(projectId, msg.checkpointId);
      emit(projectId, {
        type: "agent.status",
        status: "idle",
        message: "Restored to your saved version.",
      });
      break;
    }
    case "ping": {
      emit(projectId, { type: "pong" });
      break;
    }
  }
}
