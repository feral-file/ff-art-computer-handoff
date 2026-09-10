import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  displayDp1Playlist,
  ephemeralBrowserSessionStorageKey,
  maxRequestedExpiresInSeconds,
  readStoredEphemeralBrowserSession,
  requestEphemeralSession,
  storeEphemeralBrowserSession,
  type EphemeralBrowserSession,
  type TokenStorage
} from "../src/client.js";
import { decryptChannelMessage, encryptChannelMessage, exportPublicJwk, generateBrowserKeyPair } from "../src/crypto.js";
import type { JsonValue } from "../src/canonicalJson.js";

type RequestRecord = {
  url: string;
  init: RequestInit | undefined;
};

const testOrigin = "https://nft.example";
let previousLocationDescriptor: PropertyDescriptor | undefined;
let previousFetchDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  previousFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: testOrigin }
  });
});

afterEach(() => {
  if (previousLocationDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "location");
  } else {
    Object.defineProperty(globalThis, "location", previousLocationDescriptor);
  }
  if (previousFetchDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "fetch");
  } else {
    Object.defineProperty(globalThis, "fetch", previousFetchDescriptor);
  }
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

function authorizationHeader(init: RequestInit | undefined): string | null {
  const headers = new Headers(init?.headers);
  return headers.get("authorization");
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
  expiresAt?: string | null;
  persistent?: boolean;
}): Promise<ReturnType<typeof jsonResponse>> {
  const session: Record<string, JsonValue> = {
    token: input.token ?? "browser-session-token",
    sessionId: input.sessionId ?? "sess_123",
    relayerBaseUrl: "https://relayer.example"
  };
  if (input.persistent === true) {
    session["persistent"] = true;
  }
  if (input.expiresAt !== undefined) {
    session["expiresAt"] = input.expiresAt;
  } else if (input.persistent !== true) {
    session["expiresAt"] = "2030-01-01T00:00:00.000Z";
  }
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
      session
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

async function decryptMintRequest(minterPrivateKey: CryptoKey, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const plaintext = await decryptChannelMessage({
    privateKey: minterPrivateKey,
    peerPublicJwk: body["senderPublicKeyJwk"] as JsonWebKey,
    channelId: "ch_123",
    messageId: body["messageId"] as string,
    seq: 0,
    sender: "browser",
    recipient: "minter",
    algorithm: body["algorithm"] as string,
    aad: body["aad"] as string,
    nonce: body["nonce"] as string,
    ciphertext: body["ciphertext"] as string
  });
  return plaintext as Record<string, unknown>;
}

/** Runs the happy-path mint flow and returns the session plus the decrypted mint request. */
async function runMintFlow(input: {
  requestedExpiresInSeconds?: number;
  session?: { persistent?: boolean; expiresAt?: string | null };
  storage?: TokenStorage;
} = {}): Promise<{ session: EphemeralBrowserSession; mintRequest: Record<string, unknown> }> {
  const minterKeyPair = await generateBrowserKeyPair();
  const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
  let browserPublicKeyJwk: JsonWebKey | undefined;
  let requestMessageId = "";
  let mintRequest: Record<string, unknown> | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (requestInput, init) => {
    const url = requestUrl(requestInput);
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
      const body = requestBody(init);
      requestMessageId = body["messageId"] as string;
      mintRequest = await decryptMintRequest(minterKeyPair.privateKey, body);
      return jsonResponse({ channelId: "ch_123", seq: 1, expiresAt: "2030-01-01T00:00:00.000Z" });
    }
    if (url.includes("/v1/channels/ch_123/messages?")) {
      return createSuccessMessage({
        minterPrivateKey: minterKeyPair.privateKey,
        browserPublicKeyJwk: browserPublicKeyJwk ?? {},
        requestMessageId,
        ...(input.session?.persistent === undefined ? {} : { persistent: input.session.persistent }),
        ...(input.session?.expiresAt === undefined ? {} : { expiresAt: input.session.expiresAt })
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
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
    storage: input.storage === undefined ? false : { storage: input.storage },
    pollIntervalMs: 1,
    ...(input.requestedExpiresInSeconds === undefined ? {} : { requestedExpiresInSeconds: input.requestedExpiresInSeconds }),
    fetchImpl
  });
  if (mintRequest === undefined) {
    throw new Error("mint request was never sent");
  }
  return { session, mintRequest };
}

describe("requestEphemeralSession", () => {
  it("calls the default global fetch with the global receiver", async () => {
    const minterKeyPair = await generateBrowserKeyPair();
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    let browserPublicKeyJwk: JsonWebKey | undefined;
    let requestMessageId = "";
    const fetchImpl = vi.fn(async function (this: typeof globalThis, input: Parameters<typeof fetch>[0], init?: RequestInit) {
      expect(this).toBe(globalThis);
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
          requestMessageId
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchImpl
    });

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
      storage: false,
      pollIntervalMs: 1
    });

    expect(session.sessionId).toBe("sess_123");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

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

  it("declares support for owner-kept sessions in every mint request", async () => {
    const { mintRequest } = await runMintFlow();
    expect(mintRequest["supportsPersistentSessions"]).toBe(true);
  });

  it("sends the requested session lifetime in the mint request when set", async () => {
    const { mintRequest } = await runMintFlow({ requestedExpiresInSeconds: 3600 });
    expect(mintRequest["type"]).toBe("mint_request");
    expect(mintRequest["requestedExpiresInSeconds"]).toBe(3600);
  });

  it("omits the requested session lifetime when unset", async () => {
    const { mintRequest } = await runMintFlow();
    expect(mintRequest["type"]).toBe("mint_request");
    expect(mintRequest).not.toHaveProperty("requestedExpiresInSeconds");
  });

  it("sends the maximum requested session lifetime", async () => {
    const { mintRequest } = await runMintFlow({ requestedExpiresInSeconds: maxRequestedExpiresInSeconds });
    expect(mintRequest["requestedExpiresInSeconds"]).toBe(31_536_000);
  });

  it.each([
    0,
    -60,
    1.5,
    Number.NaN,
    maxRequestedExpiresInSeconds + 1,
    2 ** 53,
    1e21,
    Number.POSITIVE_INFINITY
  ])("rejects a requested session lifetime of %s", async (requestedExpiresInSeconds) => {
    await expect(runMintFlow({ requestedExpiresInSeconds })).rejects.toThrow("requestedExpiresInSeconds must be a whole number of seconds from 1 to 31536000");
  });

  it.each([
    { name: "omits expiresAt", expiresAt: undefined },
    { name: "sends a null expiresAt", expiresAt: null }
  ])("keeps an owner-kept session that $name", async ({ expiresAt }) => {
    const storage = memoryStorage();
    const { session } = await runMintFlow({
      session: { persistent: true, ...(expiresAt === undefined ? {} : { expiresAt }) },
      storage
    });
    expect(session).toEqual({
      token: "browser-session-token",
      sessionId: "sess_123",
      persistent: true,
      relayerBaseUrl: "https://relayer.example"
    });
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toEqual(session);
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

  it.each([
    { name: "null", expiresAt: null },
    { name: "absent", expiresAt: undefined }
  ])("treats a stored session with $name expiresAt as valid", ({ expiresAt }) => {
    const storage = memoryStorage();
    storage.setItem(ephemeralBrowserSessionStorageKey(testOrigin), JSON.stringify({
      token: "token-kept",
      sessionId: "sess_kept",
      persistent: true,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      origin: testOrigin,
      storedAt: "2026-01-01T00:00:00.000Z"
    }));
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toEqual({
      token: "token-kept",
      sessionId: "sess_kept",
      persistent: true
    });
  });

  it.each([
    { name: "null", expiresAt: null },
    { name: "absent", expiresAt: undefined }
  ])("rejects and clears a stored session with $name expiresAt and no persistent marker", ({ expiresAt }) => {
    const storage = memoryStorage();
    const key = ephemeralBrowserSessionStorageKey(testOrigin);
    storage.setItem(key, JSON.stringify({
      token: "token-unmarked",
      sessionId: "sess_unmarked",
      ...(expiresAt === undefined ? {} : { expiresAt }),
      origin: testOrigin,
      storedAt: "2026-01-01T00:00:00.000Z"
    }));
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toBeUndefined();
    expect(storage.entries.has(key)).toBe(false);
  });

  it("clears a stored session it can no longer use", () => {
    const storage = memoryStorage();
    const key = ephemeralBrowserSessionStorageKey(testOrigin);
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "token-timed",
      sessionId: "sess_timed",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toBeUndefined();
    expect(storage.entries.has(key)).toBe(false);
    storage.setItem(key, "{");
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toBeUndefined();
    expect(storage.entries.has(key)).toBe(false);
  });

  it("still expires a stored timed session", () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "token-timed",
      sessionId: "sess_timed",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)?.sessionId).toBe("sess_timed");
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "token-timed",
      sessionId: "sess_timed",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toBeUndefined();
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

describe("displayDp1Playlist", () => {
  it("wraps a DP1 playlist in the FF1 display command envelope", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      expect(init?.method).toBe("POST");
      expect(authorizationHeader(init)).toBe("Bearer browser-session-token");
      expect(requestBody(init)).toEqual({
        command: "displayPlaylist",
        request: {
          intent: {
            action: "now_display"
          },
          dp1_call: {
            dpVersion: "1.1.0",
            title: "Browser Playlist",
            items: []
          }
        }
      });
      return Promise.resolve(jsonResponse({ message: { message: { ok: true } } }));
    });

    await displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example/root/"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      fetchImpl
    });

    expect(requestUrl(fetchImpl.mock.calls[0]?.[0] ?? "")).toBe("https://relayer.example/api/cast");
  });

  it("uses the explicit relayer URL when the session does not include one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ message: { ok: true } })));

    await displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      relayerBaseUrl: "https://fallback-relayer.example",
      fetchImpl
    });

    expect(requestUrl(fetchImpl.mock.calls[0]?.[0] ?? "")).toBe("https://fallback-relayer.example/api/cast");
  });

  it("rejects a browser session rejected by the relayer without leaking the token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ error: "nope" }, 401)));
    const rawToken = "super-secret-browser-session-token";

    await expect(displayDp1Playlist({
      session: {
        token: rawToken,
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      fetchImpl
    })).rejects.not.toThrow(rawToken);
    await expect(displayDp1Playlist({
      session: {
        token: rawToken,
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      fetchImpl
    })).rejects.toThrow("browser session rejected");
  });

  it("rejects an FF1-level display failure without echoing playlist content", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      message: {
        message: {
          ok: false,
          playlistTitle: "Private Playlist"
        }
      }
    })));

    await expect(displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Private Playlist",
        items: []
      },
      fetchImpl
    })).rejects.toThrow("FF1 rejected display request");
    await expect(displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Private Playlist",
        items: []
      },
      fetchImpl
    })).rejects.not.toThrow("Private Playlist");
  });

  it("requires a relayer URL", async () => {
    await expect(displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      relayerBaseUrl: " "
    })).rejects.toThrow("relayer base URL is required");
  });
});
