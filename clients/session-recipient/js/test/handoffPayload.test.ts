import { describe, expect, it } from "vitest";
import { buildHandoffPayload, deriveCheckCode, encodeHandoffPayload, validateHandoffPayload } from "../src/handoffPayload.js";

describe("handoff payload", () => {
  it("constructs deterministic check codes", async () => {
    const unsigned = {
      v: 1 as const,
      origin: "https://example.com",
      sid: "sid",
      exp: "2030-01-01T00:00:00.000Z",
      alg: "P256-HKDF-SHA256-AES-256-GCM" as const,
      bpub: { kty: "EC", crv: "P-256", x: "x", y: "y" }
    };
    const payload = await buildHandoffPayload(unsigned);
    expect(payload.code).toBe(await deriveCheckCode(unsigned));
    expect(await validateHandoffPayload(payload)).toBe(true);
    expect(encodeHandoffPayload(payload)).toContain('"sid":"sid"');
  });
});
