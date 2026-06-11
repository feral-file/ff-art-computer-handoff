# Session Recipient Client: TypeScript

`clients/session-recipient/js/` is the TypeScript implementation for clients that receive an ephemeral browser session granted by `ff-controller`.

The current implementation targets browser runtimes. It checks `localStorage` under the current website origin for an existing ephemeral browser session. If one is missing, it creates a 5-minute handoff with the handoff server, returns QR payload content for the website to render, polls every 5 seconds for the encrypted mobile response, stores the recovered session in origin-scoped storage, and uses that token when requesting DP1 playlist display through `ff-relayer`. See [Sequential Flow](/Users/anhnguyen/Documents/projects/ff-art-computer-handoff/docs/sequential-flow.md) for the end-to-end model.

This directory is one session-recipient implementation. The project may add implementations in other languages or runtimes later, such as native apps or other third-party clients granted by `ff-controller`.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

## Boundaries

- Store browser session tokens only in origin-scoped browser storage.
- Do not expose token values through logs, thrown errors, analytics, or public callbacks.
- Use the token only for the intended `ff-relayer` display/cast path.
- Keep API names recipient-oriented rather than tied to a specific website.
