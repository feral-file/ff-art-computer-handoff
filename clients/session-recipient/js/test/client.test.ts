import { describe, expect, it, vi } from "vitest";
import { createArtComputerHandoffSession } from "../src/client.js";

describe("JS client", () => {
  it("builds handoff and QR payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({
      sid: "sid",
      controllerToken: "token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollUrl: "/v1/sessions/sid/payload",
      ackUrl: "/v1/sessions/sid/ack"
    }), { status: 201 }));
    const session = await createArtComputerHandoffSession({ relayerBaseUrl: "http://127.0.0.1:3000", origin: "https://example.com", fetchImpl });
    expect(session.handoffPayload.sid).toBe("sid");
    expect(session.handoffPayload).not.toHaveProperty("controllerToken");
    expect(session.qrPayload).toContain("\"sid\":\"sid\"");
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ status: "waiting" }), { status: 200 }));
    expect(await session.pollOnce()).toEqual({ status: "waiting" });
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ status: "consumed" }), { status: 410 }));
    expect(await session.pollOnce()).toEqual({ status: "consumed" });
    const createRequest = fetchImpl.mock.calls[0]?.[1];
    expect(typeof createRequest?.body).toBe("string");
    const createBody = JSON.parse(createRequest?.body as string) as { ttlSeconds: number };
    expect(createBody.ttlSeconds).toBe(300);
  });

  it("times out polling", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({
      sid: "sid",
      controllerToken: "token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollUrl: "/v1/sessions/sid/payload",
      ackUrl: "/v1/sessions/sid/ack"
    }), { status: 201 }));
    const session = await createArtComputerHandoffSession({ relayerBaseUrl: "http://127.0.0.1:3000", origin: "https://example.com", fetchImpl });
    fetchImpl.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ status: "waiting" }), { status: 200 })));
    await expect(session.pollUntilDelivered({ pollIntervalMs: 1, maxWaitMs: 2 })).rejects.toThrow("poll timed out");
  });
});
