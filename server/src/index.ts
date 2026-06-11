import { buildApp } from "./app.js";
import { startCleanup } from "./cleanup.js";
import { openSessionDb } from "./db.js";
import { SessionStore } from "./sessionStore.js";

const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);
const dbPath = process.env["DB_PATH"] ?? "./data/lmdb";

const app = await buildApp({ dbPath });
startCleanup(new SessionStore(openSessionDb(dbPath)));
await app.listen({ host: "0.0.0.0", port });
