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
        await ensureEditBridge(projectId);
        return previewUrls(project.metroPort);
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
      await waitForMetro(projectId, port);
      await ensureEditBridge(projectId);

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

/**
 * Tap-to-edit bridge: a small script that ships inside every app. On web
 * (the phone preview iframe) it lets the parent page toggle an "edit mode",
 * reports which element the user tapped, and applies instant text/color
 * changes while the real edit runs in the background. Inert on native.
 */
const EDIT_BRIDGE_SOURCE = `/* Appable edit bridge - auto-generated, do not edit. v10 */
/* eslint-disable */
if (
  typeof document !== "undefined" &&
  typeof window !== "undefined" &&
  window.parent !== window
) {
  (function hidePreviewScrollbars() {
    if (document.querySelector("[data-appable=hide-scrollbars]")) return;
    var style = document.createElement("style");
    style.setAttribute("data-appable", "hide-scrollbars");
    style.textContent =
      "html,body{scrollbar-width:none!important;-ms-overflow-style:none!important}" +
      "html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}" +
      "*{scrollbar-width:none!important;-ms-overflow-style:none!important}" +
      "*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}";
    (document.head || document.documentElement).appendChild(style);
  })();

  var editMode = false;
  var lastHighlight = null;
  var lastOutline = "";
  var lastPartEls = [];
  var lastPartIsIcon = [];
  var lastStyleEl = null;
  var lastBgEl = null;

  var BROAD_TEST_IDS = {
    screen: 1,
    scroll: 1,
    scrollview: 1,
    root: 1,
    layout: 1,
    wrapper: 1,
    container: 1,
    page: 1,
    app: 1,
    content: 1,
    section: 1,
    header: 1,
    "home-screen": 1,
    "home-scroll": 1,
    "home-root": 1,
    "home-layout": 1,
    "home-wrapper": 1,
    "home-container": 1,
    "home-page": 1,
    "home-content": 1,
    "home-section": 1,
    "home-header": 1,
  };

  function isBroadTestId(id) {
    if (!id) return true;
    var lower = String(id).toLowerCase();
    if (BROAD_TEST_IDS[lower]) return true;
    if (/^home-(screen|scroll|root|layout|wrapper|container|page|content|section|header)/.test(lower)) {
      return true;
    }
    if (/-(screen|scrollview|scroll-view|root|layout|wrapper|container|page)$/.test(lower)) {
      return true;
    }
    return false;
  }

  function testIdOn(el) {
    return el && el.getAttribute ? el.getAttribute("data-testid") : null;
  }

  /** Prefer the nearest specific testID, not a screen-level parent. */
  function findNearestTestId(el) {
    var cur = el;
    var broad = null;
    var steps = 0;
    while (cur && cur !== document.body && steps < 12) {
      var tid = testIdOn(cur);
      if (tid) {
        if (!isBroadTestId(tid)) return tid;
        if (!broad) broad = tid;
      }
      cur = cur.parentElement;
      steps++;
    }
    return broad;
  }

  function textChildAtPoint(parent, x, y) {
    if (!parent || !parent.children) return null;
    for (var i = parent.children.length - 1; i >= 0; i--) {
      var c = parent.children[i];
      var r = c.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return c;
      }
    }
    return null;
  }

  var MAX_TEXT_LABEL = 64;

  function shortLabel(text) {
    if (!text) return "";
    var line = String(text).replace(/[\\r\\n]+/g, " ").replace(/\\s+/g, " ").trim();
    return line.length > MAX_TEXT_LABEL ? line.slice(0, MAX_TEXT_LABEL) : line;
  }

  function leafTextLabel(el) {
    if (!el) return "";
    var kids = [];
    for (var i = 0; i < el.children.length; i++) {
      if ((el.children[i].innerText || "").trim()) kids.push(el.children[i]);
    }
    if (kids.length > 1) return "";
    if (kids.length === 1) {
      var nested = leafTextLabel(kids[0]);
      return nested || shortLabel(kids[0].innerText || kids[0].textContent || "");
    }
    return shortLabel(el.innerText || el.textContent || "");
  }

  function firstLabelIn(el) {
    if (!el) return "";
    var lbl = leafTextLabel(el);
    if (lbl) return lbl;
    if (!el.children) return "";
    for (var i = 0; i < el.children.length; i++) {
      lbl = firstLabelIn(el.children[i]);
      if (lbl) return lbl;
    }
    return "";
  }

  function iconDisplayText(el) {
    var t = shortLabel(el.innerText || el.textContent || "");
    return t || "icon";
  }

  function isIconLike(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "svg" || (el.querySelector && el.querySelector("svg"))) return true;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    if (r.width > 80 || r.height > 80) return false;
    try {
      var ff = (window.getComputedStyle(el).fontFamily || "").toLowerCase();
      if (/ionicons|material icons|materialicons|fontawesome|anticon|feather|expo|glyph|icon/.test(ff)) {
        return true;
      }
    } catch (_e) {}
    var text = (el.innerText || el.textContent || "").trim();
    if (!text) return r.width < 64 && r.height < 64;
    if (text.length <= 2 && /[\\p{Extended_Pictographic}\\p{So}]/u.test(text)) return true;
    if (text.length === 1 && !/[a-zA-Z0-9]/.test(text)) return true;
    return false;
  }

  function collectEditableParts(root) {
    var parts = [];
    var used = [];
    function add(el, text, isIcon) {
      if (!el || used.indexOf(el) >= 0) return;
      used.push(el);
      parts.push({ text: text, el: el, isIcon: isIcon });
    }
    function walk(el) {
      if (!el || !root.contains(el)) return;
      if (isIconLike(el)) {
        add(el, iconDisplayText(el), true);
        return;
      }
      var lbl = leafTextLabel(el);
      if (lbl) {
        var textKids = 0;
        for (var i = 0; i < el.children.length; i++) {
          if ((el.children[i].innerText || "").trim()) textKids++;
        }
        if (textKids === 0) {
          add(el, lbl, false);
          return;
        }
      }
      for (var j = 0; j < el.children.length; j++) walk(el.children[j]);
    }
    walk(root);
    return parts;
  }

  function resolveTextTarget(el, x, y) {
    if (!el || el === document.body || el === document.documentElement) return null;
    var child = textChildAtPoint(el, x, y);
    if (child && child !== el) {
      var deeper = resolveTextTarget(child, x, y);
      if (deeper) return deeper;
    }
    var label = leafTextLabel(el);
    if (!label || label.length > MAX_TEXT_LABEL) return null;
    return { el: el, text: label };
  }

  function boxLimits() {
    var vw = window.innerWidth || 400;
    var vh = window.innerHeight || 800;
    return {
      minW: 36,
      minH: 24,
      maxW: vw * 0.52,
      maxH: vh * 0.42,
    };
  }

  function qualifiesAsBox(el, x, y, lim) {
    if (!el || el === document.body || el === document.documentElement) return false;
    var r = el.getBoundingClientRect();
    if (r.width < lim.minW || r.height < lim.minH) return false;
    if (r.width > lim.maxW || r.height > lim.maxH) return false;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    return true;
  }

  /** Smallest card/box under the tap — uses the hit stack, not a huge parent. */
  function pickBoxAtPoint(stack, x, y) {
    var lim = boxLimits();
    var best = null;
    var bestArea = Infinity;
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (!qualifiesAsBox(el, x, y, lim)) continue;
      var r = el.getBoundingClientRect();
      var area = r.width * r.height;
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  /** Walk down into children at the tap when the parent row is too wide. */
  function drillBoxAtPoint(el, x, y, lim) {
    if (!el) return null;
    var child = textChildAtPoint(el, x, y);
    if (child && child !== el) {
      var deeper = drillBoxAtPoint(child, x, y, lim);
      if (deeper) return deeper;
    }
    if (qualifiesAsBox(el, x, y, lim)) return el;
    return null;
  }

  function pickCardContainer(seedEl, x, y) {
    var lim = boxLimits();
    var cur = seedEl;
    var best = null;
    var bestArea = Infinity;
    while (cur && cur !== document.body) {
      if (qualifiesAsBox(cur, x, y, lim)) {
        var r = cur.getBoundingClientRect();
        var area = r.width * r.height;
        if (area < bestArea) {
          best = cur;
          bestArea = area;
        }
      }
      cur = cur.parentElement;
    }
    return best || seedEl;
  }

  function pickTarget(clickEl, x, y) {
    var stack =
      typeof document.elementsFromPoint === "function"
        ? document.elementsFromPoint(x, y)
        : [clickEl];
    if (clickEl && clickEl.nodeType === 3) clickEl = clickEl.parentElement;
    if (clickEl && stack.indexOf(clickEl) === -1) stack.unshift(clickEl);

    var lim = boxLimits();
    var bgEl = pickBoxAtPoint(stack, x, y);
    if (!bgEl && clickEl) bgEl = drillBoxAtPoint(clickEl, x, y, lim);
    if (!bgEl && clickEl) bgEl = pickCardContainer(clickEl, x, y);

    var bestResolved = null;
    var bestArea = Infinity;
    var searchRoots = bgEl ? [bgEl] : [];
    for (var s = 0; s < stack.length; s++) {
      if (searchRoots.indexOf(stack[s]) === -1) searchRoots.push(stack[s]);
    }
    for (var j = 0; j < searchRoots.length; j++) {
      var resolved = resolveTextTarget(searchRoots[j], x, y);
      if (!resolved) continue;
      if (bgEl && !bgEl.contains(resolved.el)) continue;
      var rr = resolved.el.getBoundingClientRect();
      var a = rr.width * rr.height;
      if (a < bestArea) {
        bestArea = a;
        bestResolved = resolved;
      }
    }
    if (!bestResolved && bgEl) bestResolved = resolveTextTarget(bgEl, x, y);
    if (!bestResolved && clickEl) bestResolved = resolveTextTarget(clickEl, x, y);
    if (!bgEl && bestResolved) bgEl = pickCardContainer(bestResolved.el, x, y);
    if (!bgEl && clickEl) bgEl = pickCardContainer(clickEl, x, y);
    if (!bgEl) return null;

    var hitIcon = null;
    for (var hi = 0; hi < stack.length; hi++) {
      if (bgEl.contains(stack[hi]) && isIconLike(stack[hi])) {
        hitIcon = stack[hi];
        break;
      }
    }

    var parts = [];
    var boxLabel = firstLabelIn(bgEl);
    var styleEl = bestResolved ? bestResolved.el : bgEl;

    if (hitIcon) {
      styleEl = hitIcon;
      bestResolved = { el: hitIcon, text: iconDisplayText(hitIcon) };
      parts = [{ text: iconDisplayText(hitIcon), el: hitIcon, isIcon: true }];
    } else {
      var allParts = collectEditableParts(bgEl);
      if (allParts.length > 1) {
        parts = allParts;
        if (bestResolved) {
          var found = false;
          for (var pi = 0; pi < allParts.length; pi++) {
            if (allParts[pi].el === bestResolved.el) found = true;
          }
          if (!found) {
            parts = [
              {
                text: bestResolved.text,
                el: bestResolved.el,
                isIcon: isIconLike(bestResolved.el),
              },
            ];
          }
        }
      } else if (bestResolved) {
        parts = [
          {
            text: bestResolved.text,
            el: bestResolved.el,
            isIcon: isIconLike(bestResolved.el),
          },
        ];
      } else if (allParts.length === 1) {
        parts = allParts;
        styleEl = allParts[0].el;
        bestResolved = { el: allParts[0].el, text: allParts[0].text };
      } else if (boxLabel) {
        parts = [{ text: boxLabel, el: styleEl, isIcon: false }];
      } else {
        parts = [{ text: "", el: styleEl, isIcon: false }];
      }
    }

    var textTestId = findNearestTestId(styleEl);
    var boxTestId = findNearestTestId(bgEl);
    if (boxTestId && isBroadTestId(boxTestId)) boxTestId = null;
    var anchor = bestResolved ? bestResolved.text : boxLabel;
    return {
      root: styleEl,
      parts: parts,
      anchorLabel: shortLabel(hitIcon ? boxLabel || anchor : anchor || boxLabel),
      textTestId: textTestId,
      boxTestId: boxTestId,
      testId: boxTestId || textTestId,
      styleEl: styleEl,
      bgEl: bgEl,
    };
  }

  function describe(pick) {
    var styleEl = pick.styleEl || pick.root;
    var bgEl = pick.bgEl || styleEl;
    var cs = window.getComputedStyle(styleEl);
    var bgCs = window.getComputedStyle(bgEl);
    return {
      testId: pick.testId,
      textTestId: pick.textTestId,
      boxTestId: pick.boxTestId,
      anchorLabel: pick.anchorLabel || shortLabel(pick.parts[0] && pick.parts[0].text),
      text: pick.parts.length === 1 ? pick.parts[0].text : "",
      textParts: pick.parts.map(function (p) {
        return { text: p.text, isIcon: Boolean(p.isIcon) };
      }),
      tag: styleEl.tagName ? styleEl.tagName.toLowerCase() : "",
      color: cs.color,
      backgroundColor: bgCs.backgroundColor,
      fontSize: cs.fontSize,
    };
  }

  function clearOutlineOnly() {
    if (lastHighlight) {
      lastHighlight.style.outline = lastOutline;
      lastHighlight = null;
    }
  }

  function clearHighlight() {
    clearOutlineOnly();
    lastPartEls = [];
    lastPartIsIcon = [];
    lastStyleEl = null;
    lastBgEl = null;
  }

  window.addEventListener("message", function (e) {
    var msg = e.data || {};
    if (msg.type === "appable:edit-mode") {
      editMode = Boolean(msg.on);
      if (!editMode) clearHighlight();
      document.body.style.cursor = editMode ? "crosshair" : "";
    } else if (msg.type === "appable:apply-parts") {
      var items = msg.parts || [];
      for (var i = 0; i < items.length; i++) {
        var idx = items[i].index;
        var val = items[i].value;
        var el = lastPartEls[idx];
        if (!el) continue;
        if (lastPartIsIcon[idx] && !String(val || "").trim()) {
          el.style.display = "none";
        } else {
          el.style.display = "";
          if (lastPartIsIcon[idx]) {
            if (val) el.innerText = val;
          } else {
            el.innerText = val;
          }
        }
      }
    } else if (msg.type === "appable:apply" && lastStyleEl) {
      if (msg.prop === "color") lastStyleEl.style.color = msg.value;
      else if (msg.prop === "background" && lastBgEl) lastBgEl.style.backgroundColor = msg.value;
    } else if (msg.type === "appable:clear-outline") {
      clearOutlineOnly();
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
      var pick = pickTarget(e.target, e.clientX, e.clientY);
      if (!pick || !pick.root) return;
      clearHighlight();
      lastHighlight = pick.bgEl || pick.root;
      lastPartEls = pick.parts.map(function (p) {
        return p.el;
      });
      lastPartIsIcon = pick.parts.map(function (p) {
        return Boolean(p.isIcon);
      });
      lastStyleEl = pick.styleEl;
      lastBgEl = pick.bgEl;
      lastOutline = lastHighlight.style.outline;
      lastHighlight.style.outline = "2px solid #c8431d";
      lastHighlight.style.outlineOffset = "1px";
      window.parent.postMessage({ type: "appable:tapped", el: describe(pick) }, "*");
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
    const body = await res.text();
    if (!res.ok) return parseBundleErrorBody(body, res.status);
    return inspectBundleBody(body);
  } catch (err) {
    return `Bundle check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
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

  const bundleError = await checkBundle(projectId);
  if (bundleError) return bundleError;

  return checkPreviewShell(project.metroPort);
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
  await resetToGitRef(projectId, checkpoint.gitRef);
}

/** Nudge Metro to rebundle after git reset (watchers often miss `git reset`). */
export async function invalidateMetroBundle(projectId: string): Promise<void> {
  await execInProject(projectId, ["touch", "index.ts"]).catch(() => {});
  await execInProject(projectId, ["touch", "appable-bridge.js"]).catch(() => {});
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
