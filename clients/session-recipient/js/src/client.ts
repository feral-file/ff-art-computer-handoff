import { algorithm, buildHandoffPayload, encodeHandoffPayload, type HandoffPayload } from "./handoffPayload.js";
import { decryptDeliveredPayload, exportPublicJwk, generatePublisherKeyPair } from "./crypto.js";

export type DecryptedPayload = {
  bytes: Uint8Array;
};

export type PollResult =
  | { status: "waiting" }
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "delivered"; payload: DecryptedPayload };

export type ArtComputerHandoffSession = {
  sid: string;
  controllerToken: string;
  handoffPayload: HandoffPayload;
  qrPayload: string;
  checkCode: string;
  pollOnce: () => Promise<PollResult>;
  pollUntilDelivered: (options?: { pollIntervalMs?: number; maxWaitMs?: number; ackOnDecrypt?: boolean }) => Promise<DecryptedPayload>;
  ack: () => Promise<void>;
};

type CreateResponse = {
  sid: string;
  controllerToken: string;
  expiresAt: string;
  pollUrl: string;
  ackUrl: string;
};

type DeliveredResponse = {
  status: "delivered";
  payload: unknown;
};

type EncryptedPayloadEnvelope = {
  algorithm: string;
  devicePublicKeyJwk: JsonWebKey;
  nonce: string;
  aad: string;
  ciphertext: string;
};

type PollResponse = { status: "waiting" } | { status: "expired" } | { status: "consumed" } | DeliveredResponse;

function encryptedPayloadEnvelope(value: unknown): EncryptedPayloadEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new Error("delivered payload envelope invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["algorithm"] !== "string" ||
    typeof record["nonce"] !== "string" ||
    typeof record["aad"] !== "string" ||
    typeof record["ciphertext"] !== "string" ||
    typeof record["devicePublicKeyJwk"] !== "object" ||
    record["devicePublicKeyJwk"] === null
  ) {
    throw new Error("delivered payload envelope invalid");
  }
  const devicePublicKeyJwk = record["devicePublicKeyJwk"];
  return {
    algorithm: record["algorithm"],
    devicePublicKeyJwk,
    nonce: record["nonce"],
    aad: record["aad"],
    ciphertext: record["ciphertext"]
  };
}

export async function createArtComputerHandoffSession(options: {
  relayerBaseUrl: string;
  origin: string;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<ArtComputerHandoffSession> {
  const fetcher = options.fetchImpl ?? fetch;
  const keyPair = await generatePublisherKeyPair();
  const publisherPublicKeyJwk = await exportPublicJwk(keyPair.publicKey);
  const createResponse = await fetcher(new URL("/v1/sessions", options.relayerBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ origin: options.origin, publisherPublicKeyJwk, algorithm, ttlSeconds: options.ttlSeconds ?? 300 })
  });
  if (!createResponse.ok) {
    throw new Error(`session create failed: ${String(createResponse.status)}`);
  }
  const created = await createResponse.json() as CreateResponse;
  const handoffPayload = await buildHandoffPayload({
    v: 1,
    origin: options.origin,
    sid: created.sid,
    exp: created.expiresAt,
    alg: algorithm,
    bpub: publisherPublicKeyJwk
  });

  const authHeaders = { authorization: `Bearer ${created.controllerToken}` };

  async function ack(): Promise<void> {
    const response = await fetcher(new URL(created.ackUrl, options.relayerBaseUrl), { method: "POST", headers: authHeaders });
    if (!response.ok && response.status !== 410) {
      throw new Error(`ack failed: ${String(response.status)}`);
    }
  }

  async function pollOnce(): Promise<PollResult> {
    const response = await fetcher(new URL(created.pollUrl, options.relayerBaseUrl), { headers: authHeaders });
    if (response.status === 410) {
      return { status: "consumed" };
    }
    if (!response.ok) {
      throw new Error(`poll failed: ${String(response.status)}`);
    }
    const body = await response.json() as PollResponse;
    if (body.status === "waiting" || body.status === "expired" || body.status === "consumed") {
      return body;
    }
    const payload = encryptedPayloadEnvelope(body.payload);
    if (payload.algorithm !== algorithm) {
      throw new Error("delivered payload algorithm mismatch");
    }
    const bytes = await decryptDeliveredPayload({
      privateKey: keyPair.privateKey,
      handoffPayload,
      devicePublicKeyJwk: payload.devicePublicKeyJwk,
      nonce: payload.nonce,
      aad: payload.aad,
      ciphertext: payload.ciphertext
    });
    return { status: "delivered", payload: { bytes } };
  }

  async function pollUntilDelivered(pollOptions?: { pollIntervalMs?: number; maxWaitMs?: number; ackOnDecrypt?: boolean }): Promise<DecryptedPayload> {
    const pollIntervalMs = pollOptions?.pollIntervalMs ?? 5000;
    const deadline = Date.now() + (pollOptions?.maxWaitMs ?? 300_000);
    while (Date.now() <= deadline) {
      const result = await pollOnce();
      if (result.status === "delivered") {
        if (pollOptions?.ackOnDecrypt === true) {
          await ack();
        }
        return result.payload;
      }
      if (result.status === "expired" || result.status === "consumed") {
        throw new Error(`session ${result.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error("poll timed out");
  }

  return {
    sid: created.sid,
    controllerToken: created.controllerToken,
    handoffPayload,
    qrPayload: encodeHandoffPayload(handoffPayload),
    checkCode: handoffPayload.code,
    pollOnce,
    pollUntilDelivered,
    ack
  };
}
