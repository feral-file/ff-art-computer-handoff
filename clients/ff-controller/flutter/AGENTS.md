# AGENTS.md

## Component

`clients/ff-controller/flutter/` is the Flutter/Dart `ff-controller` client implementation.

## Commands

```sh
flutter pub get
dart format --set-exit-if-changed .
flutter analyze
flutter test
```

## Rules

- Keep Dart analyzer rules strict.
- Do not route DP1 playlist content through the mobile app.
- Do not log ephemeral browser session tokens or playlist content.
- Keep APIs aligned with `ff-controller` responsibilities: create or obtain sessions, send them to the browser, and support revocation.
- Use maintained crypto packages where crypto is required; do not implement elliptic-curve math manually.
