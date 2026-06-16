# Integration Tests

`integration/` contains Vitest tests for cross-component behavior.

Integration coverage should exercise the mint pairing flow described in [Sequential Flow](../docs/sequential-flow.md): NFT display website with embedded token requester library, Go ephemeral token minter embedded in FF1 `feral-controld`, FF1 frontend QR/code display, `ff-controller` approval UI reached through `ff-relayer`, FF1 display path, and the Mint Pairing Broker as the short-lived opaque E2EE transport.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

`npm test` builds the Go broker Docker image, launches it with an isolated
temporary `/data` volume, and verifies the mint pairing sequence over HTTP.

## Expectations

- Tests use isolated temporary storage.
- Tests must not hardcode production credentials.
- Tests should verify that DP1 playlist content does not travel through `ff-controller`.
- Tests should verify token expiry, revocation, and unauthorized paths when those behaviors are implemented locally.
