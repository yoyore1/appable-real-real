import type { FastifyInstance } from "fastify";
import { getDb } from "@appable/db";
import { requireAuth } from "./auth.js";
import { ensureRunning, resolveLivePreview, stopProject, undoLastChange } from "./orchestrator.js";
import { cancelBuild, isBuilding, reconcileStaleBuildingStatus } from "./agent/loop.js";
import { ensureProjectSpec } from "./interview.js";

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post<{ Body: { name?: string } }>("/projects", async (req) => {
    const db = getDb();
    const project = await db.project.create({
      data: {
        name: req.body?.name?.trim() || "Untitled app",
        userId: req.user.userId,
        status: "new",
      },
    });
    return project;
  });

  app.get("/projects", async (req) => {
    const db = getDb();
    return db.project.findMany({
      where: { userId: req.user.userId },
      orderBy: { updatedAt: "desc" },
      include: { specs: { orderBy: { version: "desc" }, take: 1 } },
    });
  });

  app.get<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
    const db = getDb();
    const project = await db.project.findUnique({
      where: { id: req.params.id },
      include: {
        specs: { orderBy: { version: "desc" }, take: 1 },
        checkpoints: { orderBy: { createdAt: "desc" }, take: 20 },
      },
    });
    if (!project || project.userId !== req.user.userId) {
      return reply.code(404).send({ error: "Project not found" });
    }
    await reconcileStaleBuildingStatus(project.id);
    const fresh =
      project.status === "building"
        ? await db.project.findUnique({
            where: { id: req.params.id },
            include: {
              specs: { orderBy: { version: "desc" }, take: 1 },
              checkpoints: { orderBy: { createdAt: "desc" }, take: 20 },
            },
          })
        : project;
    const preview = await resolveLivePreview(fresh ?? project);
    return { ...(fresh ?? project), preview };
  });

  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>(
    "/projects/:id/messages",
    async (req, reply) => {
      const db = getDb();
      const project = await db.project.findUnique({ where: { id: req.params.id } });
      if (!project || project.userId !== req.user.userId) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const kind = req.query.kind ?? "interview";
      const conversation = await db.conversation.findUnique({
        where: { projectId_kind: { projectId: project.id, kind } },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
      return conversation?.messages ?? [];
    },
  );

  /**
   * Dev-mode payment: marks the $1 build fee as paid.
   * TODO: replace with a Stripe Checkout session + webhook when keys exist.
   */
  app.post<{ Params: { id: string } }>("/projects/:id/undo", async (req, reply) => {
    const db = getDb();
    const project = await db.project.findUnique({ where: { id: req.params.id } });
    if (!project || project.userId !== req.user.userId) {
      return reply.code(404).send({ error: "Project not found" });
    }
    if (isBuilding(project.id)) {
      return reply.code(409).send({ error: "Wait until the current change finishes" });
    }
    cancelBuild(project.id);
    const ok = await undoLastChange(project.id);
    if (!ok) {
      return reply.code(400).send({ error: "Nothing to undo yet" });
    }
    const count = await db.checkpoint.count({ where: { projectId: project.id } });
    return { ok: true, canUndo: count >= 2 };
  });

  /** Create the app plan from the interview if it is still missing. */
  app.post<{ Params: { id: string } }>("/projects/:id/spec/ensure", async (req, reply) => {
    const db = getDb();
    const project = await db.project.findUnique({ where: { id: req.params.id } });
    if (!project || project.userId !== req.user.userId) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const ready = await ensureProjectSpec(project.id);
    const updated = await db.project.findUnique({
      where: { id: project.id },
      include: { specs: { orderBy: { version: "desc" }, take: 1 } },
    });
    return { ready, spec: updated?.specs[0]?.data ?? null };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/pay", async (req, reply) => {
    const db = getDb();
    const project = await db.project.findUnique({ where: { id: req.params.id } });
    if (!project || project.userId !== req.user.userId) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const updated = await db.project.update({
      where: { id: project.id },
      data: { paidAt: project.paidAt ?? new Date() },
    });
    return { ok: true, paidAt: updated.paidAt };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/start", async (req, reply) => {
    const db = getDb();
    const project = await db.project.findUnique({ where: { id: req.params.id } });
    if (!project || project.userId !== req.user.userId) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const preview = await ensureRunning(project.id);
    return { preview };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/stop", async (req, reply) => {
    const db = getDb();
    const project = await db.project.findUnique({ where: { id: req.params.id } });
    if (!project || project.userId !== req.user.userId) {
      return reply.code(404).send({ error: "Project not found" });
    }
    await stopProject(project.id);
    return { ok: true };
  });

  /** Build-event log for the analyzer harness. Returns the last 1000 events. */
  app.get<{ Params: { id: string } }>("/projects/:id/build-log", async (req, reply) => {
    const db = getDb();
    const project = await db.project.findUnique({ where: { id: req.params.id } });
    if (!project || project.userId !== req.user.userId) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const events = await db.buildEvent.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: "asc" },
      take: 1000,
    });
    return { events };
  });
}
