# Mint Pairing API Design

This document describes the target API contract between the two broker clients:

- Browser library: the token requester library embedded in the NFT display
  website.
- Mint library: the Go ephemeral token minter library embedded in FF1
  `feral-controld`.

The highest goal is end-to-end encryption of all application data transmitted
between these two clients. The Mint Pairing Broker provides channel discovery,
durable message storage, ordering, polling, and expiry. It must not understand
mint requests, approval results, minted token payloads, or DP1 playlist content.

## Protocol Roles

The broker API has only two data-plane roles:

- `browser`: joins a channel from the QR/deep-link payload or short code shown
  on the FF1 frontend, sends an encrypted mint request, and receives an encrypted
  result.
- `minter`: creates the channel, provides the QR/deep-link or short-code payload
  to the FF1 frontend, receives encrypted browser messages, asks `ff-controller`
  for approval through `ff-relayer`, mints through `ff-relayer` if approved, and
  sends an encrypted result.

`ff-controller`, the FF1 frontend, and `ff-relayer` are integration points around
the two libraries, not additional broker API parties.

## Shared Crypto Contract

Both libraries generate ephemeral ECDH key pairs per channel. The initial
algorithm remains:

```text
P256-HKDF-SHA256-AES-256-GCM
```

The broker may store public keys and algorithm identifiers, but all message
payloads are encrypted by the sender and decrypted only by the recipient.

Each encrypted message should bind stable public fields as AAD:

```json
{
  "v": 1,
  "channelId": "ch_...",
  "messageId": "msg_...",
  "seq": 12,
  "sender": "browser",
  "recipient": "minter",
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM"
}
```

For messages encrypted before the broker has assigned a sequence number, clients
use `seq: 0` in the AAD and validate the broker-assigned `seq` from the stored
envelope separately. Browser-to-minter envelopes must also include the sender's
P-256 public JWK as public metadata so the minter can derive the ECDH shared
secret; this public key is not application plaintext.

The encrypted plaintext may contain message types such as:

- `mint_request`
- `mint_rejected`
- `mint_succeeded`
- `client_error`

The broker validates the envelope and size. It does not validate encrypted
message type or plaintext fields.

## Broker HTTP API

Endpoint names are target design names. The implementation can adjust exact
paths, but it should preserve the role split and encryption boundary.

### Create Channel

Used by the mint library.

```http
POST /v1/channels
Content-Type: application/json
```

Request:

```json
{
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "minterPublicKeyJwk": {},
  "idleTtlSeconds": 300,
  "shortCodeRequested": true
}
```

Response:

```json
{
  "channelId": "ch_...",
  "minterToken": "mt_...",
  "pairingToken": "pt_...",
  "shortCode": "123456",
  "expiresAt": "2026-06-16T10:00:00.000Z",
  "qrPayload": {
    "v": 1,
    "type": "ff-mint-pairing",
    "brokerBaseUrl": "https://pairing.example",
    "channelId": "ch_...",
    "pairingToken": "pt_...",
    "shortCode": "123456",
    "expiresAt": "2026-06-16T10:00:00.000Z",
    "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
    "minterPublicKeyJwk": {}
  }
}
```

`pairingToken`, `shortCode`, and `minterToken` are returned once. The server
stores only hashes.

### Join Channel

Used by the browser library.

```http
POST /v1/channels/{channelId}/join
Content-Type: application/json
```

Request with QR/deep-link payload:

```json
{
  "pairingToken": "pt_...",
  "browserPublicKeyJwk": {},
  "origin": "https://nft.example",
  "browserInfo": {
    "name": "Chrome",
    "userAgent": "Mozilla/5.0 ..."
  }
}
```

For manual entry, the implementation may provide a resolve endpoint:

```http
POST /v1/pairing-codes/resolve
```

with body:

```json
{
  "shortCode": "123456"
}
```

Resolution returns the `channelId` and public channel metadata, then the browser
still joins the channel. Short-code attempts must be rate limited with durable
state.

Join response:

```json
{
  "channelId": "ch_...",
  "browserToken": "bt_...",
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "minterPublicKeyJwk": {},
  "expiresAt": "2026-06-16T10:00:00.000Z",
  "nextSeq": 1
}
```

After a successful join, the pairing token is consumed and cannot join another
browser.

### Send Message

Used by both libraries. This is the only operation that extends channel TTL.

```http
POST /v1/channels/{channelId}/messages
Authorization: Bearer <browserToken | minterToken>
Content-Type: application/json
```

Request:

```json
{
  "messageId": "msg_...",
  "sender": "browser",
  "recipient": "minter",
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "senderPublicKeyJwk": {},
  "aad": "...",
  "nonce": "...",
  "ciphertext": "..."
}
```

Response:

```json
{
  "channelId": "ch_...",
  "seq": 12,
  "expiresAt": "2026-06-16T10:04:30.000Z"
}
```

The server assigns `seq` and persists the message in the same transaction that
updates `lastMessageAt` and `expiresAt`.

### Poll Messages

Used by both libraries.

```http
GET /v1/channels/{channelId}/messages?afterSeq=12
Authorization: Bearer <browserToken | minterToken>
```

Response:

```json
{
  "channelId": "ch_...",
  "expiresAt": "2026-06-16T10:04:30.000Z",
  "messages": [
    {
      "seq": 13,
      "messageId": "msg_...",
      "sender": "minter",
      "recipient": "browser",
      "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
      "senderPublicKeyJwk": {},
      "aad": "...",
      "nonce": "...",
      "ciphertext": "..."
    }
  ]
}
```

Polling does not extend TTL.

### Close Channel

Used by either library after success, rejection, cancellation, or local timeout.

```http
DELETE /v1/channels/{channelId}
Authorization: Bearer <browserToken | minterToken>
```

The server persists a closed or consumed state and removes usable pairing
indexes.

## Browser Library API

The browser library is embedded by the NFT display website. Public APIs should
hide broker polling and E2EE details unless the caller explicitly asks for low
level control.

Example TypeScript shape:

```ts
type PairingInput =
  | { qrPayload: unknown }
  | { brokerBaseUrl: string; shortCode: string };

type RequestEphemeralSessionOptions = {
  pairing: PairingInput;
  origin?: string;
  browserInfo?: {
    name?: string;
    userAgent?: string;
    label?: string;
  };
};

type EphemeralBrowserSession = {
  token: string;
  sessionId: string;
  expiresAt: string;
  relayerBaseUrl?: string;
};

async function requestEphemeralSession(
  options: RequestEphemeralSessionOptions
): Promise<EphemeralBrowserSession>;
```

Required behavior:

- Generate a per-channel browser ECDH key pair.
- Join the broker channel with the QR pairing token or short code.
- Encrypt the mint request before sending it.
- Poll only for encrypted messages addressed to `browser`.
- Decrypt and validate channel binding before returning the token.
- Store the token only in origin-scoped browser storage when storage is enabled.
- Never expose raw token values through logs, analytics, or thrown error text.

## Mint Library API

The mint library is a Go package embedded by FF1 `feral-controld`. It should make
the FF1 frontend display flow explicit while keeping token transport encrypted.

Example Go shape:

```go
type StartChannelOptions struct {
    BrokerBaseURL string
    IdleTTL       time.Duration
    TopicID       string
}

type PairingDisplay struct {
    ChannelID string
    QRPayload []byte
    ShortCode string
    ExpiresAt time.Time
}

type MintRequest struct {
    ChannelID   string
    Origin      string
    BrowserInfo BrowserInfo
}

type MintResult struct {
    SessionID string
    Token     string
    ExpiresAt time.Time
}
```

Expected library operations:

- Start a channel and return `PairingDisplay` to `feral-controld`.
- Let the FF1 frontend render the QR/deep-link payload or short code.
- Poll broker messages for encrypted browser requests.
- Decrypt and validate requester origin, public key, and channel binding.
- Ask `ff-controller` for approval through `ff-relayer`.
- On approval, call `ff-relayer` `POST /api/ephemeral-sessions?topicID=...`.
- Encrypt success or rejection back to the browser over the broker channel.
- Close the channel after terminal success or rejection.

## Error Model

Broker-visible errors should be generic:

- `invalid_request`
- `unauthorized`
- `not_found`
- `expired`
- `closed`
- `payload_too_large`
- `rate_limited`

Application-specific rejection reasons should be encrypted inside the minter to
browser message. The broker should not receive plaintext user approval decisions
except for coarse transport state such as a closed channel.

## Non-Goals

- The broker does not mint `ff-relayer` sessions.
- The broker does not call `ff-controller`.
- The broker does not parse DP1 feeds or playlist content.
- The browser library does not receive API keys or topic-management authority.
- The mint library does not send raw browser session tokens outside the E2EE
  broker response to the browser.
