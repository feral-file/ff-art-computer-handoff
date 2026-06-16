# Legacy ff-controller Client: Flutter

`clients/ff-controller/flutter/` is the legacy Flutter/Dart client implementation from the earlier flow.

The target design replaces this library with a Go ephemeral token minter used by FF1 `feral-controld`. In that flow, `ff-controller` is an approval UI reached by the minter through `ff-relayer`; it approves or rejects mint requests but does not mint browser sessions, receive raw browser session tokens, or carry DP1 playlist content. See [Sequential Flow](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/docs/sequential-flow.md) for the updated model.

Implementation status: the code has not been removed yet because this is a documentation-only update. Delete or replace this directory with `clients/ephemeral-token-minter/go` in the follow-up code change.

## Commands

```sh
flutter pub get
dart format --set-exit-if-changed .
flutter analyze
flutter test
```

## Boundaries

- Do not receive, proxy, log, or store DP1 playlist content.
- Do not expose ephemeral browser session tokens through logs, errors, or analytics.
- Treat this package as legacy until it is removed.
