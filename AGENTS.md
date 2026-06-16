# AGENTS.md

## Project Purpose

This repository is a minimal secure prototype for ephemeral browser session mint pairing.

The target parties are an NFT display website embedding the token requester browser library, FF1 `feral-controld` using a Go ephemeral token minter library, the FF1 frontend that displays the pairing QR/code, `ff-controller` as an approval UI reached through `ff-relayer`, `ff-relayer`, and the FF1 display path. The token minter creates a temporary mint receiver through the server in `server/`, establishes end-to-end encrypted communication with the NFT display website, asks `ff-controller` to approve or reject the requester metadata through `ff-relayer`, mints an ephemeral browser session through `ff-relayer` on approval, and transfers the token back to the NFT display website through the encrypted broker path. The current token requester implementation is a browser library that stores the recovered token in `localStorage` under the current website origin and uses it to request DP1 playlist display through `ff-relayer`. DP1 playlist content must not travel through `ff-controller`, the token minter, or the server.

The server in `server/` is now referred to in design docs as the Mint Pairing Broker rather than the handoff server. It remains a short-lived opaque E2EE transport backed by durable LMDB state.

The sequential flow lives in `docs/sequential-flow.md`. Component-specific rules live in each component's `AGENTS.md`.

## Directory Structure

- `docs/`: shared architecture and flow documentation.
- `server/`: Node.js, Fastify, TypeScript, LMDB-backed Mint Pairing Broker.
- `clients/session-recipient/js/`: TypeScript token requester library embedded by NFT display websites.
- `clients/ephemeral-token-minter/go/`: planned Go ephemeral token minter library used by FF1 `feral-controld`.
- `clients/ff-controller/flutter/`: legacy Flutter/Dart implementation from the old flow; remove or replace in the code migration.
- `integration/`: Vitest integration tests.
- `.github/workflows/ci.yml`: CI jobs for server, NFT display website requester library, token minter, and integration tests after the code migration.
- `.github/workflows/build-image.yml`: Manual production image build/push workflow for Feral File DOCR.

## Commands

Server:

```sh
cd server
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

NFT display website requester library:

```sh
cd clients/session-recipient/js
npm ci
npm run lint
npm run typecheck
npm test
```

Integration:

```sh
cd integration
npm ci
npm run lint
npm run typecheck
npm test
```

## Security Invariants

1. DP1 playlist content does not travel through `ff-controller`.
2. Ephemeral browser session tokens are bearer credentials and must not be logged.
3. Browser token storage is scoped to the current website origin.
4. `ff-relayer` enforces session expiry and revocation.
5. Browser sessions authorize only the intended display/cast path.
6. Browser sessions do not grant API-key access or session-management access.
7. Raw tokens are never stored where a hash or opaque handle is sufficient.
8. Durable server state must not be replaced with process-local maps.
9. Payloads and request bodies keep strict size limits.
10. Tests must not hardcode production credentials.
11. `ff-controller` approves or rejects mint requests but does not receive raw browser session tokens.

## Coding Rules

- Do not introduce in-memory maps for sessions, payloads, token state, expiry state, or test shortcuts.
- Every server state transition must read from and write to LMDB.
- Keep TypeScript strict mode, `noUncheckedIndexedAccess`, and type-aware ESLint rules enabled.
- Keep Go code idiomatic, formatted with `gofmt`, and covered by `go test ./...` once the minter exists.
- Prefer small, explicit protocol structures over loosely typed JSON.
- Do not add website-specific concepts to public APIs.

## Dependency Rules

- Server storage must remain a local durable embedded KV store, currently LMDB.
- Do not add Redis, Postgres, WebSockets, SSE, or external queue dependencies without human approval.
- Go crypto must use maintained standard-library or reviewed crypto packages. Do not implement elliptic-curve math manually.

## Product Scope Rules

- Optimize names and APIs for NFT display websites, the requester library they embed, the ephemeral token minter, `ff-controller`, the Mint Pairing Broker, and `ff-relayer`.
- Keep requester clients general for browsers and future third-party clients granted through the token minter.
- Keep `ff-controller` as an approval surface; do not make it the browser-session token minter in the new flow.
- Do not implement flow changes unless explicitly requested.

## Do Not Change Without Human Approval

- Durable storage requirement.
- Payload size limits.
- Token hashing behavior.
- Deployment assumptions for Feral File infrastructure.
- The responsibility boundary that keeps DP1 playlist content out of `ff-controller`.

## Review Checklist

Server:

- LMDB is the source of truth.
- No in-memory session or payload state.
- Token hashes are stored where tokens must be persisted.
- Expiry, revoke, duplicate claim, and oversized payload paths are covered when implemented.
- API validation rejects malformed input.
- Server logs do not expose tokens or playlist content.

NFT display website requester library:

- Token storage is origin-scoped.
- Public API does not expose raw tokens unnecessarily.
- Display requests use ephemeral browser session auth only for the intended `ff-relayer` path.
- Errors and logs do not leak tokens or playlist content.

`ff-controller` approval UI and legacy controller client:

- Treat the Flutter controller library as legacy until it is removed.
- `ff-controller` approves or rejects mint requests through `ff-relayer` communication.
- Does not receive or proxy DP1 playlist content.
- Does not receive raw browser session tokens.
- Errors and logs do not leak tokens.

Ephemeral token minter:

- Starts temporary mint receivers through the Mint Pairing Broker.
- Provides QR/deep-link and short-code pairing material for the FF1 frontend to display.
- Receives requester origin and browser/client metadata through E2EE.
- Asks `ff-controller` for user approval through `ff-relayer` before minting.
- Calls `ff-relayer` `POST /api/ephemeral-sessions?topicID=...` only after approval.
- Sends minted token information back only through the E2EE broker path.

Integration/CI:

- Integration tests cover the full mint pairing sequence as implementation support lands.
- Tests use isolated temporary storage.
- CI runs lint, typecheck/analyze, and tests for all components.
- CI does not require a git repository to exist locally before first commit.

## Definition of Done

- Required files exist in the expected directories.
- Server, NFT display website requester library, token minter, and integration tests are present.
- Lint/type/analyzer configurations are strict.
- CI workflow is ready for GitHub Actions.
- Docker image build succeeds before deployment broker work is considered ready.
- Security invariants remain documented and enforced by code or tests where practical.
- Reviewer findings are fixed or documented as known limitations.

## Commit Message Format

Use Conventional Commits:

- `<type>(<optional-scope>): <description>`
- Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `build`, `ci`, `perf`, `style`
