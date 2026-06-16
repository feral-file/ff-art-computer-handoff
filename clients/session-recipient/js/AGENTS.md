# AGENTS.md

## Component

`clients/session-recipient/js/` is the TypeScript token requester implementation for browser runtimes. It should request ephemeral browser sessions from the Go token minter embedded in FF1 `feral-controld` through the Mint Pairing Broker in the target flow.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

## Rules

- Treat ephemeral browser session tokens as bearer credentials.
- Store token state under the current website origin when browser storage is used.
- Do not add website-specific concepts to the public API.
- Do not route DP1 playlist content through `ff-controller`, the token minter, or the Mint Pairing Broker.
- Keep TypeScript strict mode, `noUncheckedIndexedAccess`, and type-aware ESLint rules enabled.
