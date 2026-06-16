# AGENTS.md

## Component

`clients/ff-controller/flutter/` is the legacy Flutter/Dart `ff-controller` client implementation from the earlier flow. It should be removed or replaced by the planned Go ephemeral token minter used by FF1 `feral-controld` in the code migration.

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
- Treat `ff-controller` as an approval UI in the target flow; it should not create browser sessions, receive raw browser session tokens, or send tokens to the browser.
- Use maintained crypto packages where crypto is required; do not implement elliptic-curve math manually.
