import type { ServerEvent } from "@appable/shared";
import { serializeEvent } from "@appable/shared";
import type { WebSocket } from "ws";

/**
 * Per-project event bus. Every connected socket for a project receives
 * every ServerEvent emitted for that project.
 */
const sockets = new Map<string, Set<WebSocket>>();

export function addSocket(projectId: string, ws: WebSocket): void {
  let set = sockets.get(projectId);
  if (!set) {
    set = new Set();
    sockets.set(projectId, set);
  }
  set.add(ws);
}

export function removeSocket(projectId: string, ws: WebSocket): void {
  const set = sockets.get(projectId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) sockets.delete(projectId);
  }
}

export function emit(projectId: string, event: ServerEvent): void {
  const set = sockets.get(projectId);
  if (!set) return;
  const payload = serializeEvent(event);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}
