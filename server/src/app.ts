import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { openSessionDb } from "./db.js";
import { createSessionRequestSchema, submitPayloadRequestSchema } from "./schemas.js";
import { SessionStore } from "./sessionStore.js";

export type AppOptions = {
  dbPath: string;
  enableRateLimit?: boolean;
};

function bearerToken(header: string | undefined): string | undefined {
  const prefix = "Bearer ";
  return header?.startsWith(prefix) === true ? header.slice(prefix.length) : undefined;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 96 * 1024 });
  const store = new SessionStore(openSessionDb(options.dbPath));
  await app.register(cors, { origin: true });
  if (options.enableRateLimit !== false) {
    await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });
  }
  app.get("/healthz", () => ({ ok: true }));

  app.post("/v1/sessions", async (request, reply) => {
    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { record, controllerToken } = await store.create(parsed.data);
    return reply.code(201).send({
      sid: record.sid,
      controllerToken,
      expiresAt: record.expiresAt,
      pollUrl: `/v1/sessions/${record.sid}/payload`,
      submitUrl: `/v1/sessions/${record.sid}/payload`,
      ackUrl: `/v1/sessions/${record.sid}/ack`
    });
  });

  app.get<{ Params: { sid: string } }>("/v1/sessions/:sid/payload", (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const record = store.get(request.params.sid);
    if (record === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (token === undefined || !store.validateControllerToken(record, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (record.status === "expired") {
      return { status: "expired" };
    }
    if (record.status === "consumed") {
      return reply.code(410).send({ status: "consumed" });
    }
    if (record.status === "waiting") {
      return { status: "waiting" };
    }
    return {
      status: "delivered",
      payload: record.payload
    };
  });

  app.post<{ Params: { sid: string } }>("/v1/sessions/:sid/payload", (request, reply) => {
    const parsed = submitPayloadRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = store.submitPayload(request.params.sid, parsed.data);
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : result.reason === "payload_too_large" ? 413 : 409;
      return reply.code(code).send({ error: result.reason });
    }
    return reply.code(201).send({ status: "delivered" });
  });

  app.post<{ Params: { sid: string } }>("/v1/sessions/:sid/ack", (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const result = store.ack(request.params.sid, token);
    if (result === "not_found") {
      return reply.code(404).send({ error: "not_found" });
    }
    if (result === "unauthorized") {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (result === "expired") {
      return reply.code(409).send({ error: "expired" });
    }
    if (result === "not_delivered") {
      return reply.code(409).send({ error: "not_delivered" });
    }
    return { status: "delivered" };
  });

  app.delete<{ Params: { sid: string } }>("/v1/sessions/:sid", (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const result = store.cancel(request.params.sid, token);
    if (result === "not_found") {
      return reply.code(404).send({ error: "not_found" });
    }
    if (result === "unauthorized") {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return { status: "consumed" };
  });

  return app;
}
