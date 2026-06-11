import { nanoid } from "nanoid";
import type { SessionDb } from "./db.js";
import { constantTimeEqual, sha256Base64Url } from "./cryptoHash.js";
import { algorithm, maxOpaquePayloadJsonBytes, type CreateSessionRequest, type SessionRecord, type SubmitPayloadRequest } from "./schemas.js";

export const maxPayloadBytes = maxOpaquePayloadJsonBytes;

export class SessionStore {
  public constructor(private readonly db: SessionDb) {}

  public async create(input: CreateSessionRequest): Promise<{ record: SessionRecord; controllerToken: string }> {
    const sid = nanoid(24);
    const controllerToken = nanoid(48);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
    const record: SessionRecord = {
      sid,
      controllerTokenHash: sha256Base64Url(controllerToken),
      origin: input.origin,
      algorithm,
      publisherPublicKeyJwk: input.publisherPublicKeyJwk,
      status: "waiting",
      createdAt: now.toISOString(),
      expiresAt
    };
    await this.db.put(sid, record);
    return { record, controllerToken };
  }

  public get(sid: string): SessionRecord | undefined {
    const record = this.db.get(sid);
    if (record === undefined) {
      return undefined;
    }
    if (this.isExpired(record) && record.status !== "expired" && record.status !== "consumed") {
      const expired = this.markExpired(record);
      return expired;
    }
    return record;
  }

  public validateControllerToken(record: SessionRecord, token: string): boolean {
    return constantTimeEqual(record.controllerTokenHash, sha256Base64Url(token));
  }

  public submitPayload(sid: string, input: SubmitPayloadRequest): { ok: true; record: SessionRecord } | { ok: false; reason: string } {
    const serializedPayload = JSON.stringify(input.payload);
    if (Buffer.byteLength(serializedPayload, "utf8") > maxPayloadBytes) {
      return { ok: false, reason: "payload_too_large" };
    }
    let result: { ok: true; record: SessionRecord } | { ok: false; reason: string } = { ok: false, reason: "unknown" };
    this.db.transactionSync(() => {
      const record = this.db.get(sid);
      if (record === undefined) {
        result = { ok: false, reason: "not_found" };
        return;
      }
      if (this.isExpired(record)) {
        this.db.putSync(sid, this.withoutPayload(record, "expired"));
        result = { ok: false, reason: "expired" };
        return;
      }
      if (record.status !== "waiting") {
        result = { ok: false, reason: "not_waiting" };
        return;
      }
      const delivered: SessionRecord = {
        ...record,
        status: "delivered",
        payload: input.payload
      };
      this.db.putSync(sid, delivered);
      result = { ok: true, record: delivered };
    });
    return result;
  }

  public ack(sid: string, token: string): "ok" | "not_found" | "unauthorized" | "expired" | "not_delivered" {
    let result: "ok" | "not_found" | "unauthorized" | "expired" | "not_delivered" = "not_found";
    this.db.transactionSync(() => {
      const record = this.db.get(sid);
      if (record === undefined) {
        result = "not_found";
        return;
      }
      if (!this.validateControllerToken(record, token)) {
        result = "unauthorized";
        return;
      }
      if (this.isExpired(record) && record.status !== "consumed") {
        this.db.putSync(sid, this.withoutPayload(record, "expired"));
        result = "expired";
        return;
      }
      if (record.status === "consumed") {
        result = "ok";
        return;
      }
      if (record.status !== "delivered") {
        result = "not_delivered";
        return;
      }
      result = "ok";
    });
    return result;
  }

  public cancel(sid: string, token: string): "ok" | "not_found" | "unauthorized" {
    let result: "ok" | "not_found" | "unauthorized" = "not_found";
    this.db.transactionSync(() => {
      const record = this.db.get(sid);
      if (record === undefined) {
        result = "not_found";
        return;
      }
      if (!this.validateControllerToken(record, token)) {
        result = "unauthorized";
        return;
      }
      this.db.putSync(sid, this.withoutPayload(record, "consumed"));
      result = "ok";
    });
    return result;
  }

  public cleanupExpired(now = new Date()): number {
    let count = 0;
    for (const { key, value } of this.db.getRange()) {
      if (new Date(value.expiresAt).getTime() <= now.getTime() && value.status !== "expired" && value.status !== "consumed") {
        this.db.putSync(key, this.withoutPayload(value, "expired"));
        count += 1;
      }
    }
    return count;
  }

  private isExpired(record: SessionRecord): boolean {
    return Date.parse(record.expiresAt) <= Date.now();
  }

  private markExpired(record: SessionRecord): SessionRecord {
    const expired = this.withoutPayload(record, "expired");
    this.db.putSync(record.sid, expired);
    return expired;
  }

  private withoutPayload(record: SessionRecord, status: "consumed" | "expired"): SessionRecord {
    const next: SessionRecord = { ...record, status };
    delete next.payload;
    return next;
  }
}
