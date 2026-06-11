import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSessionDb } from "../src/db.js";
import { algorithm } from "../src/schemas.js";
import { SessionStore } from "../src/sessionStore.js";

const jwk = {
  kty: "EC" as const,
  crv: "P-256" as const,
  x: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
  y: "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"
};

describe("expiry", () => {
  it("returns expired records after TTL passes", async () => {
    const store = new SessionStore(openSessionDb(mkdtempSync(join(tmpdir(), "art-computer-handoff-expiry-"))));
    const { record } = await store.create({ origin: "https://example.com", publisherPublicKeyJwk: jwk, algorithm, ttlSeconds: 15 });
    store.cleanupExpired(new Date(Date.now() + 16_000));
    expect(store.get(record.sid)?.status).toBe("expired");
  });
});
