package minter

import (
	"encoding/json"
	"time"
)

const (
	// Algorithm is the current pairing cipher suite shared by browser requesters
	// and Go token minters.
	Algorithm = "P256-HKDF-SHA256-AES-256-GCM"

	messageTypeMintRequest   = "mint_request"
	messageTypeMintSucceeded = "mint_succeeded"
	messageTypeMintRejected  = "mint_rejected"
)

// PublicJWK is a JSON/JWK-compatible P-256 public key.
type PublicJWK struct {
	KeyType string `json:"kty"`
	Curve   string `json:"crv"`
	X       string `json:"x"`
	Y       string `json:"y"`
	Ext     *bool  `json:"ext,omitempty"`
}

// StartChannelOptions configures a new temporary broker channel.
type StartChannelOptions struct {
	BrokerBaseURL      string
	IdleTTL            time.Duration
	ShortCodeRequested bool
	TopicID            string // Host-owned relayer topic context; not sent to the broker.
}

// PairingDisplay is safe to pass to the FF1 frontend for QR/deep-link or
// short-code display.
type PairingDisplay struct {
	ChannelID string
	QRPayload []byte
	ShortCode string
	ExpiresAt time.Time
}

// BrowserInfo is requester metadata sent inside the encrypted mint request.
type BrowserInfo struct {
	Name      string `json:"name,omitempty"`
	UserAgent string `json:"userAgent,omitempty"`
	Label     string `json:"label,omitempty"`
}

// MintRequest is the decrypted browser request host code can submit to its
// approval integration.
type MintRequest struct {
	ChannelID                 string
	MessageID                 string
	Seq                       int64
	Origin                    string
	BrowserInfo               BrowserInfo
	BrowserPublicKeyJWK       PublicJWK
	RequestedExpiresInSeconds int `json:"requestedExpiresInSeconds,omitempty"`
}

// MintResult is the relayer-created browser session returned to the browser
// only inside an encrypted broker message.
type MintResult struct {
	SessionID      string    `json:"sessionId"`
	Token          string    `json:"token"`
	ExpiresAt      time.Time `json:"expiresAt"`
	RelayerBaseURL string    `json:"relayerBaseUrl,omitempty"`
}

// MintRejection is an encrypted application-level rejection result.
type MintRejection struct {
	Reason    string `json:"reason,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
}

// SendMessageResult describes the broker-assigned message sequence.
type SendMessageResult struct {
	ChannelID string
	Seq       int64
	ExpiresAt time.Time
}

type encryptedMessage struct {
	Seq                 int64      `json:"seq,omitempty"`
	MessageID           string     `json:"messageId"`
	Sender              string     `json:"sender"`
	Recipient           string     `json:"recipient"`
	Algorithm           string     `json:"algorithm"`
	AAD                 string     `json:"aad"`
	Nonce               string     `json:"nonce"`
	Ciphertext          string     `json:"ciphertext"`
	SenderPublicKeyJWK  *PublicJWK `json:"senderPublicKeyJwk,omitempty"`
	BrowserPublicKeyJWK *PublicJWK `json:"browserPublicKeyJwk,omitempty"`
}

type envelopeAAD struct {
	Version   int    `json:"v"`
	ChannelID string `json:"channelId"`
	MessageID string `json:"messageId"`
	Seq       int64  `json:"seq"`
	Sender    string `json:"sender"`
	Recipient string `json:"recipient"`
	Algorithm string `json:"algorithm"`
}

type mintRequestPlaintext struct {
	Version                   int         `json:"v"`
	Type                      string      `json:"type"`
	ChannelID                 string      `json:"channelId"`
	RequestMessageID          string      `json:"requestMessageId"`
	Origin                    string      `json:"origin"`
	BrowserInfo               BrowserInfo `json:"browserInfo,omitempty"`
	BrowserPublicKeyJWK       PublicJWK   `json:"browserPublicKeyJwk"`
	RequestedExpiresInSeconds int         `json:"requestedExpiresInSeconds,omitempty"`
}

type mintSuccessPlaintext struct {
	Version          int                  `json:"v"`
	Type             string               `json:"type"`
	ChannelID        string               `json:"channelId"`
	RequestMessageID string               `json:"requestMessageId,omitempty"`
	Session          mintSessionPlaintext `json:"session"`
}

type mintSessionPlaintext struct {
	SessionID      string    `json:"sessionId"`
	Token          string    `json:"token"`
	ExpiresAt      time.Time `json:"expiresAt"`
	RelayerBaseURL string    `json:"relayerBaseUrl,omitempty"`
}

type mintRejectionPlaintext struct {
	Version          int    `json:"v"`
	Type             string `json:"type"`
	ChannelID        string `json:"channelId"`
	RequestMessageID string `json:"requestMessageId,omitempty"`
	Reason           string `json:"reason,omitempty"`
	Retryable        bool   `json:"retryable,omitempty"`
}

type createChannelRequest struct {
	Algorithm          string    `json:"algorithm"`
	MinterPublicKeyJWK PublicJWK `json:"minterPublicKeyJwk"`
	IdleTTLSeconds     int64     `json:"idleTtlSeconds,omitempty"`
	ShortCodeRequested bool      `json:"shortCodeRequested"`
}

type createChannelResponse struct {
	ChannelID    string          `json:"channelId"`
	MinterToken  string          `json:"minterToken"`
	PairingToken string          `json:"pairingToken"`
	ShortCode    string          `json:"shortCode"`
	ExpiresAt    time.Time       `json:"expiresAt"`
	QRPayload    json.RawMessage `json:"qrPayload"`
}

type pollMessagesResponse struct {
	ChannelID string             `json:"channelId"`
	ExpiresAt time.Time          `json:"expiresAt"`
	Messages  []encryptedMessage `json:"messages"`
}

type sendMessageResponse struct {
	ChannelID string    `json:"channelId"`
	Seq       int64     `json:"seq"`
	ExpiresAt time.Time `json:"expiresAt"`
}
