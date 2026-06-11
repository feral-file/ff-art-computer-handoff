# AGENTS.md

## Project Purpose

This repository is a minimal secure prototype for ephemeral browser session handoff.

The three parties are `ff-controller`, a session-recipient client, and `ff-relayer`. `ff-controller` is the mobile app. It creates or obtains an ephemeral browser session for a relay topic and sends that session to the granted client through the handoff server in `server/`. The current session-recipient implementation is a browser library that receives the ephemeral session token, stores it in `localStorage` under the current website origin, and uses it to request DP1 playlist display through `ff-relayer`. DP1 playlist content must not travel through `ff-controller`.

The sequential flow lives in `docs/sequential-flow.md`. Component-specific rules live in each component's `AGENTS.md`.

## Directory Structure

- `docs/`: shared architecture and flow documentation.
- `server/`: Node.js, Fastify, TypeScript, LMDB-backed handoff server.
- `clients/session-recipient/js/`: TypeScript session-recipient implementation for browser runtimes.
- `clients/ff-controller/flutter/`: Flutter/Dart `ff-controller` client implementation.
- `integration/`: Vitest integration tests.
- `.github/workflows/ci.yml`: CI jobs for server, session-recipient client, controller client, and integration tests.
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

Session-recipient client:

```sh
cd clients/session-recipient/js
npm ci
npm run lint
npm run typecheck
npm test
```

Controller client:

```sh
cd clients/ff-controller/flutter
flutter pub get
dart format --set-exit-if-changed .
flutter analyze
flutter test
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

## Coding Rules

- Do not introduce in-memory maps for sessions, payloads, token state, expiry state, or test shortcuts.
- Every server state transition must read from and write to LMDB.
- Keep TypeScript strict mode, `noUncheckedIndexedAccess`, and type-aware ESLint rules enabled.
- Keep Dart strict analyzer rules enabled.
- Prefer small, explicit protocol structures over loosely typed JSON.
- Do not add website-specific concepts to public APIs.

## Dependency Rules

- Server storage must remain a local durable embedded KV store, currently LMDB.
- Do not add Redis, Postgres, WebSockets, SSE, or external queue dependencies without human approval.
- Flutter crypto must use maintained crypto packages. Do not implement elliptic-curve math manually.

## Product Scope Rules

- Optimize names and APIs for `ff-controller`, session-recipient clients, the handoff server, and `ff-relayer`.
- Keep session-recipient clients general for browsers and future third-party clients granted by `ff-controller`.
- Keep controller-client implementations general enough to support multiple mobile-platform implementations over time.
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

Session-recipient client:

- Token storage is origin-scoped.
- Public API does not expose raw tokens unnecessarily.
- Display requests use ephemeral browser session auth only for the intended `ff-relayer` path.
- Errors and logs do not leak tokens or playlist content.

Controller client:

- Creates or obtains browser sessions with user authority.
- Sends session handoff to the browser through the handoff server.
- Does not receive or proxy DP1 playlist content.
- Errors and logs do not leak tokens.

Integration/CI:

- Integration tests cover the full session handoff sequence as implementation support lands.
- Tests use isolated temporary storage.
- CI runs lint, typecheck/analyze, and tests for all components.
- CI does not require a git repository to exist locally before first commit.

## Definition of Done

- Required files exist in the expected directories.
- Server, session-recipient client, controller client, and integration tests are present.
- Lint/type/analyzer configurations are strict.
- CI workflow is ready for GitHub Actions.
- Docker image build succeeds before deployment handoff work is considered ready.
- Security invariants remain documented and enforced by code or tests where practical.
- Reviewer findings are fixed or documented as known limitations.

## Commit Message Format

Use Conventional Commits:

- `<type>(<optional-scope>): <description>`
- Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `build`, `ci`, `perf`, `style`
