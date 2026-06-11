import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "@feral-file/art-computer-handoff-server/src/app.js";
import { aadBytes, base64UrlEncode, createArtComputerHandoffSession, getCrypto, type HandoffPayload } from "@feral-file/art-computer-handoff-js";
import { canonicalJson } from "@feral-file/art-computer-handoff-js";
import { aadFields } from "@feral-file/art-computer-handoff-js";

type TestApp = Awaited<ReturnType<typeof buildApp>>;

let app: TestApp | undefined;
const tempDirs: string[] = [];

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function start(dbPath: string): Promise<{ app: TestApp; baseUrl: string }> {
  app = await buildApp({ dbPath, enableRateLimit: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("unexpected listen address");
  }
  return { app, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

async function deviceEncryptAndSubmit(baseUrl: string, handoffPayload: HandoffPayload, plaintext: Uint8Array): Promise<void> {
  const crypto = getCrypto();
  const deviceKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publisherPublicKey = await crypto.subtle.importKey("jwk", handoffPayload.bpub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: publisherPublicKey }, deviceKeyPair.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(aadFields(handoffPayload))));
  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("ff-art-computer-handoff/v1/aes-gcm") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = aadBytes(handoffPayload);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad), tagLength: 128 }, aesKey, asArrayBuffer(plaintext)));
  const response = await fetch(new URL(`/v1/sessions/${handoffPayload.sid}/payload`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      payload: {
        algorithm: handoffPayload.alg,
        devicePublicKeyJwk: await crypto.subtle.exportKey("jwk", deviceKeyPair.publicKey),
        nonce: base64UrlEncode(nonce),
        aad: base64UrlEncode(aad),
        ciphertext: base64UrlEncode(ciphertext)
      }
    })
  });
  expect(response.status).toBe(201);
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type RelayerChild = ChildProcessByStdio<null, Readable, Readable>;

async function startChild(dbPath: string): Promise<{ child: RelayerChild; baseUrl: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "test/relayer-child.ts", dbPath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child relayer did not start"));
    }, 5000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`child relayer exited before ready: ${String(code)}`));
    });
    child.stdout.once("data", (chunk: Buffer) => {
      clearTimeout(timeout);
      const parsed = JSON.parse(chunk.toString("utf8")) as { port: number };
      resolve(`http://127.0.0.1:${String(parsed.port)}`);
    });
  });
  return { child, baseUrl };
}

async function stopChild(child: RelayerChild): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGTERM");
  });
}

describe("browser session handoff integration", () => {
  it("transfers ciphertext through the relay, keeps it readable, and preserves durable state across restart", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "art-computer-handoff-integration-"));
    tempDirs.push(dbPath);
    const first = await start(dbPath);
    const session = await createArtComputerHandoffSession({ relayerBaseUrl: first.baseUrl, origin: "https://example.com", ttlSeconds: 120 });
    await deviceEncryptAndSubmit(first.baseUrl, session.handoffPayload, new TextEncoder().encode("sensitive"));
    const decrypted = await session.pollUntilDelivered({ pollIntervalMs: 5, maxWaitMs: 1000 });
    expect(new TextDecoder().decode(decrypted.bytes)).toBe("sensitive");
    const decryptedAgain = await session.pollUntilDelivered({ pollIntervalMs: 5, maxWaitMs: 1000 });
    expect(new TextDecoder().decode(decryptedAgain.bytes)).toBe("sensitive");

    const durableSession = await createArtComputerHandoffSession({ relayerBaseUrl: first.baseUrl, origin: "https://example.com", ttlSeconds: 120 });
    await first.app.close();
    app = undefined;
    const child = await startChild(dbPath);
    const response = await fetch(new URL(`/v1/sessions/${durableSession.sid}/payload`, child.baseUrl), {
      headers: { authorization: `Bearer ${durableSession.controllerToken}` }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "waiting" });
    await stopChild(child.child);
  });
});
