# Mint Pairing Requester: TypeScript

`clients/session-recipient/js/` is the TypeScript implementation for browser clients that request an ephemeral browser session from the Go token minter embedded in FF1 `feral-controld`.

Browser runtimes check `localStorage` under the current website origin for an existing ephemeral browser session. If one is missing or invalid, `requestEphemeralSession` joins a Mint Pairing Broker channel using a QR/deep-link payload or short code, sends an end-to-end encrypted `mint_request` with origin and browser/client metadata, polls for an encrypted minter result, validates the channel binding, stores the recovered token in origin-scoped storage when storage is enabled, and returns the session metadata. Use the returned token only when requesting DP1 playlist display through `ff-relayer`. See [Sequential Flow](../../../docs/sequential-flow.md) for the end-to-end model.

```ts
import { requestEphemeralSession } from "@feral-file/mint-pairing-requester-js";

const session = await requestEphemeralSession({
  pairing: { qrPayload },
  browserInfo: { name: "Chrome", label: "Gallery wall browser" }
});

await fetch(`${session.relayerBaseUrl}/api/cast`, {
  method: "POST",
  headers: { authorization: `Bearer ${session.token}` },
  body: JSON.stringify({ feedUrl })
});
```

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
- Keep API names requester-oriented rather than tied to a specific website.
