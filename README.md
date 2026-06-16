# Feral File Browser Session Mint Pairing

This repository contains a secure mint-pairing prototype for giving a granted browser temporary, revokable access to request DP1 playlist display through `ff-relayer`.

The target design uses an NFT display website that embeds the browser token requester library, a Go ephemeral token minter embedded in FF1 `feral-controld`, the FF1 frontend for presenting the pairing QR/code, `ff-controller` as the user approval surface reached through `ff-relayer`, and the FF1 display path. The server in `server/` should now be treated as the **Mint Pairing Broker**: a short-lived opaque transport for QR/code-based pairing and end-to-end encrypted mint request/response messages. The sequential flow is documented in [docs/sequential-flow.md](docs/sequential-flow.md).

This is not production-ready. Treat it as a minimal prototype until product, infrastructure, and security review are complete.

## Components

- [server](server/README.md): Go Mint Pairing Broker backed by durable bbolt storage.
- [clients/session-recipient/js](clients/session-recipient/js/README.md): TypeScript token requester library embedded by NFT display websites.
- [clients/ephemeral-token-minter/go](clients/ephemeral-token-minter/go/README.md): Go library used by FF1 `feral-controld` to communicate with the broker, handle E2EE mint request/result payloads, and return encrypted mint results.
- [integration](integration/README.md): Vitest integration tests.
- `.github/workflows/ci.yml`: CI for server, NFT display website requester library, token minter, and integration tests after the implementation is updated.
- `Dockerfile`: Production image for the Mint Pairing Broker.

## Design Docs

- [Sequential flow](docs/sequential-flow.md)
- [Server design](docs/server-design.md)
- [API design](docs/api-design.md)

Implementation status: the Go broker, Go ephemeral token minter library, browser requester library, Docker image, and Docker-backed integration test have replaced the earlier handoff prototype surfaces.

## Commands

```sh
cd server && test -z "$(gofmt -l .)" && go vet ./... && go test ./... && go build ./...
cd clients/session-recipient/js && npm ci && npm run lint && npm run typecheck && npm test
cd clients/ephemeral-token-minter/go && test -z "$(gofmt -l .)" && go vet ./... && go test ./...
cd integration && npm ci && npm run sample:build && npm run lint && npm run typecheck && npm test
```

## Deployment

The Docker image runs the Mint Pairing Broker. It listens on `ADDR`, defaults to `:8080`, and stores bbolt state at `BROKER_DB_PATH`, expected to be a file path such as `/data/mint-pairing.db`. Mount `/data` as durable storage in persistent environments.

```sh
docker build -t ff-mint-pairing-broker:local .
docker run --rm -p 8080:8080 -v ff-mint-pairing-broker-data:/data ff-mint-pairing-broker:local
```

The manual GitHub Actions workflow `.github/workflows/build-image.yml` publishes to DigitalOcean Container Registry under `registry.digitalocean.com/feral-file/apps`. It requires the `DIGITALOCEAN_DOCR_TOKEN` secret in the production environment.

## License

This repository's source code is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The license does not grant rights to Feral File trademarks, service marks, product names, artwork, production credentials, hosted services, or DP1 playlist content.
