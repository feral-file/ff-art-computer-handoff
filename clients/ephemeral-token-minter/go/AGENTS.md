# AGENTS.md

## Component

`clients/ephemeral-token-minter/go/` is the Go ephemeral token minter library embedded by FF1 `feral-controld`.

It creates temporary channels through the Mint Pairing Broker, exposes QR/deep-link and short-code pairing material for the FF1 frontend, decrypts browser mint requests, and sends encrypted success or rejection results back through the broker.

## Commands

```sh
gofmt -w .
go test ./...
```

## Rules

- Keep Go code idiomatic, formatted with `gofmt`, and covered by `go test ./...`.
- Use P-256 ECDH, HKDF-SHA256, and AES-256-GCM through maintained standard-library crypto packages.
- Do not implement `ff-controller` approval UI or `ff-relayer` session business logic here; expose interfaces for host code to inject those integrations.
- Do not log ephemeral browser session tokens, DP1 playlist content, or decrypted mint payloads.
- Send raw browser session tokens only inside the end-to-end encrypted broker response.
- Treat broker messages as opaque transport envelopes; broker-visible errors and HTTP errors must not include token material.
