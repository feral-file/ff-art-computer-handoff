# AGENTS.md

## Component

`clients/session-recipient/js/` is the TypeScript session-recipient implementation for browser runtimes.

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
- Do not route DP1 playlist content through `ff-controller`.
- Keep TypeScript strict mode, `noUncheckedIndexedAccess`, and type-aware ESLint rules enabled.
