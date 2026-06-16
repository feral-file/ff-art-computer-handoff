import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  decryptChannelMessage,
  encryptChannelMessage,
  exportPublicJwk,
  generateBrowserKeyPair,
  requestEphemeralSession
} from "@feral-file/mint-pairing-requester-js";

type CreateChannelResponse = {
  channelId: string;
  minterToken: string;
  pairingToken: string;
  expiresAt: string;
  qrPayload: unknown;
};

type BrokerMessage = {
  seq: number;
  messageId: string;
  sender: "browser" | "minter";
  recipient: "browser" | "minter";
  algorithm: "P256-HKDF-SHA256-AES-256-GCM";
  aad: string;
  nonce: string;
  ciphertext: string;
  senderPublicKeyJwk?: JsonWebKey;
};

type PollMessagesResponse = {
  channelId: string;
  expiresAt: string;
  messages: BrokerMessage[];
};

type MintRequestPlaintext = {
  v: 1;
  type: "mint_request";
  channelId: string;
  requestMessageId: string;
  origin: string;
  browserPublicKeyJwk: JsonWebKey;
};

type DockerBroker = {
  baseUrl: string;
  containerId: string;
  dataDir: string;
};

const imageTag = `mint-pairing-broker-integration:${String(process.pid)}`;
const repoRoot = resolve("..");
const tempDirs: string[] = [];
const containers: string[] = [];

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function dockerOptional(args: string[]): string | undefined {
  try {
    return docker(args);
  } catch {
    return undefined;
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/healthz", baseUrl));
      if (response.ok) {
        return;
      }
      lastError = new Error(`healthz returned ${String(response.status)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw lastError instanceof Error ? lastError : new Error("broker container did not become healthy");
}

async function waitForPublishedPort(containerId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let lastLogs = "";
  while (Date.now() < deadline) {
    const portMapping = dockerOptional(["port", containerId, "8080/tcp"]);
    const port = portMapping?.split(":").at(-1);
    if (port !== undefined && port.length > 0) {
      return port;
    }
    lastLogs = dockerOptional(["logs", containerId]) ?? lastLogs;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`broker container did not publish 8080/tcp. logs:\n${lastLogs}`);
}

async function startBroker(dataDir?: string): Promise<DockerBroker> {
  const brokerDataDir = dataDir ?? mkdtempSync(join(tmpdir(), "mint-pairing-broker-"));
  chmodSync(brokerDataDir, 0o777);
  tempDirs.push(brokerDataDir);
  const containerId = docker([
    "run",
    "--rm",
    "-d",
    "-p",
    "127.0.0.1::8080",
    "-v",
    `${brokerDataDir}:/data`,
    imageTag
  ]);
  containers.push(containerId);
  const port = await waitForPublishedPort(containerId);
  const broker = {
    baseUrl: `http://127.0.0.1:${port}`,
    containerId,
    dataDir: brokerDataDir
  };
  await waitForHealth(broker.baseUrl);
  return broker;
}

function stopBroker(containerId: string): void {
  dockerOptional(["stop", containerId]);
  const index = containers.indexOf(containerId);
  if (index >= 0) {
    containers.splice(index, 1);
  }
}

async function readJSON<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`request failed: ${String(response.status)}`);
  }
  return response.json() as Promise<T>;
}

async function createChannel(baseUrl: string, minterPublicKeyJwk: JsonWebKey): Promise<CreateChannelResponse> {
  const response = await fetch(new URL("/v1/channels", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      algorithm: "P256-HKDF-SHA256-AES-256-GCM",
      minterPublicKeyJwk,
      idleTtlSeconds: 60,
      shortCodeRequested: true
    })
  });
  return readJSON<CreateChannelResponse>(response);
}

async function pollForBrowserRequest(input: {
  baseUrl: string;
  channelId: string;
  minterToken: string;
  minterPrivateKey: CryptoKey;
}): Promise<{ message: BrokerMessage; plaintext: MintRequestPlaintext }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const url = new URL(`/v1/channels/${input.channelId}/messages`, input.baseUrl);
    url.searchParams.set("afterSeq", "0");
    const response = await fetch(url, { headers: { authorization: `Bearer ${input.minterToken}` } });
    const body = await readJSON<PollMessagesResponse>(response);
    const message = body.messages[0];
    if (message !== undefined) {
      if (message.senderPublicKeyJwk === undefined) {
        throw new Error("browser message omitted senderPublicKeyJwk");
      }
      const plaintext = await decryptChannelMessage({
        privateKey: input.minterPrivateKey,
        peerPublicJwk: message.senderPublicKeyJwk,
        channelId: input.channelId,
        messageId: message.messageId,
        seq: message.seq,
        sender: message.sender,
        recipient: message.recipient,
        algorithm: message.algorithm,
        aad: message.aad,
        nonce: message.nonce,
        ciphertext: message.ciphertext
      });
      return { message, plaintext: plaintext as MintRequestPlaintext };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("timed out waiting for browser mint request");
}

async function sendMintSuccess(input: {
  baseUrl: string;
  channelId: string;
  minterToken: string;
  minterPrivateKey: CryptoKey;
  minterPublicKeyJwk: JsonWebKey;
  request: MintRequestPlaintext;
}): Promise<void> {
  const encrypted = await encryptChannelMessage({
    privateKey: input.minterPrivateKey,
    senderPublicJwk: input.minterPublicKeyJwk,
    peerPublicJwk: input.request.browserPublicKeyJwk,
    channelId: input.channelId,
    messageId: "msg_minter_result",
    seq: 0,
    sender: "minter",
    recipient: "browser",
    plaintext: {
      v: 1,
      type: "mint_succeeded",
      channelId: input.channelId,
      requestMessageId: input.request.requestMessageId,
      session: {
        sessionId: "eps_integration",
        token: "integration-browser-session-token",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      }
    }
  });
  const response = await fetch(new URL(`/v1/channels/${input.channelId}/messages`, input.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.minterToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(encrypted)
  });
  expect(response.status).toBe(201);
}

function qrPayloadForBroker(qrPayload: unknown, brokerBaseUrl: string): unknown {
  if (typeof qrPayload !== "object" || qrPayload === null || Array.isArray(qrPayload)) {
    throw new Error("created channel omitted QR payload object");
  }
  return { ...qrPayload, brokerBaseUrl };
}

beforeAll(() => {
  docker(["build", "-f", "server/Dockerfile", "-t", imageTag, "server"]);
}, 120_000);

afterEach(() => {
  for (const containerId of [...containers]) {
    stopBroker(containerId);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  try {
    docker(["image", "rm", "-f", imageTag]);
  } catch {
    // The image may already be gone if Docker cleanup ran externally.
  }
});

describe("mint pairing integration", () => {
  it("pairs browser and minter through a Dockerized bbolt broker and survives broker restart", async () => {
    const firstBroker = await startBroker();
    const minterKeyPair = await generateBrowserKeyPair();
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    const created = await createChannel(firstBroker.baseUrl, minterPublicKeyJwk);

    stopBroker(firstBroker.containerId);
    const broker = await startBroker(firstBroker.dataDir);

    const browserSessionPromise = requestEphemeralSession({
      pairing: { qrPayload: qrPayloadForBroker(created.qrPayload, broker.baseUrl) },
      origin: "https://nft.example",
      browserInfo: { name: "Integration Browser" },
      storage: false,
      pollIntervalMs: 50,
      maxWaitMs: 10_000
    });

    const { plaintext } = await pollForBrowserRequest({
      baseUrl: broker.baseUrl,
      channelId: created.channelId,
      minterToken: created.minterToken,
      minterPrivateKey: minterKeyPair.privateKey
    });
    expect(plaintext).toMatchObject({
      v: 1,
      type: "mint_request",
      channelId: created.channelId,
      origin: "https://nft.example"
    });

    await sendMintSuccess({
      baseUrl: broker.baseUrl,
      channelId: created.channelId,
      minterToken: created.minterToken,
      minterPrivateKey: minterKeyPair.privateKey,
      minterPublicKeyJwk,
      request: plaintext
    });

    await expect(browserSessionPromise).resolves.toEqual({
      token: "integration-browser-session-token",
      sessionId: "eps_integration",
      expiresAt: "2030-01-01T00:00:00.000Z",
      relayerBaseUrl: "https://relayer.example"
    });
  }, 30_000);
});
