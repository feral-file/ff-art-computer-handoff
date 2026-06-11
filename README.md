# Feral File Browser Session Handoff

This repository contains a secure handoff prototype for giving a granted client temporary, revokable access to request DP1 playlist display through `ff-relayer`.

The three parties are `ff-controller` mobile app, a session-recipient client, and `ff-relayer`. The current session-recipient implementation is a browser library that starts a QR-based handoff only when origin-scoped `localStorage` has no usable ephemeral browser session. The handoff server in `server/` is the opaque end-to-end encrypted transport component between `ff-controller` and the granted client. The sequential flow is documented in [docs/sequential-flow.md](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/docs/sequential-flow.md).

This is not production-ready. Treat it as a minimal prototype until product, infrastructure, and security review are complete.

## Components

- [server](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/server/README.md): Node.js/Fastify handoff server backed by LMDB.
- [clients/session-recipient/js](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/clients/session-recipient/js/README.md): TypeScript session-recipient implementation for browser runtimes.
- [clients/ff-controller/flutter](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/clients/ff-controller/flutter/README.md): Flutter/Dart `ff-controller` client implementation.
- [integration](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/integration/README.md): Vitest integration tests.
- `.github/workflows/ci.yml`: CI for server, session-recipient client, controller client, and integration tests.
- `Dockerfile`: Production image for the handoff server.

The client directories are organized by role first and language second. Additional `ff-controller` or session-recipient implementations can be added later under the same component boundaries, for example `clients/ff-controller/swift` or `clients/session-recipient/kotlin`.

## Commands

```sh
cd server && npm ci && npm run lint && npm run typecheck && npm test
cd clients/session-recipient/js && npm ci && npm run lint && npm run typecheck && npm test
cd clients/ff-controller/flutter && flutter pub get && dart format --set-exit-if-changed . && flutter analyze && flutter test
cd integration && npm ci && npm run lint && npm run typecheck && npm test
```

## Deployment

The Docker image runs the handoff server. It listens on `PORT`, defaults to `3000`, and stores LMDB state at `DB_PATH`, defaults to `/data/lmdb`. Mount `/data` as durable storage in persistent environments.

```sh
docker build -t ff-browser-session-handoff:local .
docker run --rm -p 3000:3000 -v ff-browser-session-handoff-data:/data ff-browser-session-handoff:local
```

The manual GitHub Actions workflow `.github/workflows/build-image.yml` publishes to DigitalOcean Container Registry under `registry.digitalocean.com/feral-file/apps`. It requires the `DIGITALOCEAN_DOCR_TOKEN` secret in the production environment.
