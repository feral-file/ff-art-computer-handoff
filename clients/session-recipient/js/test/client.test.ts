import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ephemeralBrowserSessionStorageKey,
  readStoredEphemeralBrowserSession,
  requestEphemeralSession,
  storeEphemeralBrowserSession,
  type TokenStorage
} from "../src/client.js";
import { encryptChannelMessage, exportPublicJwk, generateBrowserKeyPair } from "../src/crypto.js";

type RequestRecord = {
  url: string;
  init: RequestInit | undefined;
};

const testOrigin = "https://nft.example";
let previousLocationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: testOrigin }
  });
});

afterEach(() => {
  if (previousLocationDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "location");
    return;
  }
  Object.defineProperty(globalThis, "location", previousLocationDescriptor);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected string request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function memoryStorage(): TokenStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    }
  };
}

async function createSuccessMessage(input: {
  minterPrivateKey: CryptoKey;
  browserPublicKeyJwk: JsonWebKey;
  requestMessageId?: string;
  token?: string;
  sessionId?: string;
  expiresAt?: string;
}): Promise<ReturnType<typeof jsonResponse>> {
  const encrypted = await encryptChannelMessage({
    privateKey: input.minterPrivateKey,
    peerPublicJwk: input.browserPublicKeyJwk,
    channelId: "ch_123",
    messageId: "msg_result",
    seq: 2,
    sender: "minter",
    recipient: "browser",
    plaintext: {
      v: 1,
      type: "mint_succeeded",
      channelId: "ch_123",
      ...(input.requestMessageId === undefined ? {} : { requestMessageId: input.requestMessageId }),
      session: {
        token: input.token ?? "browser-session-token",
        sessionId: input.sessionId ?? "sess_123",
        expiresAt: input.expiresAt ?? "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      }
    }
  });
  return jsonResponse({
    channelId: "ch_123",
    expiresAt: "2030-01-01T00:00:00.000Z",
    messages: [{ seq: 2, ...encrypted }]
  });
}

async function createRejectionMessage(input: {
  minterPrivateKey: CryptoKey;
  browserPublicKeyJwk: JsonWebKey;
  requestMessageId?: string;
}): Promise<ReturnType<typeof jsonResponse>> {
  const encrypted = await encryptChannelMessage({
    privateKey: input.minterPrivateKey,
    peerPublicJwk: input.browserPublicKeyJwk,
    channelId: "ch_123",
    messageId: "msg_result",
    seq: 2,
    sender: "minter",
    recipient: "browser",
    plaintext: {
      v: 1,
      type: "mint_rejected",
      channelId: "ch_123",
      ...(input.requestMessageId === undefined ? {} : { requestMessageId: input.requestMessageId }),
      reason: "denied"
    }
  });
  return jsonResponse({
    channelId: "ch_123",
    expiresAt: "2030-01-01T00:00:00.000Z",
    messages: [{ seq: 2, ...encrypted }]
  });
}

describe("requestEphemeralSession", () => {
  it("joins from a QR payload, polls, returns a token result, and stores by origin", async () => {
    const minterKeyPair = await generateBrowserKeyPair();
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    const requests: RequestRecord[] = [];
    let browserPublicKeyJwk: JsonWebKey | undefined;
    let requestMessageId = "";
    let pollCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      requests.push({ url, init });
      if (url.endsWith("/v1/channels/ch_123/join")) {
        const body = requestBody(init);
        expect(body["origin"]).toBe(testOrigin);
        expect(body["pairingToken"]).toBe("pt_123");
        browserPublicKeyJwk = body["browserPublicKeyJwk"] as JsonWebKey;
        return jsonResponse({
          channelId: "ch_123",
          browserToken: "bt_123",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk,
          expiresAt: "2030-01-01T00:00:00.000Z",
          nextSeq: 1
        });
      }
      if (url.endsWith("/v1/channels/ch_123/messages") && init?.method === "POST") {
        const body = requestBody(init);
        expect(body["sender"]).toBe("browser");
        expect(body["recipient"]).toBe("minter");
        expect(init.headers).toEqual(expect.objectContaining({ authorization: "Bearer bt_123" }));
        requestMessageId = body["messageId"] as string;
        return jsonResponse({ channelId: "ch_123", seq: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
      }
      if (url.includes("/v1/channels/ch_123/messages?")) {
        pollCount += 1;
        if (pollCount === 1) {
          return jsonResponse({ channelId: "ch_123", expiresAt: "2030-01-01T00:00:00.000Z", messages: [] });
        }
        expect(browserPublicKeyJwk).toBeDefined();
        return createSuccessMessage({
          minterPrivateKey: minterKeyPair.privateKey,
          browserPublicKeyJwk: browserPublicKeyJwk ?? {},
          requestMessageId
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const storage = memoryStorage();
    const session = await requestEphemeralSession({
      pairing: {
        qrPayload: {
          v: 1,
          type: "ff-mint-pairing",
          brokerBaseUrl: "https://pairing.example",
          channelId: "ch_123",
          pairingToken: "pt_123",
          expiresAt: "2030-01-01T00:00:00.000Z",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk
        }
      },
      browserInfo: { name: "Test Browser" },
      storage: { storage },
      pollIntervalMs: 1,
      fetchImpl
    });
    expect(session).toEqual({
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z",
      relayerBaseUrl: "https://relayer.example"
    });
    expect(storage.entries.has(ephemeralBrowserSessionStorageKey("https://nft.example"))).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      "https://pairing.example/v1/channels/ch_123/join",
      "https://pairing.example/v1/channels/ch_123/messages",
      "https://pairing.example/v1/channels/ch_123/messages?afterSeq=1",
      "https://pairing.example/v1/channels/ch_123/messages?afterSeq=1"
    ]);
  });

  it.each([
    { type: "mint_succeeded", name: "omits requestMessageId" },
    { type: "mint_succeeded", name: "uses a mismatched requestMessageId", responseRequestMessageId: "msg_wrong_request" },
    { type: "mint_rejected", name: "omits requestMessageId" },
    { type: "mint_rejected", name: "uses a mismatched requestMessageId", responseRequestMessageId: "msg_wrong_request" }
  ] as const)("rejects a decrypted $type result that $name", async ({ type, responseRequestMessageId }) => {
    const minterKeyPair = await generateBrowserKeyPair();
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    let browserPublicKeyJwk: JsonWebKey | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/channels/ch_123/join")) {
        browserPublicKeyJwk = requestBody(init)["browserPublicKeyJwk"] as JsonWebKey;
        return jsonResponse({
          channelId: "ch_123",
          browserToken: "bt_123",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk,
          expiresAt: "2030-01-01T00:00:00.000Z",
          nextSeq: 1
        });
      }
      if (url.endsWith("/v1/channels/ch_123/messages") && init?.method === "POST") {
        return jsonResponse({ channelId: "ch_123", seq: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
      }
      if (url.includes("/v1/channels/ch_123/messages?")) {
        expect(browserPublicKeyJwk).toBeDefined();
        const messageInput = {
          minterPrivateKey: minterKeyPair.privateKey,
          browserPublicKeyJwk: browserPublicKeyJwk ?? {},
          ...(responseRequestMessageId === undefined ? {} : { requestMessageId: responseRequestMessageId })
        };
        return type === "mint_succeeded" ? createSuccessMessage(messageInput) : createRejectionMessage(messageInput);
      }
      throw new Error(`unexpected request ${url}`);
    });
    const storage = memoryStorage();

    await expect(requestEphemeralSession({
      pairing: {
        qrPayload: {
          v: 1,
          type: "ff-mint-pairing",
          brokerBaseUrl: "https://pairing.example",
          channelId: "ch_123",
          pairingToken: "pt_123",
          expiresAt: "2030-01-01T00:00:00.000Z",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk
        }
      },
      storage: { storage },
      pollIntervalMs: 1,
      fetchImpl
    })).rejects.toThrow("mint result invalid");
    expect(storage.entries.size).toBe(0);
  });

  it.each([
    { name: "malformed", expiresAt: "not-a-date" },
    { name: "already expired", expiresAt: "2000-01-01T00:00:00.000Z" }
  ])("rejects a decrypted mint_succeeded result with $name expiresAt without storing", async ({ expiresAt }) => {
    const minterKeyPair = await generateBrowserKeyPair();
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    let browserPublicKeyJwk: JsonWebKey | undefined;
    let requestMessageId = "";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/channels/ch_123/join")) {
        browserPublicKeyJwk = requestBody(init)["browserPublicKeyJwk"] as JsonWebKey;
        return jsonResponse({
          channelId: "ch_123",
          browserToken: "bt_123",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk,
          expiresAt: "2030-01-01T00:00:00.000Z",
          nextSeq: 1
        });
      }
      if (url.endsWith("/v1/channels/ch_123/messages") && init?.method === "POST") {
        requestMessageId = requestBody(init)["messageId"] as string;
        return jsonResponse({ channelId: "ch_123", seq: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
      }
      if (url.includes("/v1/channels/ch_123/messages?")) {
        expect(browserPublicKeyJwk).toBeDefined();
        return createSuccessMessage({
          minterPrivateKey: minterKeyPair.privateKey,
          browserPublicKeyJwk: browserPublicKeyJwk ?? {},
          requestMessageId,
          expiresAt
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const storage = memoryStorage();

    await expect(requestEphemeralSession({
      pairing: {
        qrPayload: {
          v: 1,
          type: "ff-mint-pairing",
          brokerBaseUrl: "https://pairing.example",
          channelId: "ch_123",
          pairingToken: "pt_123",
          expiresAt: "2030-01-01T00:00:00.000Z",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk
        }
      },
      storage: { storage },
      pollIntervalMs: 1,
      fetchImpl
    })).rejects.toThrow("mint result invalid");
    expect(storage.entries.size).toBe(0);
  });

  it("resolves a short code before joining the channel", async () => {
    const minterKeyPair = await generateBrowserKeyPair();
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    let browserPublicKeyJwk: JsonWebKey | undefined;
    let requestMessageId = "";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/pairing-codes/resolve")) {
        expect(requestBody(init)["shortCode"]).toBe("123456");
        return jsonResponse({
          channelId: "ch_123",
          shortCode: "123456",
          expiresAt: "2030-01-01T00:00:00.000Z",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk
        });
      }
      if (url.endsWith("/v1/channels/ch_123/join")) {
        const body = requestBody(init);
        expect(body["shortCode"]).toBe("123456");
        browserPublicKeyJwk = body["browserPublicKeyJwk"] as JsonWebKey;
        return jsonResponse({
          channelId: "ch_123",
          browserToken: "bt_123",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk,
          expiresAt: "2030-01-01T00:00:00.000Z",
          nextSeq: 1
        });
      }
      if (url.endsWith("/v1/channels/ch_123/messages") && init?.method === "POST") {
        requestMessageId = requestBody(init)["messageId"] as string;
        return jsonResponse({ channelId: "ch_123", seq: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
      }
      if (url.includes("/v1/channels/ch_123/messages?")) {
        expect(browserPublicKeyJwk).toBeDefined();
        return createSuccessMessage({
          minterPrivateKey: minterKeyPair.privateKey,
          browserPublicKeyJwk: browserPublicKeyJwk ?? {},
          requestMessageId
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const session = await requestEphemeralSession({
      pairing: { brokerBaseUrl: "https://pairing.example", shortCode: "123456" },
      storage: false,
      pollIntervalMs: 1,
      fetchImpl
    });
    expect(session.sessionId).toBe("sess_123");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rejects a join response with a substituted minter public key", async () => {
    const pairingMinterKeyPair = await generateBrowserKeyPair();
    const pairingMinterPublicKeyJwk = await exportPublicJwk(pairingMinterKeyPair.publicKey);
    const substitutedMinterKeyPair = await generateBrowserKeyPair();
    const substitutedMinterPublicKeyJwk = await exportPublicJwk(substitutedMinterKeyPair.publicKey);
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/channels/ch_123/join")) {
        return Promise.resolve(jsonResponse({
          channelId: "ch_123",
          browserToken: "bt_123",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk: substitutedMinterPublicKeyJwk,
          expiresAt: "2030-01-01T00:00:00.000Z",
          nextSeq: 1
        }));
      }
      throw new Error(`unexpected request ${url}`);
    });

    await expect(requestEphemeralSession({
      pairing: {
        qrPayload: {
          v: 1,
          type: "ff-mint-pairing",
          brokerBaseUrl: "https://pairing.example",
          channelId: "ch_123",
          pairingToken: "pt_123",
          expiresAt: "2030-01-01T00:00:00.000Z",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk: pairingMinterPublicKeyJwk
        }
      },
      storage: false,
      pollIntervalMs: 1,
      fetchImpl
    })).rejects.toThrow("channel join minter key mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps storage keys origin scoped", () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, "https://nft.example", {
      token: "token-a",
      sessionId: "sess_a",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    storeEphemeralBrowserSession(storage, "https://other.example", {
      token: "token-b",
      sessionId: "sess_b",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    expect(ephemeralBrowserSessionStorageKey("https://nft.example")).not.toBe(ephemeralBrowserSessionStorageKey("https://other.example"));
    expect(readStoredEphemeralBrowserSession(storage, "https://nft.example")?.token).toBe("token-a");
    expect(readStoredEphemeralBrowserSession(storage, "https://other.example")?.token).toBe("token-b");
    storage.setItem(ephemeralBrowserSessionStorageKey("https://broken.example"), "{");
    expect(readStoredEphemeralBrowserSession(storage, "https://broken.example")).toBeUndefined();
  });

  it("does not leak raw tokens in thrown errors", async () => {
    const minterKeyPair = await generateBrowserKeyPair();
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    let browserPublicKeyJwk: JsonWebKey | undefined;
    let requestMessageId = "";
    const rawToken = "super-secret-browser-session-token";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/channels/ch_123/join")) {
        browserPublicKeyJwk = requestBody(init)["browserPublicKeyJwk"] as JsonWebKey;
        return jsonResponse({
          channelId: "ch_123",
          browserToken: "bt_123",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk,
          expiresAt: "2030-01-01T00:00:00.000Z",
          nextSeq: 1
        });
      }
      if (url.endsWith("/v1/channels/ch_123/messages") && init?.method === "POST") {
        requestMessageId = requestBody(init)["messageId"] as string;
        return jsonResponse({ channelId: "ch_123", seq: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
      }
      if (url.includes("/v1/channels/ch_123/messages?")) {
        expect(browserPublicKeyJwk).toBeDefined();
        return createSuccessMessage({
          minterPrivateKey: minterKeyPair.privateKey,
          browserPublicKeyJwk: browserPublicKeyJwk ?? {},
          requestMessageId,
          token: rawToken,
          sessionId: ""
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    await expect(requestEphemeralSession({
      pairing: {
        qrPayload: {
          v: 1,
          type: "ff-mint-pairing",
          brokerBaseUrl: "https://pairing.example",
          channelId: "ch_123",
          pairingToken: "pt_123",
          expiresAt: "2030-01-01T00:00:00.000Z",
          algorithm: "P256-HKDF-SHA256-AES-256-GCM",
          minterPublicKeyJwk
        }
      },
      storage: false,
      pollIntervalMs: 1,
      fetchImpl
    })).rejects.not.toThrow(rawToken);
  });
});
