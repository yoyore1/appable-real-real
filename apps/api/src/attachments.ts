import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ChatAttachment } from "@appable/shared";
import { getDb } from "@appable/db";
import { requireAuth } from "./auth.js";
import { env } from "./env.js";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function uploadsRoot(): string {
  return path.resolve(env.chatUploadsDir);
}

function projectDir(projectId: string): string {
  return path.join(uploadsRoot(), projectId);
}

function attachmentPath(projectId: string, attachmentId: string, ext: string): string {
  return path.join(projectDir(projectId), `${attachmentId}${ext}`);
}

function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".bin";
  }
}

export function attachmentPublicUrl(
  projectId: string,
  attachmentId: string,
  host = `127.0.0.1:${env.apiPort}`,
  proto = "http",
): string {
  return `${proto}://${host}/projects/${projectId}/attachments/${attachmentId}`;
}

export async function readAttachmentBytes(
  projectId: string,
  attachmentId: string,
): Promise<{ mime: string; data: Buffer } | null> {
  const dir = projectDir(projectId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const hit = entries.find((f) => f.startsWith(`${attachmentId}.`));
  if (!hit) return null;
  const full = path.join(dir, hit);
  const data = await fs.readFile(full);
  const ext = path.extname(hit).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "application/octet-stream";
  return { mime, data };
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post<{
    Params: { id: string };
    Body: { name?: string; mime?: string; data?: string };
  }>("/projects/:id/attachments", async (req, reply) => {
    const db = getDb();
    const project = await db.project.findUnique({ where: { id: req.params.id } });
    if (!project || project.userId !== req.user.userId) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const mime = (req.body?.mime ?? "").trim().toLowerCase();
    const name = (req.body?.name ?? "image").trim() || "image";
    const dataB64 = req.body?.data ?? "";

    if (!mime.startsWith("image/")) {
      return reply.code(400).send({ error: "Only photos are supported — no videos." });
    }
    if (!ALLOWED_MIME.has(mime)) {
      return reply.code(400).send({ error: "Use a JPG, PNG, WebP, or GIF photo." });
    }
    if (!dataB64) {
      return reply.code(400).send({ error: "Missing image data" });
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(dataB64, "base64");
    } catch {
      return reply.code(400).send({ error: "Invalid image data" });
    }
    if (bytes.length === 0 || bytes.length > MAX_BYTES) {
      return reply.code(400).send({ error: "Image must be under 5 MB." });
    }

    const id = randomUUID();
    const ext = extForMime(mime);
    const dir = projectDir(project.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(attachmentPath(project.id, id, ext), bytes);

    const host = req.headers.host ?? `127.0.0.1:${env.apiPort}`;
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
    const attachment: ChatAttachment = {
      id,
      name,
      mime,
      url: attachmentPublicUrl(project.id, id, host, proto),
    };
    return attachment;
  });

  app.get<{ Params: { id: string; attachmentId: string } }>(
    "/projects/:id/attachments/:attachmentId",
    async (req, reply) => {
      const db = getDb();
      const project = await db.project.findUnique({ where: { id: req.params.id } });
      if (!project || project.userId !== req.user.userId) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const file = await readAttachmentBytes(project.id, req.params.attachmentId);
      if (!file) return reply.code(404).send({ error: "Attachment not found" });
      return reply.type(file.mime).send(file.data);
    },
  );
}
