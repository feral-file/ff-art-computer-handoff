import { buildApp } from "@feral-file/art-computer-handoff-server/src/app.js";

const dbPath = process.argv[2];
if (dbPath === undefined) {
  throw new Error("db path argument is required");
}

const app = await buildApp({ dbPath, enableRateLimit: false });
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (address === null || typeof address === "string") {
  throw new Error("unexpected listen address");
}
console.log(JSON.stringify({ port: address.port }));

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown();
});
