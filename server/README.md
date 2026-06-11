# Handoff Server

`server/` contains the Node.js/Fastify service used as the handoff bridge between `ff-controller` and the browser library.

Its role is to carry an opaque end-to-end encrypted handoff payload from the mobile app to the browser. The payload normally contains an ephemeral browser session, but the server does not inspect that content. It is not `ff-relayer`, and it should not become a playlist relay. See [Sequential Flow](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/docs/sequential-flow.md) for the full party model.

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

Handoff records live for at most 5 minutes and are cleaned from usable state by the expiry path. In Docker deployments, LMDB is stored under `/data/lmdb`, so mount `/data` as a persistent volume.

## Boundaries

- Do not log ephemeral browser session tokens.
- Do not store or relay DP1 playlist content.
- Treat submitted payloads as opaque encrypted content and enforce the 64 KiB encrypted payload limit.
- Keep this service focused on session handoff between `ff-controller` and session-recipient clients.
- Do not add Redis, Postgres, WebSockets, SSE, or external queues without approval.
