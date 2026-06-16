# AGENTS.md

## Component

`server/` is the Mint Pairing Broker. It bridges NFT display websites and ephemeral token minters for short-lived, end-to-end encrypted mint request/response exchange.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

## Rules

- bbolt is the target source of truth for server state.
- Do not add in-memory maps for sessions, payloads, token state, expiry state, or test shortcuts.
- Do not log bearer tokens, raw session tokens, or playlist content.
- Do not turn this service into a DP1 playlist proxy.
- Keep TypeScript strict mode, `noUncheckedIndexedAccess`, and type-aware ESLint rules enabled.
