# Feral File Browser Session Mint Pairing

This repository contains a secure mint-pairing prototype for giving a granted browser temporary, revokable access to request DP1 playlist display through `ff-relayer`.

The target design uses an NFT display website that embeds the browser token requester library, a Go ephemeral token minter embedded in FF1 `feral-controld`, the FF1 frontend for presenting the pairing QR/code, `ff-controller` as the user approval surface reached through `ff-relayer`, and the FF1 display path. The server in `server/` should now be treated as the **Mint Pairing Broker**: a short-lived opaque transport for QR/code-based pairing and end-to-end encrypted mint request/response messages. The sequential flow is documented in [docs/sequential-flow.md](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/docs/sequential-flow.md).

This is not production-ready. Treat it as a minimal prototype until product, infrastructure, and security review are complete.

## Components

- [server](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/server/README.md): Node.js/Fastify Mint Pairing Broker backed by LMDB.
- [clients/session-recipient/js](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/clients/session-recipient/js/README.md): TypeScript token requester library embedded by NFT display websites.
- `clients/ephemeral-token-minter/go` (planned): Go library used by FF1 `feral-controld` to create mint receivers, coordinate approval through `ff-relayer`, and mint browser sessions.
- [integration](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/integration/README.md): Vitest integration tests.
- `.github/workflows/ci.yml`: CI for server, NFT display website requester library, token minter, and integration tests after the implementation is updated.
- `Dockerfile`: Production image for the Mint Pairing Broker.

Implementation status: the code still contains the earlier Flutter controller library and earlier handoff-shaped browser APIs. Those are legacy for the new design and should be removed or replaced in a follow-up code change; this update only changes documentation.

## Commands

```sh
cd server && npm ci && npm run lint && npm run typecheck && npm test
cd clients/session-recipient/js && npm ci && npm run lint && npm run typecheck && npm test
# Planned after Go minter is added:
# cd clients/ephemeral-token-minter/go && go test ./...
cd integration && npm ci && npm run lint && npm run typecheck && npm test
```

## Deployment

The Docker image runs the Mint Pairing Broker. It listens on `PORT`, defaults to `3000`, and stores LMDB state at `DB_PATH`, defaults to `/data/lmdb`. Mount `/data` as durable storage in persistent environments.

```sh
docker build -t ff-mint-pairing-broker:local .
docker run --rm -p 3000:3000 -v ff-mint-pairing-broker-data:/data ff-mint-pairing-broker:local
```

The manual GitHub Actions workflow `.github/workflows/build-image.yml` publishes to DigitalOcean Container Registry under `registry.digitalocean.com/feral-file/apps`. It requires the `DIGITALOCEAN_DOCR_TOKEN` secret in the production environment.

## License

This repository's source code is licensed under the Apache License, Version 2.0. See [LICENSE](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/LICENSE) and [NOTICE](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/NOTICE).

The license does not grant rights to Feral File trademarks, service marks, product names, artwork, production credentials, hosted services, or DP1 playlist content.
