import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSessionDb } from "../src/db.js";
import { sha256Base64Url } from "../src/cryptoHash.js";
import { algorithm, type PublicJwk } from "../src/schemas.js";
import { maxPayloadBytes, SessionStore } from "../src/sessionStore.js";

const jwk: PublicJwk = {
  kty: "EC",
  crv: "P-256",
  x: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
  y: "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"
};

function tempDb(): string {
  return mkdtempSync(join(tmpdir(), "art-computer-handoff-server-"));
}

function createStore(): SessionStore {
  return new SessionStore(openSessionDb(tempDb()));
}

describe("SessionStore", () => {
  it("creates durable sessions and stores only token hash", async () => {
    const store = createStore();
    const { record, controllerToken } = await store.create({ origin: "https://example.com", publisherPublicKeyJwk: jwk, algorithm, ttlSeconds: 120 });
    expect(record.controllerTokenHash).toBe(sha256Base64Url(controllerToken));
    expect(record.controllerTokenHash).not.toBe(controllerToken);
    expect(store.get(record.sid)?.sid).toBe(record.sid);
  });

  it("validates and rejects controller tokens", async () => {
    const store = createStore();
    const { record, controllerToken } = await store.create({ origin: "https://example.com", publisherPublicKeyJwk: jwk, algorithm, ttlSeconds: 120 });
    expect(store.validateControllerToken(record, controllerToken)).toBe(true);
    expect(store.validateControllerToken(record, "wrong")).toBe(false);
  });

  it("rejects double delivery and oversized payloads", async () => {
    const store = createStore();
    const { record } = await store.create({ origin: "https://example.com", publisherPublicKeyJwk: jwk, algorithm, ttlSeconds: 120 });
    const payload = { payload: { algorithm, devicePublicKeyJwk: jwk, nonce: "a".repeat(16), aad: "b".repeat(16), ciphertext: "c".repeat(32) } };
    expect(store.submitPayload(record.sid, payload).ok).toBe(true);
    expect(store.submitPayload(record.sid, payload)).toMatchObject({ ok: false, reason: "not_waiting" });
    expect(store.submitPayload("missing", { payload: "a".repeat(maxPayloadBytes + 1) })).toMatchObject({ ok: false, reason: "payload_too_large" });
  });

  it("ACK confirms delivery without tombstoning ciphertext", async () => {
    const store = createStore();
    const { record, controllerToken } = await store.create({ origin: "https://example.com", publisherPublicKeyJwk: jwk, algorithm, ttlSeconds: 120 });
    expect(store.ack(record.sid, "wrong")).toBe("unauthorized");
    expect(store.ack(record.sid, controllerToken)).toBe("not_delivered");
    expect(store.submitPayload(record.sid, { payload: { algorithm, devicePublicKeyJwk: jwk, nonce: "AAAAAAAAAAAAAAAA", aad: "YWFk", ciphertext: "Y2lwaGVy" } }).ok).toBe(true);
    expect(store.ack(record.sid, controllerToken)).toBe("ok");
    expect(store.get(record.sid)?.status).toBe("delivered");
    expect(store.get(record.sid)?.payload).toMatchObject({ ciphertext: "Y2lwaGVy" });
  });

  it("expires sessions during cleanup", async () => {
    const store = createStore();
    const { record } = await store.create({ origin: "https://example.com", publisherPublicKeyJwk: jwk, algorithm, ttlSeconds: 15 });
    expect(store.cleanupExpired(new Date(Date.now() + 20_000))).toBe(1);
    expect(store.get(record.sid)?.status).toBe("expired");
  });

  it("persists records across DB reopen", async () => {
    const path = tempDb();
    const first = new SessionStore(openSessionDb(path));
    const { record } = await first.create({ origin: "https://example.com", publisherPublicKeyJwk: jwk, algorithm, ttlSeconds: 120 });
    const second = new SessionStore(openSessionDb(path));
    expect(second.get(record.sid)?.origin).toBe("https://example.com");
  });
});
