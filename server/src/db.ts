import { mkdirSync } from "node:fs";
import { open, type RootDatabase } from "lmdb";
import type { SessionRecord } from "./schemas.js";

export type SessionDb = RootDatabase<SessionRecord, string>;

export function openSessionDb(path: string): SessionDb {
  mkdirSync(path, { recursive: true });
  return open<SessionRecord, string>({
    path,
    compression: false,
    sharedStructuresKey: Symbol.for("ff-art-computer-handoff.sessions")
  });
}
