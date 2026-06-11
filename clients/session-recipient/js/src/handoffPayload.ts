import { canonicalJson, type JsonValue } from "./canonicalJson.js";
import { base64UrlEncode, sha256 } from "./crypto.js";

export const algorithm = "P256-HKDF-SHA256-AES-256-GCM" as const;
export type Algorithm = typeof algorithm;

export type HandoffPayload = {
  v: 1;
  origin: string;
  sid: string;
  exp: string;
  alg: Algorithm;
  bpub: JsonWebKey;
  code: string;
};

export type HandoffPayloadUnsigned = Omit<HandoffPayload, "code">;

export function aadFields(payload: HandoffPayload): JsonValue {
  return {
    alg: payload.alg,
    code: payload.code,
    exp: payload.exp,
    origin: payload.origin,
    sid: payload.sid,
    v: payload.v
  };
}

export async function deriveCheckCode(unsigned: HandoffPayloadUnsigned): Promise<string> {
  const digest = await sha256(canonicalJson(unsigned as unknown as JsonValue));
  return base64UrlEncode(digest.slice(0, 8));
}

export async function buildHandoffPayload(input: HandoffPayloadUnsigned): Promise<HandoffPayload> {
  return { ...input, code: await deriveCheckCode(input) };
}

export async function validateHandoffPayload(payload: HandoffPayload): Promise<boolean> {
  const unsigned: HandoffPayloadUnsigned = { v: payload.v, origin: payload.origin, sid: payload.sid, exp: payload.exp, alg: payload.alg, bpub: payload.bpub };
  return (await deriveCheckCode(unsigned)) === payload.code;
}

export function encodeHandoffPayload(payload: HandoffPayload): string {
  return canonicalJson(payload as unknown as JsonValue);
}
