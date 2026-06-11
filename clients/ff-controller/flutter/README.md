# ff-controller Client: Flutter

`clients/ff-controller/flutter/` is the Flutter/Dart client implementation for `ff-controller`.

`ff-controller` is the mobile app party in the flow. It scans and validates a session-recipient QR payload, creates or obtains an ephemeral browser session for a relay topic from `ff-relayer`, sends that session to the granted client through the handoff server as opaque encrypted content, and remains responsible for session management such as listing or revocation. See [Sequential Flow](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/docs/sequential-flow.md) for the end-to-end model.

This directory is one `ff-controller` implementation. The project may add implementations in other languages or platforms later under `clients/ff-controller/<language>`.

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
- Keep session creation and revocation paths explicit.
- Use maintained crypto and HTTP packages; do not implement elliptic-curve math manually.
