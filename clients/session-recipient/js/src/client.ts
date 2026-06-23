import { canonicalJson, type JsonValue } from "./canonicalJson.js";
import {
  decryptChannelMessage,
  encryptChannelMessage,
  exportPublicJwk,
  generateBrowserKeyPair,
  mintPairingAlgorithm,
  randomMessageId,
  type EncryptedChannelMessage,
  type MessageRole
} from "./crypto.js";
import { algorithm, pairingToResolved, parsePairingQrPayload, type ResolvedPairing } from "./pairingPayload.js";

export type PairingInput =
  | { qrPayload: unknown }
  | { brokerBaseUrl: string; shortCode: string };

export type BrowserInfo = {
  name?: string;
  userAgent?: string;
  label?: string;
};

export type EphemeralBrowserSession = {
  token: string;
  sessionId: string;
  expiresAt: string;
  relayerBaseUrl?: string;
};

export type TokenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type TokenStorageOptions =
  | boolean
  | {
      enabled?: boolean;
      storage?: TokenStorage;
    };

export type RequestEphemeralSessionOptions = {
  pairing: PairingInput;
  browserInfo?: BrowserInfo;
  storage?: TokenStorageOptions;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  fetchImpl?: typeof fetch;
};

type OptionalBrowserGlobals = {
  location?: { origin?: unknown };
  navigator?: { userAgent?: unknown };
  localStorage?: Storage;
};

type JoinResponse = {
  channelId: string;
  browserToken: string;
  algorithm: typeof algorithm;
  minterPublicKeyJwk: JsonWebKey;
  expiresAt: string;
  nextSeq: number;
};

type SendMessageResponse = {
  channelId: string;
  seq: number;
  expiresAt: string;
};

type BrokerMessage = EncryptedChannelMessage & {
  seq: number;
};

type PollMessagesResponse = {
  channelId: string;
  expiresAt: string;
  messages: BrokerMessage[];
};

type StoredSession = EphemeralBrowserSession & {
  storedAt: string;
  origin: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, errorMessage: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(errorMessage);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredNumber(record: Record<string, unknown>, key: string, errorMessage: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(errorMessage);
  }
  return value;
}

function requiredJwk(record: Record<string, unknown>, key: string, errorMessage: string): JsonWebKey {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(errorMessage);
  }
  return value;
}

function publicJwkMatches(left: JsonWebKey, right: JsonWebKey): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}

async function jsonResponse(response: Response, errorPrefix: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${String(response.status)}`);
  }
  return response.json() as Promise<unknown>;
}

function normalizeBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function currentOrigin(): string {
  const globalWithLocation = globalThis as unknown as OptionalBrowserGlobals;
  const origin = globalWithLocation.location?.origin;
  if (typeof origin === "string" && origin.length > 0) {
    return origin;
  }
  throw new Error("origin is required");
}

function defaultBrowserInfo(): BrowserInfo {
  const globalWithNavigator = globalThis as unknown as OptionalBrowserGlobals;
  const userAgent = globalWithNavigator.navigator?.userAgent;
  return typeof userAgent === "string" ? { userAgent } : {};
}

function resolveStorage(options: TokenStorageOptions | undefined): TokenStorage | undefined {
  if (options === false) {
    return undefined;
  }
  if (typeof options === "object") {
    if (options.enabled === false) {
      return undefined;
    }
    if (options.storage !== undefined) {
      return options.storage;
    }
  }
  const globalWithStorage = globalThis as unknown as OptionalBrowserGlobals;
  return globalWithStorage.localStorage;
}

function browserInfoToJsonValue(browserInfo: BrowserInfo): JsonValue {
  return {
    ...(browserInfo.name === undefined ? {} : { name: browserInfo.name }),
    ...(browserInfo.userAgent === undefined ? {} : { userAgent: browserInfo.userAgent }),
    ...(browserInfo.label === undefined ? {} : { label: browserInfo.label })
  };
}

function parseResolvedPairing(value: unknown, brokerBaseUrl: string, shortCode: string): ResolvedPairing {
  if (!isRecord(value) || value["algorithm"] !== algorithm) {
    throw new Error("short-code resolution invalid");
  }
  const resolvedBrokerBaseUrl = optionalString(value, "brokerBaseUrl");
  const resolvedPairingToken = optionalString(value, "pairingToken");
  const resolvedShortCode = optionalString(value, "shortCode") ?? shortCode;
  return {
    brokerBaseUrl: normalizeBaseUrl(resolvedBrokerBaseUrl ?? brokerBaseUrl),
    channelId: requiredString(value, "channelId", "short-code resolution invalid"),
    ...(resolvedPairingToken === undefined ? {} : { pairingToken: resolvedPairingToken }),
    shortCode: resolvedShortCode,
    expiresAt: requiredString(value, "expiresAt", "short-code resolution invalid"),
    algorithm,
    minterPublicKeyJwk: requiredJwk(value, "minterPublicKeyJwk", "short-code resolution invalid")
  };
}

function parseJoin(value: unknown, channelId: string): JoinResponse {
  if (!isRecord(value) || value["algorithm"] !== algorithm) {
    throw new Error("channel join invalid");
  }
  const joinedChannelId = requiredString(value, "channelId", "channel join invalid");
  if (joinedChannelId !== channelId) {
    throw new Error("channel join invalid");
  }
  return {
    channelId: joinedChannelId,
    browserToken: requiredString(value, "browserToken", "channel join invalid"),
    algorithm,
    minterPublicKeyJwk: requiredJwk(value, "minterPublicKeyJwk", "channel join invalid"),
    expiresAt: requiredString(value, "expiresAt", "channel join invalid"),
    nextSeq: requiredNumber(value, "nextSeq", "channel join invalid")
  };
}

function parseSend(value: unknown, channelId: string): SendMessageResponse {
  if (!isRecord(value)) {
    throw new Error("message send invalid");
  }
  const sentChannelId = requiredString(value, "channelId", "message send invalid");
  if (sentChannelId !== channelId) {
    throw new Error("message send invalid");
  }
  return {
    channelId: sentChannelId,
    seq: requiredNumber(value, "seq", "message send invalid"),
    expiresAt: requiredString(value, "expiresAt", "message send invalid")
  };
}

function parseBrokerMessage(value: unknown): BrokerMessage {
  if (!isRecord(value) || value["algorithm"] !== mintPairingAlgorithm) {
    throw new Error("poll response invalid");
  }
  const sender = requiredString(value, "sender", "poll response invalid");
  const recipient = requiredString(value, "recipient", "poll response invalid");
  if (!isMessageRole(sender) || !isMessageRole(recipient)) {
    throw new Error("poll response invalid");
  }
  return {
    seq: requiredNumber(value, "seq", "poll response invalid"),
    messageId: requiredString(value, "messageId", "poll response invalid"),
    sender,
    recipient,
    algorithm: mintPairingAlgorithm,
    aad: requiredString(value, "aad", "poll response invalid"),
    nonce: requiredString(value, "nonce", "poll response invalid"),
    ciphertext: requiredString(value, "ciphertext", "poll response invalid"),
    ...(isRecord(value["senderPublicKeyJwk"]) ? { senderPublicKeyJwk: value["senderPublicKeyJwk"] } : {})
  };
}

function parsePoll(value: unknown, channelId: string): PollMessagesResponse {
  if (!isRecord(value)) {
    throw new Error("poll response invalid");
  }
  const polledChannelId = requiredString(value, "channelId", "poll response invalid");
  if (polledChannelId !== channelId) {
    throw new Error("poll response invalid");
  }
  const messagesValue = value["messages"];
  if (!Array.isArray(messagesValue)) {
    throw new Error("poll response invalid");
  }
  return {
    channelId: polledChannelId,
    expiresAt: requiredString(value, "expiresAt", "poll response invalid"),
    messages: messagesValue.map((message) => parseBrokerMessage(message))
  };
}

function isMessageRole(value: string): value is MessageRole {
  return value === "browser" || value === "minter";
}

function parseSessionPayload(value: unknown, channelId: string, requestMessageId: string): EphemeralBrowserSession {
  if (!isRecord(value) || value["v"] !== 1) {
    throw new Error("mint result invalid");
  }
  const messageChannelId = requiredString(value, "channelId", "mint result invalid");
  if (messageChannelId !== channelId) {
    throw new Error("mint result invalid");
  }
  const responseRequestId = requiredString(value, "requestMessageId", "mint result invalid");
  if (responseRequestId !== requestMessageId) {
    throw new Error("mint result invalid");
  }
  if (value["type"] === "mint_rejected") {
    throw new Error("mint request rejected");
  }
  if (value["type"] !== "mint_succeeded") {
    throw new Error("mint result invalid");
  }
  const session = isRecord(value["session"]) ? value["session"] : value;
  const token = requiredString(session, "token", "mint result invalid");
  const sessionId = requiredString(session, "sessionId", "mint result invalid");
  const expiresAt = requiredString(session, "expiresAt", "mint result invalid");
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error("mint result invalid");
  }
  const relayerBaseUrl = optionalString(session, "relayerBaseUrl");
  return {
    token,
    sessionId,
    expiresAt,
    ...(relayerBaseUrl === undefined ? {} : { relayerBaseUrl })
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolvePairing(input: PairingInput, fetcher: typeof fetch): Promise<ResolvedPairing> {
  if ("qrPayload" in input) {
    const payload = parsePairingQrPayload(input.qrPayload);
    return { ...pairingToResolved(payload), brokerBaseUrl: normalizeBaseUrl(payload.brokerBaseUrl) };
  }
  const brokerBaseUrl = normalizeBaseUrl(input.brokerBaseUrl);
  const response = await fetcher(new URL("/v1/pairing-codes/resolve", brokerBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shortCode: input.shortCode })
  });
  return parseResolvedPairing(await jsonResponse(response, "short-code resolution failed"), brokerBaseUrl, input.shortCode);
}

async function joinChannel(input: {
  fetcher: typeof fetch;
  pairing: ResolvedPairing;
  browserPublicKeyJwk: JsonWebKey;
  origin: string;
  browserInfo: BrowserInfo;
}): Promise<JoinResponse> {
  const body = {
    ...(input.pairing.pairingToken === undefined ? {} : { pairingToken: input.pairing.pairingToken }),
    ...(input.pairing.pairingToken === undefined && input.pairing.shortCode !== undefined ? { shortCode: input.pairing.shortCode } : {}),
    browserPublicKeyJwk: input.browserPublicKeyJwk,
    origin: input.origin,
    browserInfo: input.browserInfo
  };
  const response = await input.fetcher(new URL(`/v1/channels/${encodeURIComponent(input.pairing.channelId)}/join`, input.pairing.brokerBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseJoin(await jsonResponse(response, "channel join failed"), input.pairing.channelId);
}

async function sendMintRequest(input: {
  fetcher: typeof fetch;
  pairing: ResolvedPairing;
  browserToken: string;
  encrypted: EncryptedChannelMessage;
}): Promise<SendMessageResponse> {
  const response = await input.fetcher(new URL(`/v1/channels/${encodeURIComponent(input.pairing.channelId)}/messages`, input.pairing.brokerBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.browserToken}`
    },
    body: JSON.stringify(input.encrypted)
  });
  return parseSend(await jsonResponse(response, "message send failed"), input.pairing.channelId);
}

async function pollMessages(input: {
  fetcher: typeof fetch;
  pairing: ResolvedPairing;
  browserToken: string;
  afterSeq: number;
}): Promise<PollMessagesResponse> {
  const url = new URL(`/v1/channels/${encodeURIComponent(input.pairing.channelId)}/messages`, input.pairing.brokerBaseUrl);
  url.searchParams.set("afterSeq", String(input.afterSeq));
  const response = await input.fetcher(url, { headers: { authorization: `Bearer ${input.browserToken}` } });
  return parsePoll(await jsonResponse(response, "poll failed"), input.pairing.channelId);
}

export function ephemeralBrowserSessionStorageKey(origin: string): string {
  return `ff:ephemeral-browser-session:${origin}`;
}

export function storeEphemeralBrowserSession(storage: TokenStorage, origin: string, session: EphemeralBrowserSession): void {
  const stored: StoredSession = { ...session, origin, storedAt: new Date().toISOString() };
  storage.setItem(ephemeralBrowserSessionStorageKey(origin), JSON.stringify(stored));
}

export function readStoredEphemeralBrowserSession(storage: TokenStorage, origin: string): EphemeralBrowserSession | undefined {
  const raw = storage.getItem(ephemeralBrowserSessionStorageKey(origin));
  if (raw === null) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["origin"] !== origin) {
    return undefined;
  }
  const token = optionalString(value, "token");
  const sessionId = optionalString(value, "sessionId");
  const expiresAt = optionalString(value, "expiresAt");
  const expiresAtMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  if (token === undefined || sessionId === undefined || expiresAt === undefined || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return undefined;
  }
  const relayerBaseUrl = optionalString(value, "relayerBaseUrl");
  return {
    token,
    sessionId,
    expiresAt,
    ...(relayerBaseUrl === undefined ? {} : { relayerBaseUrl })
  };
}

export async function requestEphemeralSession(options: RequestEphemeralSessionOptions): Promise<EphemeralBrowserSession> {
  const fetcher = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const origin = currentOrigin();
  const browserInfo = { ...defaultBrowserInfo(), ...options.browserInfo };
  const storage = resolveStorage(options.storage);
  const existingSession = storage === undefined ? undefined : readStoredEphemeralBrowserSession(storage, origin);
  if (existingSession !== undefined) {
    return existingSession;
  }

  const pairing = await resolvePairing(options.pairing, fetcher);
  const keyPair = await generateBrowserKeyPair();
  const browserPublicKeyJwk = await exportPublicJwk(keyPair.publicKey);
  const join = await joinChannel({ fetcher, pairing, browserPublicKeyJwk, origin, browserInfo });
  if (!publicJwkMatches(join.minterPublicKeyJwk, pairing.minterPublicKeyJwk)) {
    throw new Error("channel join minter key mismatch");
  }

  const requestMessageId = randomMessageId();
  const mintRequestPlaintext: JsonValue = {
    v: 1,
    type: "mint_request",
    channelId: pairing.channelId,
    requestMessageId,
    origin,
    browserInfo: browserInfoToJsonValue(browserInfo),
    browserPublicKeyJwk: browserPublicKeyJwk as unknown as JsonValue,
    requestedAt: new Date().toISOString()
  };
  const encryptedRequest = await encryptChannelMessage({
    privateKey: keyPair.privateKey,
    senderPublicJwk: browserPublicKeyJwk,
    peerPublicJwk: join.minterPublicKeyJwk,
    channelId: pairing.channelId,
    messageId: requestMessageId,
    seq: 0,
    sender: "browser",
    recipient: "minter",
    plaintext: mintRequestPlaintext
  });
  const sent = await sendMintRequest({ fetcher, pairing, browserToken: join.browserToken, encrypted: encryptedRequest });
  const deadline = Date.now() + (options.maxWaitMs ?? 300_000);
  let afterSeq = Math.max(join.nextSeq, sent.seq);
  while (Date.now() <= deadline) {
    let poll: PollMessagesResponse;
    try {
      poll = await pollMessages({ fetcher, pairing, browserToken: join.browserToken, afterSeq });
    } catch (error) {
      if (error instanceof TypeError) {
        await sleep(options.pollIntervalMs ?? 5000);
        continue;
      }
      throw error;
    }
    for (const message of poll.messages) {
      afterSeq = Math.max(afterSeq, message.seq);
      if (message.sender !== "minter" || message.recipient !== "browser") {
        continue;
      }
      const plaintext = await decryptChannelMessage({
        privateKey: keyPair.privateKey,
        peerPublicJwk: join.minterPublicKeyJwk,
        channelId: pairing.channelId,
        messageId: message.messageId,
        seq: message.seq,
        sender: message.sender,
        recipient: message.recipient,
        algorithm: message.algorithm,
        aad: message.aad,
        nonce: message.nonce,
        ciphertext: message.ciphertext
      });
      const session = parseSessionPayload(plaintext, pairing.channelId, requestMessageId);
      if (storage !== undefined) {
        storeEphemeralBrowserSession(storage, origin, session);
      }
      return session;
    }
    await sleep(options.pollIntervalMs ?? 5000);
  }
  throw new Error("poll timed out");
}
