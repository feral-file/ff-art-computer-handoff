# Mint Pairing Broker

`server/` contains the Node.js/Fastify service used as the Mint Pairing Broker between NFT display websites and token minters.

Its role is to hold short-lived mint receivers, QR/deep-link or short-code pairing material, and opaque end-to-end encrypted messages between the NFT display website and the Go ephemeral token minter embedded in FF1 `feral-controld`. The broker does not inspect mint requests, approval results, or token payloads. It is not `ff-relayer`, and it should not become a playlist relay. See [Sequential Flow](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/docs/sequential-flow.md) for the full party model.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

## Storage

State is backed by LMDB. Server state transitions must read from and write to durable storage; do not add in-memory session, token, expiry, or payload maps.

Pairing receiver records live only for a short mint window and are cleaned from usable state by the expiry path. In Docker deployments, LMDB is stored under `/data/lmdb`, so mount `/data` as a persistent volume.

## Boundaries

- Do not log ephemeral browser session tokens.
- Do not store or relay DP1 playlist content.
- Treat submitted mint request and token response payloads as opaque encrypted content and enforce the 64 KiB encrypted payload limit.
- Keep this service focused on temporary mint pairing between requester clients and token minters.
- Do not add Redis, Postgres, WebSockets, SSE, or external queues without approval.
