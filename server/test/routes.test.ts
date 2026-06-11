import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { algorithm, type PublicJwk } from "../src/schemas.js";

const jwk: PublicJwk = {
  kty: "EC",
  crv: "P-256",
  x: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
  y: "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"
};
let app: FastifyInstance | undefined;

async function testApp(): Promise<FastifyInstance> {
  app = await buildApp({ dbPath: mkdtempSync(join(tmpdir(), "art-computer-handoff-routes-")), enableRateLimit: false });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("routes", () => {
  it("creates, polls, submits, and keeps delivered payload readable", async () => {
    const instance = await testApp();
    const created = await instance.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { origin: "https://example.com", publisherPublicKeyJwk: jwk, algorithm, ttlSeconds: 120 }
    });
    expect(created.statusCode).toBe(201);
    const createBody = created.json<{ sid: string; controllerToken: string }>();
    expect((await instance.inject({ method: "GET", url: `/v1/sessions/${createBody.sid}/payload` })).statusCode).toBe(401);
    expect((await instance.inject({ method: "GET", url: `/v1/sessions/${createBody.sid}/payload`, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await instance.inject({ method: "GET", url: `/v1/sessions/${createBody.sid}/payload`, headers: { authorization: `Bearer ${createBody.controllerToken}` } })).json()).toMatchObject({ status: "waiting" });
    const submitted = await instance.inject({
      method: "POST",
      url: `/v1/sessions/${createBody.sid}/payload`,
      payload: { payload: { algorithm, devicePublicKeyJwk: jwk, nonce: "AAAAAAAAAAAAAAAA", aad: "YWFk", ciphertext: "Y2lwaGVy" } }
    });
    expect(submitted.statusCode).toBe(201);
    const firstPoll = await instance.inject({ method: "GET", url: `/v1/sessions/${createBody.sid}/payload`, headers: { authorization: `Bearer ${createBody.controllerToken}` } });
    expect(firstPoll.json()).toMatchObject({ status: "delivered", payload: { ciphertext: "Y2lwaGVy" } });
    expect((await instance.inject({
      method: "POST",
      url: `/v1/sessions/${createBody.sid}/ack`,
      headers: { authorization: `Bearer ${createBody.controllerToken}` }
    })).statusCode).toBe(200);
    const secondPoll = await instance.inject({ method: "GET", url: `/v1/sessions/${createBody.sid}/payload`, headers: { authorization: `Bearer ${createBody.controllerToken}` } });
    expect(secondPoll.statusCode).toBe(200);
    expect(secondPoll.json()).toMatchObject({ status: "delivered", payload: { ciphertext: "Y2lwaGVy" } });
  });

  it("rejects expired submit", async () => {
    const instance = await testApp();
    const created = await instance.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { origin: "https://example.com", publisherPublicKeyJwk: jwk, algorithm, ttlSeconds: 15 }
    });
    const body = created.json<{ sid: string }>();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await instance.inject({
      method: "POST",
      url: `/v1/sessions/${body.sid}/payload`,
      payload: { payload: { algorithm, devicePublicKeyJwk: jwk, nonce: "AAAAAAAAAAAAAAAA", aad: "YWFk", ciphertext: "Y2lwaGVy" } }
    })).statusCode).toBe(201);
  });
});
