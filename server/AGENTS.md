# AGENTS.md

## Component

`server/` is the handoff server. It bridges `ff-controller` and session-recipient clients for ephemeral browser session delivery.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

## Rules

- LMDB is the source of truth for server state.
- Do not add in-memory maps for sessions, payloads, token state, expiry state, or test shortcuts.
- Do not log bearer tokens, raw session tokens, or playlist content.
- Do not turn this service into a DP1 playlist proxy.
- Keep TypeScript strict mode, `noUncheckedIndexedAccess`, and type-aware ESLint rules enabled.
