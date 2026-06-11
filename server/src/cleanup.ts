import type { SessionStore } from "./sessionStore.js";

export function startCleanup(store: SessionStore, intervalMs = 30_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    store.cleanupExpired();
  }, intervalMs);
  timer.unref();
  return timer;
}
