import { z } from "zod";

export const algorithm = "P256-HKDF-SHA256-AES-256-GCM" as const;
export type Algorithm = typeof algorithm;
export type PublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  ext?: boolean | undefined;
  key_ops?: string[] | undefined;
};

const base64UrlNoPadRegex = /^[A-Za-z0-9_-]+$/u;

function decodedBase64UrlLength(value: string): number {
  return Buffer.from(value, "base64url").byteLength;
}

const coordinateSchema = z.string().regex(base64UrlNoPadRegex).refine((value) => decodedBase64UrlLength(value) === 32, "Expected 32-byte base64url coordinate");

const jwkSchema: z.ZodType<PublicJwk> = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: coordinateSchema,
  y: coordinateSchema,
  ext: z.boolean().optional(),
  key_ops: z.array(z.string()).optional()
}).strict();

export const maxOpaquePayloadJsonBytes = 64 * 1024;

function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, "utf8");
}

export const createSessionRequestSchema = z.object({
  origin: z.string().url(),
  publisherPublicKeyJwk: jwkSchema,
  algorithm: z.literal(algorithm),
  ttlSeconds: z.number().int().min(15).max(300).default(300)
});

export const submitPayloadRequestSchema = z.object({
  payload: z.unknown().refine((value) => {
    if (value === undefined) {
      return false;
    }
    const length = jsonByteLength(value);
    return length > 0 && length <= maxOpaquePayloadJsonBytes;
  }, "Invalid payload size")
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type SubmitPayloadRequest = z.infer<typeof submitPayloadRequestSchema>;

export type SessionStatus = "waiting" | "delivered" | "consumed" | "expired";

export type SessionRecord = {
  sid: string;
  controllerTokenHash: string;
  origin: string;
  algorithm: Algorithm;
  publisherPublicKeyJwk: PublicJwk;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
  payload?: unknown;
};
