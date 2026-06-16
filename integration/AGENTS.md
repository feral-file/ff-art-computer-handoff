# AGENTS.md

## Component

`integration/` verifies behavior across components.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

## Rules

- Use isolated temporary storage for tests.
- Do not hardcode production credentials.
- Cover the mint pairing sequence as implementation support lands.
- Keep tests focused on externally visible behavior and security boundaries.
