# Token Requester Client: TypeScript

`clients/session-recipient/js/` is the TypeScript implementation for browser clients that request an ephemeral browser session from the Go token minter embedded in FF1 `feral-controld`.

The target design for browser runtimes checks `localStorage` under the current website origin for an existing ephemeral browser session. If one is missing or invalid, it joins a temporary receiver through the Mint Pairing Broker using a QR/deep-link payload or short code, sends an end-to-end encrypted mint request with origin and browser/client metadata, polls for an encrypted result, stores the recovered token in origin-scoped storage, and uses that token when requesting DP1 playlist display through `ff-relayer`. See [Sequential Flow](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/docs/sequential-flow.md) for the end-to-end model.

Implementation status: this directory still contains the earlier handoff-shaped browser implementation. It should be updated to the token-requester flow in the follow-up code change.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

## Boundaries

- Store browser session tokens only in origin-scoped browser storage.
- Do not expose token values through logs, thrown errors, analytics, or public callbacks.
- Use the token only for the intended `ff-relayer` display/cast path.
- Keep API names requester-oriented rather than tied to a specific website.
