import { type JsonValue } from "./canonicalJson.js";
import { base64UrlDecode } from "./crypto.js";

export const algorithm = "P256-HKDF-SHA256-AES-256-GCM" as const;
export type Algorithm = typeof algorithm;

export type PairingQrPayload = {
  v: 1;
  type: "ff-mint-pairing";
  brokerBaseUrl: string;
  channelId: string;
  pairingToken?: string;
  shortCode?: string;
  expiresAt: string;
  algorithm: Algorithm;
  minterPublicKeyJwk: JsonWebKey;
};

export type ResolvedPairing = {
  brokerBaseUrl: string;
  channelId: string;
  pairingToken?: string;
  shortCode?: string;
  expiresAt: string;
  algorithm: Algorithm;
  minterPublicKeyJwk: JsonWebKey;
};

const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid pairing payload");
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid pairing payload");
  }
  return value;
}

function requirePublicJwk(record: Record<string, unknown>, key: string): JsonWebKey {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error("invalid pairing payload");
  }
  return value;
}

function parseStringPayload(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as unknown;
  }
  const url = new URL(trimmed);
  const encodedPayload = url.searchParams.get("payload") ?? url.searchParams.get("pairing");
  if (encodedPayload === null) {
    throw new Error("invalid pairing payload");
  }
  if (encodedPayload.trim().startsWith("{")) {
    return JSON.parse(encodedPayload) as unknown;
  }
  return JSON.parse(textDecoder.decode(base64UrlDecode(encodedPayload))) as unknown;
}

export function parsePairingQrPayload(input: unknown): PairingQrPayload {
  const value = typeof input === "string" ? parseStringPayload(input) : input;
  if (!isRecord(value)) {
    throw new Error("invalid pairing payload");
  }
  if (value["v"] !== 1 || value["type"] !== "ff-mint-pairing" || value["algorithm"] !== algorithm) {
    throw new Error("invalid pairing payload");
  }
  const pairingToken = optionalString(value, "pairingToken");
  const shortCode = optionalString(value, "shortCode");
  if (pairingToken === undefined && shortCode === undefined) {
    throw new Error("invalid pairing payload");
  }
  return {
    v: 1,
    type: "ff-mint-pairing",
    brokerBaseUrl: requireString(value, "brokerBaseUrl"),
    channelId: requireString(value, "channelId"),
    ...(pairingToken === undefined ? {} : { pairingToken }),
    ...(shortCode === undefined ? {} : { shortCode }),
    expiresAt: requireString(value, "expiresAt"),
    algorithm,
    minterPublicKeyJwk: requirePublicJwk(value, "minterPublicKeyJwk")
  };
}

export function pairingToResolved(payload: PairingQrPayload): ResolvedPairing {
  return {
    brokerBaseUrl: payload.brokerBaseUrl,
    channelId: payload.channelId,
    ...(payload.pairingToken === undefined ? {} : { pairingToken: payload.pairingToken }),
    ...(payload.shortCode === undefined ? {} : { shortCode: payload.shortCode }),
    expiresAt: payload.expiresAt,
    algorithm: payload.algorithm,
    minterPublicKeyJwk: payload.minterPublicKeyJwk
  };
}

export function channelBindingFields(channelId: string): JsonValue {
  return { algorithm, channelId, v: 1 };
}
