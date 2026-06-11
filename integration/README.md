# Integration Tests

`integration/` contains Vitest tests for cross-component behavior.

Integration coverage should exercise the three-party flow described in [Sequential Flow](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/docs/sequential-flow.md): `ff-controller`, the browser library, and `ff-relayer`, with the handoff server covered as the transport component between mobile and browser.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

## Expectations

- Tests use isolated temporary storage.
- Tests must not hardcode production credentials.
- Tests should verify that DP1 playlist content does not travel through `ff-controller`.
- Tests should verify token expiry, revocation, and unauthorized paths when those behaviors are implemented locally.
