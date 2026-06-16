import { describe, expect, it } from "vitest";
import { base64UrlEncode } from "../src/crypto.js";
import { parsePairingQrPayload } from "../src/pairingPayload.js";

const minterPublicKeyJwk = { kty: "EC", crv: "P-256", x: "x", y: "y" };

describe("pairing QR payload", () => {
  it("parses JSON payloads", () => {
    const payload = parsePairingQrPayload(JSON.stringify({
      v: 1,
      type: "ff-mint-pairing",
      brokerBaseUrl: "https://pairing.example",
      channelId: "ch_123",
      pairingToken: "pt_123",
      shortCode: "123456",
      expiresAt: "2030-01-01T00:00:00.000Z",
      algorithm: "P256-HKDF-SHA256-AES-256-GCM",
      minterPublicKeyJwk
    }));
    expect(payload.channelId).toBe("ch_123");
    expect(payload.pairingToken).toBe("pt_123");
    expect(payload.shortCode).toBe("123456");
  });

  it("parses deep-link payload parameters", () => {
    const rawPayload = JSON.stringify({
      v: 1,
      type: "ff-mint-pairing",
      brokerBaseUrl: "https://pairing.example",
      channelId: "ch_456",
      pairingToken: "pt_456",
      expiresAt: "2030-01-01T00:00:00.000Z",
      algorithm: "P256-HKDF-SHA256-AES-256-GCM",
      minterPublicKeyJwk
    });
    const encodedPayload = base64UrlEncode(new TextEncoder().encode(rawPayload));
    const payload = parsePairingQrPayload(`ff://mint-pairing?payload=${encodedPayload}`);
    expect(payload.channelId).toBe("ch_456");
  });

  it("rejects missing pairing material", () => {
    expect(() => parsePairingQrPayload({
      v: 1,
      type: "ff-mint-pairing",
      brokerBaseUrl: "https://pairing.example",
      channelId: "ch_789",
      expiresAt: "2030-01-01T00:00:00.000Z",
      algorithm: "P256-HKDF-SHA256-AES-256-GCM",
      minterPublicKeyJwk
    })).toThrow("invalid pairing payload");
  });
});
