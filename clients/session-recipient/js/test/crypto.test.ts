import { describe, expect, it } from "vitest";
import { aadBase64Url, base64UrlEncode, decryptDeliveredPayload, generatePublisherKeyPair, getCrypto } from "../src/crypto.js";
import { buildHandoffPayload, validateHandoffPayload } from "../src/handoffPayload.js";

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deviceEncrypt(publisherPublicKeyJwk: JsonWebKey, handoffPayload: Awaited<ReturnType<typeof buildHandoffPayload>>, plaintext: Uint8Array) {
  const crypto = getCrypto();
  const deviceKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publisherPublicKey = await crypto.subtle.importKey("jwk", publisherPublicKeyJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: publisherPublicKey }, deviceKeyPair.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({
    alg: handoffPayload.alg,
    code: handoffPayload.code,
    exp: handoffPayload.exp,
    origin: handoffPayload.origin,
    sid: handoffPayload.sid,
    v: handoffPayload.v
  }).replaceAll(",", ",")));
  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("ff-art-computer-handoff/v1/aes-gcm") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(JSON.stringify({
    alg: handoffPayload.alg,
    code: handoffPayload.code,
    exp: handoffPayload.exp,
    origin: handoffPayload.origin,
    sid: handoffPayload.sid,
    v: handoffPayload.v
  }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad), tagLength: 128 }, aesKey, asArrayBuffer(plaintext)));
  return {
    devicePublicKeyJwk: await crypto.subtle.exportKey("jwk", deviceKeyPair.publicKey),
    nonce: base64UrlEncode(nonce),
    aad: base64UrlEncode(aad),
    ciphertext: base64UrlEncode(ciphertext)
  };
}

describe("JS handoff crypto", () => {
  it("uses a non-extractable private key", async () => {
    const keyPair = await generatePublisherKeyPair();
    expect(keyPair.privateKey.extractable).toBe(false);
    await expect(getCrypto().subtle.exportKey("jwk", keyPair.privateKey)).rejects.toThrow();
  });

  it("decrypts deviceKeyPair ECDH/HKDF/AES-GCM ciphertext", async () => {
    const keyPair = await generatePublisherKeyPair();
    const bpub = await getCrypto().subtle.exportKey("jwk", keyPair.publicKey);
    const handoffPayload = await buildHandoffPayload({ v: 1, origin: "https://example.com", sid: "sid", exp: new Date(Date.now() + 60_000).toISOString(), alg: "P256-HKDF-SHA256-AES-256-GCM", bpub });
    expect(await validateHandoffPayload(handoffPayload)).toBe(true);
    const encrypted = await deviceEncrypt(bpub, handoffPayload, new TextEncoder().encode("secret"));
    expect(encrypted.aad).toBe(aadBase64Url(handoffPayload));
    const decrypted = await decryptDeliveredPayload({ privateKey: keyPair.privateKey, handoffPayload, ...encrypted });
    expect(new TextDecoder().decode(decrypted)).toBe("secret");
  });
});
