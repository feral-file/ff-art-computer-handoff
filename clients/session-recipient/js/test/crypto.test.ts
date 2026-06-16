import { describe, expect, it } from "vitest";
import {
  decryptChannelMessage,
  encryptChannelMessage,
  exportPublicJwk,
  generateBrowserKeyPair,
  getCrypto,
  messageAad,
  messageAadBase64Url
} from "../src/crypto.js";

describe("Mint Pairing channel crypto", () => {
  it("uses a non-extractable browser private key", async () => {
    const keyPair = await generateBrowserKeyPair();
    expect(keyPair.privateKey.extractable).toBe(false);
    await expect(getCrypto().subtle.exportKey("jwk", keyPair.privateKey)).rejects.toThrow();
  });

  it("encrypts and decrypts channel-bound messages", async () => {
    const browserKeyPair = await generateBrowserKeyPair();
    const minterKeyPair = await generateBrowserKeyPair();
    const browserPublicKeyJwk = await exportPublicJwk(browserKeyPair.publicKey);
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    const encrypted = await encryptChannelMessage({
      privateKey: browserKeyPair.privateKey,
      peerPublicJwk: minterPublicKeyJwk,
      channelId: "ch_123",
      messageId: "msg_request",
      seq: 0,
      sender: "browser",
      recipient: "minter",
      plaintext: {
        v: 1,
        type: "mint_request",
        channelId: "ch_123",
        origin: "https://nft.example"
      }
    });
    expect(encrypted.aad).toBe(messageAadBase64Url(messageAad({
      channelId: "ch_123",
      messageId: "msg_request",
      seq: 0,
      sender: "browser",
      recipient: "minter"
    })));
    const decrypted = await decryptChannelMessage({
      privateKey: minterKeyPair.privateKey,
      peerPublicJwk: browserPublicKeyJwk,
      channelId: "ch_123",
      messageId: "msg_request",
      seq: 0,
      sender: "browser",
      recipient: "minter",
      algorithm: encrypted.algorithm,
      aad: encrypted.aad,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext
    });
    expect(decrypted).toEqual({
      v: 1,
      type: "mint_request",
      channelId: "ch_123",
      origin: "https://nft.example"
    });
  });

  it("rejects mismatched channel binding", async () => {
    const browserKeyPair = await generateBrowserKeyPair();
    const minterKeyPair = await generateBrowserKeyPair();
    const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
    const encrypted = await encryptChannelMessage({
      privateKey: browserKeyPair.privateKey,
      peerPublicJwk: minterPublicKeyJwk,
      channelId: "ch_123",
      messageId: "msg_result",
      seq: 2,
      sender: "minter",
      recipient: "browser",
      plaintext: { v: 1, type: "mint_succeeded", channelId: "ch_123" }
    });
    await expect(decryptChannelMessage({
      privateKey: browserKeyPair.privateKey,
      peerPublicJwk: minterPublicKeyJwk,
      channelId: "ch_wrong",
      messageId: "msg_result",
      seq: 2,
      sender: "minter",
      recipient: "browser",
      algorithm: encrypted.algorithm,
      aad: encrypted.aad,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext
    })).rejects.toThrow("channel binding mismatch");
  });
});
