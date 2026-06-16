# AGENTS.md

## Component

`server/` is the Mint Pairing Broker. It bridges NFT display websites and ephemeral token minters for short-lived, end-to-end encrypted mint request/response exchange.

## Commands

```sh
go test ./...
go build ./...
```

## Rules

- bbolt is the target source of truth for server state.
- Do not add in-memory maps for sessions, payloads, token state, expiry state, or test shortcuts.
- Do not log bearer tokens, raw session tokens, or playlist content.
- Do not turn this service into a DP1 playlist proxy.
- Keep Go code idiomatic, formatted with `gofmt`, and covered by `go test ./...`.
