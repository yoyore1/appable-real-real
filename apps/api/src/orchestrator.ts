import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { Redis } from "ioredis";
import { getDb } from "@appable/db";
import { env } from "./env.js";
import { scheduleBrainstormSnapshotRefresh } from "./brainstormSnapshot.js";
import { emit } from "./events.js";
import {
  APP_LAYOUT_PATH,
  BRIDGE_FILENAME,
  isBridgeBundleError,
  loadBridgeSource,
  normalizeAppLayout,
  normalizeIndexTs,
} from "./platformGlue.js";
import {
  generateStackLayoutContent,
  generateTabsLayoutContent,
  listTabsScreenNames,
  migrateRogueTabRoutes,
  normalizeRootLayoutForStack,
  STACK_LAYOUT_PATH,
  TABS_LAYOUT_PATH,
} from "./routerGlue.js";

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

/** True when Metro responds on the host-mapped port. */
export async function isMetroLive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function markProjectSleeping(projectId: string): Promise<void> {
  const db = getDb();
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.status === "sleeping") return;
  if (project.metroPort) await releasePort(project.metroPort, projectId);
  await redis.del(routeKey(projectId));
  await db.project.update({ where: { id: projectId }, data: { status: "sleeping" } });
  emit(projectId, { type: "preview.status", status: "stopped" });
  emit(projectId, { type: "project.status", status: "sleeping" });
}

/**
 * Preview URLs only when the container is up AND Metro is responding.
 * Syncs DB to "sleeping" when the workspace died (idle timeout, crash).
 */
export async function resolveLivePreview(project: {
  id: string;
  status: string;
  metroPort: number | null;
}): Promise<PreviewInfo | null> {
  if (!project.metroPort) return null;

  const container = await findContainer(project.id);
  if (!container) {
    if (project.status === "running") await markProjectSleeping(project.id);
    return null;
  }

  const inspect = await container.inspect();
  if (!inspect.State.Running) {
    if (project.status === "running") await markProjectSleeping(project.id);
    return null;
  }

  if (!(await isMetroLive(project.metroPort))) return null;

  return previewUrls(project.metroPort);
}

async function getContainerNameForPort(port: number): Promise<string | null> {
  const list = await docker.listContainers({ all: true });
  for (const info of list) {
    for (const binding of info.Ports ?? []) {
      if (binding.PublicPort === port) {
        const name = info.Names.find((n) => n.startsWith("/appable-proj-"));
        return name ? name.slice(1) : info.Names[0]?.slice(1) ?? null;
      }
    }
  }
  return null;
}

/** True when nothing else (or only this project's container) holds the port. */
async function isHostPortAvailable(port: number, projectId: string): Promise<boolean> {
  const owner = await getContainerNameForPort(port);
  if (!owner) return true;
  return owner === containerName(projectId);
}

async function allocatePort(projectId: string): Promise<number> {
  const db = getDb();
  const project = await db.project.findUnique({ where: { id: projectId } });

  const tryClaim = async (port: number): Promise<boolean> => {
    if (!(await isHostPortAvailable(port, projectId))) return false;
    const claimed = await redis.set(portKey(port), projectId, "EX", 60 * 60 * 24, "NX");
    if (claimed === "OK") return true;
    return (await redis.get(portKey(port))) === projectId;
  };

  if (project?.metroPort && (await tryClaim(project.metroPort))) {
    return project.metroPort;
  }

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (port === project?.metroPort) continue;
    if (await tryClaim(port)) return port;
  }
  throw new Error("No free preview ports available");
}

async function releasePort(port: number, projectId?: string): Promise<void> {
  if (projectId) {
    const owner = await redis.get(portKey(port));
    if (owner && owner !== projectId) return;
  }
  await redis.del(portKey(port));
}

function isPortBindError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /port is already allocated|address already in use|bind for/i.test(msg);
}

async function removeProjectContainer(projectId: string): Promise<void> {
  const container = await findContainer(projectId);
  if (!container) return;
  await container.remove({ force: true }).catch(() => {});
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

    // Container was created but never started (e.g. port bind failed) — discard it.
    if (inspect.State.Status === "created" && !inspect.State.Running) {
      console.warn(`[orchestrator] removing failed container for ${projectId}`);
      await container.remove({ force: true }).catch(() => {});
      if (project.metroPort) await releasePort(project.metroPort, projectId);
      container = null;
    } else {
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
        if (project.metroPort) await releasePort(project.metroPort, projectId);
        container = null;
      } else if (inspect.State.Running && project.metroPort) {
        await touch(projectId);
        await repairPlatformGlue(projectId);
        const urls = previewUrls(project.metroPort);
        if (await isMetroLive(project.metroPort)) {
          emit(projectId, { type: "preview.status", status: "ready", ...urlsToEvent(urls) });
        }
        return urls;
      } else if (!inspect.State.Running) {
        // Reuse the existing container (volume + port config preserved).
        emit(projectId, { type: "preview.status", status: "starting" });
        try {
          await container.start();
        } catch (err) {
          if (!isPortBindError(err)) throw err;
          console.warn(`[orchestrator] port bind failed restarting ${projectId}; recreating`);
          await container.remove({ force: true }).catch(() => {});
          if (project.metroPort) await releasePort(project.metroPort, projectId);
          container = null;
        }
        if (container) {
          const port = project.metroPort ?? (await allocatePort(projectId));
          await redis.set(routeKey(projectId), String(port));
          await repairPlatformGlue(projectId);
          await waitForMetro(projectId, port);
          await db.project.update({
            where: { id: projectId },
            data: {
              status: project.status === "building" ? "building" : "running",
              lastActiveAt: new Date(),
              metroPort: port,
              webPort: port,
            },
          });
          const urls = previewUrls(port);
          emit(projectId, { type: "preview.status", status: "ready", ...urlsToEvent(urls) });
          return urls;
        }
      }
    }
  }

  emit(projectId, { type: "preview.status", status: "starting" });

  const maxAttempts = 8;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = await allocatePort(projectId);
    try {
      await docker.createVolume({ Name: volumeName(projectId) }).catch(() => {
        /* already exists */
      });

      await removeProjectContainer(projectId);

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
      await repairPlatformGlue(projectId);
      await waitForMetro(projectId, port);

      const db2 = getDb();
      await db2.project.update({
        where: { id: projectId },
        data: {
          status: project.status === "building" ? "building" : "running",
          containerId: container.id,
          metroPort: port,
          webPort: port,
          lastActiveAt: new Date(),
        },
      });

      const urls = previewUrls(port);
      emit(projectId, { type: "preview.status", status: "ready", ...urlsToEvent(urls) });
      return urls;
    } catch (err) {
      lastErr = err;
      await releasePort(port, projectId);
      await removeProjectContainer(projectId);
      if (!isPortBindError(err) || attempt === maxAttempts - 1) {
        emit(projectId, { type: "preview.status", status: "error" });
        throw err;
      }
      console.warn(
        `[orchestrator] port ${port} unavailable for ${projectId}, retrying (${attempt + 1}/${maxAttempts})`,
      );
    }
  }

  emit(projectId, { type: "preview.status", status: "error" });
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function urlsToEvent(urls: PreviewInfo): { webUrl: string; expUrl: string } {
  return { webUrl: urls.webUrl, expUrl: urls.expUrl };
}

/** Tap-to-edit bridge + template files live in infra/expo-template/template-files. */
const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../infra/expo-template/template-files",
);

const PLATFORM_TEMPLATE_FILES = [
  BRIDGE_FILENAME,
  APP_LAYOUT_PATH,
  "src/lib/tapEdit.tsx",
  "src/components/EditableText.tsx",
  "src/components/EditableIcon.tsx",
  "src/components/EditableBackground.tsx",
  "src/components/index.ts",
];

/** Restore platform-owned glue: bridge file, entry layouts, editable components, remove agent metro configs. */
export async function repairPlatformGlue(projectId: string): Promise<void> {
  try {
    for (const rel of PLATFORM_TEMPLATE_FILES) {
      const source = fs.readFileSync(path.join(TEMPLATE_DIR, rel), "utf8");
      const existing = await readProjectFile(projectId, rel).catch(() => null);
      if (existing !== source) {
        await writeProjectFile(projectId, rel, source);
        console.log(`[platform] synced ${rel} for ${projectId}`);
      }
    }

    const entry = await readProjectFile(projectId, "index.ts").catch(() => null);
    if (entry !== null) {
      const normalized = normalizeIndexTs(entry);
      if (normalized !== entry) {
        await writeProjectFile(projectId, "index.ts", normalized);
      }
    }

    for (const cfg of ["metro.config.js", "metro.config.ts", "metro.config.mjs", "metro.config.cjs"]) {
      const has = await readProjectFile(projectId, cfg).catch(() => null);
      if (has !== null) {
        await deleteProjectFile(projectId, cfg);
        console.log(`[platform] removed agent-created ${cfg} for ${projectId}`);
      }
    }

    await repairV2Router(projectId);

    const touchTargets = [BRIDGE_FILENAME, "index.ts", APP_LAYOUT_PATH].filter(Boolean);
    await execInProject(projectId, ["touch", ...touchTargets]).catch(() => {});
  } catch (err) {
    console.warn(`[platform] repairPlatformGlue failed for ${projectId}:`, err);
  }
}

/** Repair v2 Expo Router: stack group, tab layout, migrate rogue tab routes. */
async function repairV2Router(projectId: string): Promise<void> {
  try {
    const hasRouter = await readProjectFile(projectId, APP_LAYOUT_PATH).catch(() => null);
    if (hasRouter === null) return;

    await writeProjectFile(projectId, STACK_LAYOUT_PATH, generateStackLayoutContent());

    const moved = await migrateRogueTabRoutes(projectId, {
      listProjectFiles,
      readProjectFile,
      writeProjectFile,
      deleteProjectFile,
    });
    if (moved.length > 0) {
      console.log(`[router] migrated ${moved.length} route(s) to (stack) for ${projectId}`);
    }

    const remaining = await listTabsScreenNames(projectId, listProjectFiles);
    const hidden = remaining.filter((n) => n !== "index" && n !== "settings");
    const tabsLayout = generateTabsLayoutContent(hidden);
    const existingTabs = await readProjectFile(projectId, TABS_LAYOUT_PATH).catch(() => "");
    if (existingTabs !== tabsLayout) {
      await writeProjectFile(projectId, TABS_LAYOUT_PATH, tabsLayout);
    }

    const rootLayout = normalizeRootLayoutForStack(hasRouter);
    if (rootLayout !== hasRouter) {
      await writeProjectFile(projectId, APP_LAYOUT_PATH, rootLayout);
    }
  } catch (err) {
    console.warn(`[router] repairV2Router failed for ${projectId}:`, err);
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
  if (project?.metroPort) await releasePort(project.metroPort, projectId);
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
  const cleaned = p.replace(/\\/g, "/").replace(/^\/+/, "");
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
 * Metro bundle entry paths — v1 uses index.ts; v2 Expo Router uses expo-router/entry.
 */
async function bundleCheckPaths(projectId: string): Promise<string[]> {
  const hasRouterLayout = await readProjectFile(projectId, "app/_layout.tsx").catch(() => null);
  if (hasRouterLayout) {
    return [
      "node_modules/expo-router/entry.bundle?platform=web&dev=true",
      "index.bundle?platform=web&dev=true",
    ];
  }
  return ["index.ts.bundle?platform=web&dev=true"];
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

  let lastError: string | null = null;
  for (const path of await bundleCheckPaths(projectId)) {
    try {
      const res = await fetch(`http://127.0.0.1:${project.metroPort}/${path}`, {
        signal: AbortSignal.timeout(180_000),
      });
      const body = await res.text();
      if (!res.ok) {
        lastError = parseBundleErrorBody(body, res.status);
        continue;
      }
      const inspected = inspectBundleBody(body);
      if (inspected) {
        lastError = inspected;
        continue;
      }
      return null;
    } catch (err) {
      lastError = `Bundle check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return lastError;
}

const MIN_BUNDLE_BYTES = 8_000;

function parseBundleErrorBody(body: string, status?: number): string {
  try {
    const parsed = JSON.parse(body) as { type?: string; message?: string };
    return `${parsed.type ?? "BundleError"}: ${parsed.message ?? body.slice(0, 2000)}`;
  } catch {
    return status ? `HTTP ${status}: ${body.slice(0, 2000)}` : body.slice(0, 2000);
  }
}

/** Deeper checks on a bundle that returned HTTP 200. */
function inspectBundleBody(body: string): string | null {
  if (body.length < MIN_BUNDLE_BYTES) {
    return `Bundle too small (${body.length} bytes) — the app may not have built correctly.`;
  }
  // Metro error responses are JSON blobs, not JS bundles.
  if (body.trimStart().startsWith("{")) {
    return parseBundleErrorBody(body);
  }
  // Valid bundles are large JS with Metro's module registry. Do not scan
  // for error class names — RN's own error-overlay code contains strings
  // like "SyntaxError" and "TransformError" even when the app is healthy.
  if (!/__d\(|registerComponent|AppRegistry/.test(body)) {
    return "Bundle is missing app entry code — the app may not mount in the preview.";
  }
  return null;
}

async function checkPreviewShell(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(30_000),
    });
    const html = await res.text();
    if (!res.ok) return `Preview page returned HTTP ${res.status}`;
    if (html.length < 100) return "Preview page is empty";
    if (/error-overlay|Failed to compile|RedBox/i.test(html)) {
      return "Preview page is showing an error screen";
    }
    return null;
  } catch (err) {
    return `Preview page unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Full build/edit gate: bundle compiles AND the preview shell loads.
 * Returns null when the app is healthy enough to show the customer.
 */
export async function verifyApp(projectId: string): Promise<string | null> {
  const db = getDb();
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project?.metroPort) return null;

  await repairPlatformGlue(projectId);

  let bundleError = await checkBundle(projectId);
  if (bundleError && isBridgeBundleError(bundleError)) {
    await repairPlatformGlue(projectId);
    bundleError = await checkBundle(projectId);
  }
  if (bundleError) return bundleError;

  return checkPreviewShell(project.metroPort);
}

// ---------------------------------------------------------------------------
// Checkpoints (git inside the project volume)
// ---------------------------------------------------------------------------

/** Golden template init can leave a repo with no commits — edits need HEAD for rollback. */
export async function ensureGitReady(projectId: string): Promise<void> {
  const rev = await execInProject(projectId, ["git", "rev-parse", "HEAD"]);
  if (rev.exitCode === 0 && rev.stdout.trim()) return;

  await execInProject(projectId, ["git", "add", "-A"]);
  const commit = await execInProject(projectId, [
    "git",
    "commit",
    "-m",
    "checkpoint: initial",
    "--allow-empty",
  ]);
  if (commit.exitCode !== 0) {
    const retry = await execInProject(projectId, ["git", "rev-parse", "HEAD"]);
    if (retry.exitCode !== 0) {
      throw new Error(`git init commit failed: ${commit.stderr || commit.stdout}`);
    }
  }
}

export async function createCheckpoint(projectId: string, label: string): Promise<string | null> {
  await ensureGitReady(projectId);
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
  await ensureGitReady(projectId);
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
  await resetToGitRef(projectId, checkpoint.gitRef);
}

/** Nudge Metro to rebundle after git reset (watchers often miss `git reset`). */
export async function invalidateMetroBundle(projectId: string): Promise<void> {
  await execInProject(projectId, ["touch", "index.ts", "app/_layout.tsx", "appable-bridge.js"]).catch(
    () => {},
  );
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

  // Drop uncommitted tap-to-edit writes (preview DOM can change before git commits).
  await execInProject(projectId, ["git", "reset", "--hard"]);
  await execInProject(projectId, ["git", "clean", "-fd"]);

  await resetToGitRef(projectId, previous.gitRef);
  await invalidateMetroBundle(projectId);
  await db.checkpoint.delete({ where: { id: latest.id } });
  await touch(projectId);
  emit(projectId, { type: "checkpoint.created", checkpointId: previous.id, label: "undo" });
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
  scheduleBrainstormSnapshotRefresh(projectId);
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
