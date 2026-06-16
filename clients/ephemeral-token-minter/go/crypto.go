package minter

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
)

const hkdfInfo = "ff-mint-pairing/v1/aes-gcm"

var rawBase64 = base64.RawURLEncoding

func generatePrivateKey() (*ecdh.PrivateKey, error) {
	return ecdh.P256().GenerateKey(rand.Reader)
}

func publicKeyToJWK(publicKey *ecdh.PublicKey) (PublicJWK, error) {
	if publicKey == nil {
		return PublicJWK{}, errors.New("public key is nil")
	}
	raw := publicKey.Bytes()
	if len(raw) != 65 || raw[0] != 4 {
		return PublicJWK{}, errors.New("unexpected P-256 public key encoding")
	}
	ext := true
	return PublicJWK{
		KeyType: "EC",
		Curve:   "P-256",
		X:       rawBase64.EncodeToString(raw[1:33]),
		Y:       rawBase64.EncodeToString(raw[33:65]),
		Ext:     &ext,
	}, nil
}

func jwkToPublicKey(jwk PublicJWK) (*ecdh.PublicKey, error) {
	if jwk.KeyType != "EC" || jwk.Curve != "P-256" {
		return nil, fmt.Errorf("unsupported public key: %s/%s", jwk.KeyType, jwk.Curve)
	}
	x, err := rawBase64.DecodeString(jwk.X)
	if err != nil {
		return nil, fmt.Errorf("decode JWK x: %w", err)
	}
	y, err := rawBase64.DecodeString(jwk.Y)
	if err != nil {
		return nil, fmt.Errorf("decode JWK y: %w", err)
	}
	if len(x) != 32 || len(y) != 32 {
		return nil, errors.New("P-256 JWK coordinates must be 32 bytes")
	}
	raw := make([]byte, 65)
	raw[0] = 4
	copy(raw[1:33], x)
	copy(raw[33:65], y)
	return ecdh.P256().NewPublicKey(raw)
}

func aadBytes(aad envelopeAAD) ([]byte, error) {
	if aad.Version == 0 {
		aad.Version = 1
	}
	if aad.Algorithm == "" {
		aad.Algorithm = Algorithm
	}
	return []byte("{" +
		jsonString("algorithm") + ":" + jsonString(aad.Algorithm) + "," +
		jsonString("channelId") + ":" + jsonString(aad.ChannelID) + "," +
		jsonString("messageId") + ":" + jsonString(aad.MessageID) + "," +
		jsonString("recipient") + ":" + jsonString(aad.Recipient) + "," +
		jsonString("sender") + ":" + jsonString(aad.Sender) + "," +
		jsonString("seq") + ":" + strconv.FormatInt(aad.Seq, 10) + "," +
		jsonString("v") + ":" + strconv.Itoa(aad.Version) +
		"}"), nil
}

func channelSaltBytes(channelID string) []byte {
	return []byte("{" +
		jsonString("algorithm") + ":" + jsonString(Algorithm) + "," +
		jsonString("channelId") + ":" + jsonString(channelID) + "," +
		jsonString("v") + ":1" +
		"}")
}

func jsonString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func deriveAESKey(privateKey *ecdh.PrivateKey, publicJWK PublicJWK, channelID string) ([]byte, error) {
	remotePublic, err := jwkToPublicKey(publicJWK)
	if err != nil {
		return nil, err
	}
	sharedSecret, err := privateKey.ECDH(remotePublic)
	if err != nil {
		return nil, fmt.Errorf("derive ECDH shared secret: %w", err)
	}
	salt := sha256.Sum256(channelSaltBytes(channelID))
	key, err := hkdf.Key(sha256.New, sharedSecret, salt[:], hkdfInfo, 32)
	if err != nil {
		return nil, fmt.Errorf("derive HKDF key: %w", err)
	}
	return key, nil
}

func encryptJSON(privateKey *ecdh.PrivateKey, remotePublicJWK PublicJWK, aad envelopeAAD, plaintext any) (encryptedMessage, error) {
	plaintextBytes, err := json.Marshal(plaintext)
	if err != nil {
		return encryptedMessage{}, err
	}
	return encryptBytes(privateKey, remotePublicJWK, aad, plaintextBytes)
}

func encryptBytes(privateKey *ecdh.PrivateKey, remotePublicJWK PublicJWK, aad envelopeAAD, plaintext []byte) (encryptedMessage, error) {
	aadRaw, err := aadBytes(aad)
	if err != nil {
		return encryptedMessage{}, err
	}
	key, err := deriveAESKey(privateKey, remotePublicJWK, aad.ChannelID)
	if err != nil {
		return encryptedMessage{}, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return encryptedMessage{}, err
	}
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return encryptedMessage{}, err
	}
	aead, err := cipher.NewGCMWithNonceSize(block, len(nonce))
	if err != nil {
		return encryptedMessage{}, err
	}
	ciphertext := aead.Seal(nil, nonce, plaintext, aadRaw)
	senderJWK, err := publicKeyToJWK(privateKey.PublicKey())
	if err != nil {
		return encryptedMessage{}, err
	}
	return encryptedMessage{
		MessageID:          aad.MessageID,
		Sender:             aad.Sender,
		Recipient:          aad.Recipient,
		Algorithm:          aad.Algorithm,
		AAD:                rawBase64.EncodeToString(aadRaw),
		Nonce:              rawBase64.EncodeToString(nonce),
		Ciphertext:         rawBase64.EncodeToString(ciphertext),
		SenderPublicKeyJWK: &senderJWK,
	}, nil
}

func decryptMessage(privateKey *ecdh.PrivateKey, message encryptedMessage, remotePublicJWK PublicJWK) ([]byte, envelopeAAD, error) {
	aadRaw, err := rawBase64.DecodeString(message.AAD)
	if err != nil {
		return nil, envelopeAAD{}, fmt.Errorf("decode AAD: %w", err)
	}
	var aad envelopeAAD
	if err := json.Unmarshal(aadRaw, &aad); err != nil {
		return nil, envelopeAAD{}, fmt.Errorf("decode AAD JSON: %w", err)
	}
	if err := validateAAD(aad, message); err != nil {
		return nil, envelopeAAD{}, err
	}
	key, err := deriveAESKey(privateKey, remotePublicJWK, aad.ChannelID)
	if err != nil {
		return nil, envelopeAAD{}, err
	}
	nonce, err := rawBase64.DecodeString(message.Nonce)
	if err != nil {
		return nil, envelopeAAD{}, fmt.Errorf("decode nonce: %w", err)
	}
	if len(nonce) != 12 {
		return nil, envelopeAAD{}, errors.New("AES-GCM nonce must be 12 bytes")
	}
	ciphertext, err := rawBase64.DecodeString(message.Ciphertext)
	if err != nil {
		return nil, envelopeAAD{}, fmt.Errorf("decode ciphertext: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, envelopeAAD{}, err
	}
	aead, err := cipher.NewGCMWithNonceSize(block, len(nonce))
	if err != nil {
		return nil, envelopeAAD{}, err
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, aadRaw)
	if err != nil {
		return nil, envelopeAAD{}, fmt.Errorf("decrypt message: %w", err)
	}
	return plaintext, aad, nil
}

func validateAAD(aad envelopeAAD, message encryptedMessage) error {
	if aad.Version != 1 {
		return fmt.Errorf("unsupported AAD version: %d", aad.Version)
	}
	if aad.ChannelID == "" || aad.MessageID == "" {
		return errors.New("AAD missing channel or message id")
	}
	if aad.MessageID != message.MessageID {
		return errors.New("AAD message id mismatch")
	}
	if aad.Sender != message.Sender || aad.Recipient != message.Recipient {
		return errors.New("AAD sender or recipient mismatch")
	}
	if aad.Algorithm != Algorithm || message.Algorithm != Algorithm {
		return errors.New("unsupported message algorithm")
	}
	if aad.Seq != 0 && message.Seq != 0 && aad.Seq != message.Seq {
		return errors.New("AAD sequence mismatch")
	}
	return nil
}

func chooseRemotePublicJWK(message encryptedMessage) (PublicJWK, error) {
	switch {
	case message.SenderPublicKeyJWK != nil:
		return *message.SenderPublicKeyJWK, nil
	case message.BrowserPublicKeyJWK != nil:
		return *message.BrowserPublicKeyJWK, nil
	default:
		return PublicJWK{}, errors.New("message missing sender public JWK")
	}
}
