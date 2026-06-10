import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { Redis } from "ioredis";
import { getDb } from "@appable/db";
import { env } from "./env.js";
import { emit } from "./events.js";

/**
 * Container lifecycle for project workspaces.
 *
 * Each project gets:
 *   - a named docker volume (its filesystem, survives container restarts)
 *   - a container from the golden Expo image
 *   - one host port P mapped to the same port P inside the container, so
 *     Metro-generated URLs (manifest, bundles) are consistent inside and out
 *
 * Files are written via `docker exec` (not bind mounts) so Metro's file
 * watcher reliably sees changes regardless of host OS.
 */

const docker = new Docker(
  process.platform === "win32"
    ? { socketPath: "//./pipe/docker_engine" }
    : undefined,
);

const redis = new Redis(env.redisUrl);

const PORT_RANGE_START = 20100;
const PORT_RANGE_END = 20400;
const READY_TIMEOUT_MS = 180_000;

const containerName = (projectId: string) => `appable-proj-${projectId}`;
const volumeName = (projectId: string) => `appable-proj-${projectId}`;
const routeKey = (projectId: string) => `appable:route:${projectId}`;
const portKey = (port: number) => `appable:port:${port}`;

export interface PreviewInfo {
  port: number;
  webUrl: string;
  expUrl: string;
}

export function previewUrls(port: number): PreviewInfo {
  return {
    port,
    webUrl: `http://${env.publicHost}:${port}`,
    expUrl: `exp://${env.publicHost}:${port}`,
  };
}

async function allocatePort(projectId: string): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    const claimed = await redis.set(portKey(port), projectId, "EX", 60 * 60 * 24, "NX");
    if (claimed === "OK") return port;
  }
  throw new Error("No free preview ports available");
}

async function releasePort(port: number): Promise<void> {
  await redis.del(portKey(port));
}

async function findContainer(projectId: string): Promise<Docker.Container | null> {
  const list = await docker.listContainers({
    all: true,
    filters: { name: [containerName(projectId)] },
  });
  const info = list.find((c) => c.Names.some((n) => n === `/${containerName(projectId)}`));
  return info ? docker.getContainer(info.Id) : null;
}

/** Ensure the project's container exists and is running. Returns preview info. */
export async function ensureRunning(projectId: string): Promise<PreviewInfo> {
  const db = getDb();
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });

  let container = await findContainer(projectId);

  if (container) {
    const inspect = await container.inspect();

    // If the public host changed since the container was created (e.g. LAN
    // IP auto-detection), Metro advertises the wrong hostname to Expo Go.
    // Recreate the container - the volume keeps all project files.
    const envHostname = inspect.Config.Env?.find((e) =>
      e.startsWith("REACT_NATIVE_PACKAGER_HOSTNAME="),
    )?.split("=")[1];
    if (envHostname && envHostname !== env.publicHost) {
      console.log(
        `[orchestrator] host changed (${envHostname} -> ${env.publicHost}); recreating container for ${projectId}`,
      );
      if (inspect.State.Running) await container.stop({ t: 5 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
      container = null;
    } else if (inspect.State.Running && project.metroPort) {
      await touch(projectId);
      await ensureEditBridge(projectId);
      return previewUrls(project.metroPort);
    } else if (!inspect.State.Running) {
      // Reuse the existing container (volume + port config preserved).
      emit(projectId, { type: "preview.status", status: "starting" });
      await container.start();
      const port = project.metroPort ?? (await allocatePort(projectId));
      await redis.set(routeKey(projectId), String(port));
      await waitForMetro(projectId, port);
      await ensureEditBridge(projectId);
      await db.project.update({
        where: { id: projectId },
        data: { status: "running", lastActiveAt: new Date(), metroPort: port, webPort: port },
      });
      const urls = previewUrls(port);
      emit(projectId, { type: "preview.status", status: "ready", ...urlsToEvent(urls) });
      return urls;
    }
  }

  emit(projectId, { type: "preview.status", status: "starting" });
  const port = await allocatePort(projectId);

  try {
    await docker.createVolume({ Name: volumeName(projectId) }).catch(() => {
      /* already exists */
    });

    container = await docker.createContainer({
      name: containerName(projectId),
      Image: env.goldenImage,
      Env: [
        `EXPO_PORT=${port}`,
        `REACT_NATIVE_PACKAGER_HOSTNAME=${env.publicHost}`,
      ],
      ExposedPorts: { [`${port}/tcp`]: {} },
      HostConfig: {
        Binds: [`${volumeName(projectId)}:/app`],
        PortBindings: { [`${port}/tcp`]: [{ HostPort: String(port) }] },
        Memory: 2 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        RestartPolicy: { Name: "no" },
      },
    });
    await container.start();
    await redis.set(routeKey(projectId), String(port));
    await waitForMetro(projectId, port);
    await ensureEditBridge(projectId);
  } catch (err) {
    await releasePort(port);
    emit(projectId, { type: "preview.status", status: "error" });
    throw err;
  }

  const db2 = getDb();
  await db2.project.update({
    where: { id: projectId },
    data: {
      status: "running",
      containerId: container.id,
      metroPort: port,
      webPort: port,
      lastActiveAt: new Date(),
    },
  });

  const urls = previewUrls(port);
  emit(projectId, { type: "preview.status", status: "ready", ...urlsToEvent(urls) });
  return urls;
}

function urlsToEvent(urls: PreviewInfo): { webUrl: string; expUrl: string } {
  return { webUrl: urls.webUrl, expUrl: urls.expUrl };
}

/**
 * Tap-to-edit bridge: a small script that ships inside every app. On web
 * (the phone preview iframe) it lets the parent page toggle an "edit mode",
 * reports which element the user tapped, and applies instant text/color
 * changes while the real edit runs in the background. Inert on native.
 */
const EDIT_BRIDGE_SOURCE = `/* Appable edit bridge - auto-generated, do not edit. v1 */
/* eslint-disable */
if (
  typeof document !== "undefined" &&
  typeof window !== "undefined" &&
  window.parent !== window
) {
  var editMode = false;
  var lastEl = null;
  var lastOutline = "";

  function describe(el) {
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    return {
      testId: (el.getAttribute && el.getAttribute("data-testid")) || null,
      text: (el.innerText || "").slice(0, 160),
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  }

  function pickTarget(el) {
    var cur = el;
    while (cur && cur !== document.body) {
      if (cur.getAttribute && cur.getAttribute("data-testid")) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  function clearHighlight() {
    if (lastEl) {
      lastEl.style.outline = lastOutline;
      lastEl = null;
    }
  }

  window.addEventListener("message", function (e) {
    var msg = e.data || {};
    if (msg.type === "appable:edit-mode") {
      editMode = Boolean(msg.on);
      if (!editMode) clearHighlight();
      document.body.style.cursor = editMode ? "crosshair" : "";
    } else if (msg.type === "appable:apply" && lastEl) {
      if (msg.prop === "text") lastEl.innerText = msg.value;
      else if (msg.prop === "color") lastEl.style.color = msg.value;
      else if (msg.prop === "background") lastEl.style.backgroundColor = msg.value;
    } else if (msg.type === "appable:clear") {
      clearHighlight();
    }
  });

  document.addEventListener(
    "click",
    function (e) {
      if (!editMode) return;
      e.preventDefault();
      e.stopPropagation();
      var t = pickTarget(e.target);
      if (!t || t === document.body) return;
      clearHighlight();
      lastEl = t;
      lastOutline = t.style.outline;
      t.style.outline = "2px solid #c8431d";
      t.style.outlineOffset = "1px";
      window.parent.postMessage({ type: "appable:tapped", el: describe(t) }, "*");
    },
    true
  );
}
`;

/** Write the edit bridge into the project and import it from the entry file. */
async function ensureEditBridge(projectId: string): Promise<void> {
  try {
    const existing = await readProjectFile(projectId, "appable-bridge.js").catch(() => "");
    if (existing !== EDIT_BRIDGE_SOURCE) {
      await writeProjectFile(projectId, "appable-bridge.js", EDIT_BRIDGE_SOURCE);
    }

    const entry = await readProjectFile(projectId, "index.ts").catch(() => null);
    if (entry !== null && !entry.includes("appable-bridge")) {
      await writeProjectFile(projectId, "index.ts", `import "./appable-bridge";\n${entry}`);
    }
  } catch (err) {
    // The bridge is an enhancement - never block app startup on it.
    console.warn(`[orchestrator] ensureEditBridge failed for ${projectId}:`, err);
  }
}

async function waitForMetro(projectId: string, port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Metro did not become ready on port ${port} within timeout`);
}

export async function stopProject(projectId: string): Promise<void> {
  const container = await findContainer(projectId);
  if (container) {
    const inspect = await container.inspect();
    if (inspect.State.Running) {
      await container.stop({ t: 5 }).catch(() => {});
    }
  }
  const db = getDb();
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (project?.metroPort) await releasePort(project.metroPort);
  await redis.del(routeKey(projectId));
  await db.project.update({ where: { id: projectId }, data: { status: "sleeping" } });
  emit(projectId, { type: "preview.status", status: "stopped" });
  emit(projectId, { type: "project.status", status: "sleeping" });
}

export async function touch(projectId: string): Promise<void> {
  const db = getDb();
  await db.project.update({
    where: { id: projectId },
    data: { lastActiveAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Exec helpers (the agent's hands)
// ---------------------------------------------------------------------------

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function execInProject(
  projectId: string,
  cmd: string[],
  opts: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  const container = await findContainer(projectId);
  if (!container) throw new Error(`No container for project ${projectId}`);

  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: "/app",
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stream.destroy();
      reject(new Error(`exec timed out: ${cmd.join(" ")}`));
    }, opts.timeoutMs ?? 120_000);

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on("end", () => {
      clearTimeout(timeout);
      resolve();
    });
    stream.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const inspect = await exec.inspect();
  return {
    exitCode: inspect.ExitCode ?? -1,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

/** Write a file inside the project container (base64 round-trip keeps content safe). */
export async function writeProjectFile(
  projectId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const safePath = normalizeProjectPath(filePath);
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const dir = safePath.includes("/") ? safePath.slice(0, safePath.lastIndexOf("/")) : "";
  const mkdir = dir ? `mkdir -p '/app/${dir}' && ` : "";
  const result = await execInProject(projectId, [
    "sh",
    "-c",
    `${mkdir}echo '${b64}' | base64 -d > '/app/${safePath}'`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`write_file failed: ${result.stderr || result.stdout}`);
  }
}

export async function readProjectFile(projectId: string, filePath: string): Promise<string> {
  const safePath = normalizeProjectPath(filePath);
  const result = await execInProject(projectId, ["cat", `/app/${safePath}`]);
  if (result.exitCode !== 0) {
    throw new Error(`read_file failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function deleteProjectFile(projectId: string, filePath: string): Promise<void> {
  const safePath = normalizeProjectPath(filePath);
  await execInProject(projectId, ["rm", "-f", `/app/${safePath}`]);
}

export async function listProjectFiles(projectId: string): Promise<string[]> {
  const result = await execInProject(projectId, [
    "sh",
    "-c",
    "cd /app && find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './.expo/*' | sed 's|^\\./||' | sort",
  ]);
  return result.stdout.split("\n").filter(Boolean);
}

function normalizeProjectPath(p: string): string {
  const cleaned = p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^app\//, "");
  if (cleaned.includes("..") || cleaned.includes("'")) {
    throw new Error(`Unsafe path: ${p}`);
  }
  return cleaned;
}

/** Tail of the container logs (Metro output) for the agent's eyes. */
export async function getProjectLogs(projectId: string, tailLines = 120): Promise<string> {
  const container = await findContainer(projectId);
  if (!container) return "";
  const buf = (await container.logs({
    stdout: true,
    stderr: true,
    tail: tailLines,
  })) as unknown as Buffer;
  // Strip the 8-byte docker stream-multiplexing headers.
  return demuxLogBuffer(buf);
}

function demuxLogBuffer(buf: Buffer): string {
  let out = "";
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    out += buf.subarray(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
  }
  if (offset < buf.length) out += buf.subarray(offset).toString("utf8");
  return out;
}

/**
 * Force Metro to actually compile the web bundle and report any error.
 * Without this, builds can look "clean" simply because nothing requested
 * a bundle yet. Returns null when the bundle compiles.
 */
export async function checkBundle(projectId: string): Promise<string | null> {
  const db = getDb();
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project?.metroPort) return null;
  try {
    const res = await fetch(
      `http://127.0.0.1:${project.metroPort}/index.ts.bundle?platform=web&dev=true`,
      { signal: AbortSignal.timeout(180_000) },
    );
    if (res.ok) return null;
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { type?: string; message?: string };
      return `${parsed.type ?? "BundleError"}: ${parsed.message ?? body.slice(0, 2000)}`;
    } catch {
      return body.slice(0, 2000);
    }
  } catch {
    // Metro unreachable or bundle took too long; log-based detection still applies.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Checkpoints (git inside the project volume)
// ---------------------------------------------------------------------------

export async function createCheckpoint(projectId: string, label: string): Promise<string | null> {
  const status = await execInProject(projectId, ["git", "status", "--porcelain"]);
  if (!status.stdout.trim()) return null; // nothing changed

  const add = await execInProject(projectId, ["git", "add", "-A"]);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);

  const commit = await execInProject(projectId, ["git", "commit", "-m", `checkpoint: ${label}`]);
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);

  const rev = await execInProject(projectId, ["git", "rev-parse", "HEAD"]);
  const gitRef = rev.stdout.trim();

  const db = getDb();
  const checkpoint = await db.checkpoint.create({
    data: { projectId, gitRef, label },
  });
  emit(projectId, { type: "checkpoint.created", checkpointId: checkpoint.id, label });
  return checkpoint.id;
}

/** Current HEAD commit of the project repo (for edit rollbacks). */
export async function getHeadRef(projectId: string): Promise<string> {
  const rev = await execInProject(projectId, ["git", "rev-parse", "HEAD"]);
  if (rev.exitCode !== 0) throw new Error(`git rev-parse failed: ${rev.stderr}`);
  return rev.stdout.trim();
}

/** Hard-reset the project repo to a specific commit (discards all changes). */
export async function resetToGitRef(projectId: string, gitRef: string): Promise<void> {
  await execInProject(projectId, ["git", "reset", "--hard", gitRef]);
  await execInProject(projectId, ["git", "clean", "-fd"]);
}

export async function restoreCheckpoint(projectId: string, checkpointId: string): Promise<void> {
  const db = getDb();
  const checkpoint = await db.checkpoint.findUniqueOrThrow({ where: { id: checkpointId } });
  if (checkpoint.projectId !== projectId) throw new Error("Checkpoint does not belong to project");
  const result = await execInProject(projectId, ["git", "reset", "--hard", checkpoint.gitRef]);
  if (result.exitCode !== 0) throw new Error(`git reset failed: ${result.stderr}`);
}

/**
 * Normie-facing undo: go back one saved version (before the last edit/build).
 * Returns false when there is nothing to undo.
 */
export async function undoLastChange(projectId: string): Promise<boolean> {
  const db = getDb();
  const checkpoints = await db.checkpoint.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  if (checkpoints.length < 2) return false;

  const [latest, previous] = checkpoints;
  await ensureRunning(projectId);
  await restoreCheckpoint(projectId, previous.id);
  await db.checkpoint.delete({ where: { id: latest.id } });
  await touch(projectId);
  emit(projectId, {
    type: "build.event",
    level: "info",
    source: "system",
    text: "Undid your last change.",
    timestamp: new Date().toISOString(),
  });
  emit(projectId, {
    type: "agent.status",
    status: "idle",
    message: "Undid your last change.",
  });
  return true;
}

// ---------------------------------------------------------------------------
// Idle sweeper
// ---------------------------------------------------------------------------

export function startIdleSweeper(): void {
  const intervalMs = 60_000;
  setInterval(async () => {
    try {
      const db = getDb();
      const cutoff = new Date(Date.now() - env.idleTimeoutMinutes * 60_000);
      const idle = await db.project.findMany({
        where: { status: "running", lastActiveAt: { lt: cutoff } },
      });
      for (const project of idle) {
        console.log(`[sweeper] putting idle project ${project.id} to sleep`);
        await stopProject(project.id).catch((err) =>
          console.error(`[sweeper] failed to stop ${project.id}:`, err),
        );
      }
    } catch (err) {
      console.error("[sweeper] error:", err);
    }
  }, intervalMs);
}
