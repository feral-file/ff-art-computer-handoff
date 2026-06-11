import { canonicalJson, type JsonValue } from "./canonicalJson.js";
import { aadFields, type HandoffPayload } from "./handoffPayload.js";

const textEncoder = new TextEncoder();

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function getCrypto(): Crypto {
  return globalThis.crypto;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await getCrypto().subtle.digest("SHA-256", textEncoder.encode(value)));
}

export async function generatePublisherKeyPair(): Promise<CryptoKeyPair> {
  return getCrypto().subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

export async function exportPublicJwk(key: CryptoKey): Promise<JsonWebKey> {
  return getCrypto().subtle.exportKey("jwk", key);
}

export async function importPeerPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return getCrypto().subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

export function aadBytes(payload: HandoffPayload): Uint8Array {
  return textEncoder.encode(canonicalJson(aadFields(payload)));
}

export function hkdfSalt(payload: HandoffPayload): Promise<Uint8Array> {
  return sha256(canonicalJson(aadFields(payload)));
}

export async function deriveAesKey(privateKey: CryptoKey, peerPublicJwk: JsonWebKey, payload: HandoffPayload): Promise<CryptoKey> {
  const peerPublicKey = await importPeerPublicKey(peerPublicJwk);
  const sharedBits = await getCrypto().subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256);
  const hkdfKey = await getCrypto().subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return getCrypto().subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(await hkdfSalt(payload)), info: textEncoder.encode("ff-art-computer-handoff/v1/aes-gcm") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

export async function decryptDeliveredPayload(input: {
  privateKey: CryptoKey;
  handoffPayload: HandoffPayload;
  devicePublicKeyJwk: JsonWebKey;
  nonce: string;
  aad: string;
  ciphertext: string;
}): Promise<Uint8Array> {
  const expectedAad = aadBytes(input.handoffPayload);
  const receivedAad = base64UrlDecode(input.aad);
  const nonce = base64UrlDecode(input.nonce);
  if (nonce.byteLength !== 12) {
    throw new Error("AES-GCM nonce must be 12 bytes");
  }
  if (base64UrlEncode(expectedAad) !== base64UrlEncode(receivedAad)) {
    throw new Error("AAD does not match handoff session binding");
  }
  const key = await deriveAesKey(input.privateKey, input.devicePublicKeyJwk, input.handoffPayload);
  const plaintext = await getCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(receivedAad), tagLength: 128 },
    key,
    asArrayBuffer(base64UrlDecode(input.ciphertext))
  );
  return new Uint8Array(plaintext);
}

export function aadBase64Url(payload: HandoffPayload): string {
  return base64UrlEncode(aadBytes(payload));
}

export function jsonBytes(value: JsonValue): Uint8Array {
  return textEncoder.encode(canonicalJson(value));
}
