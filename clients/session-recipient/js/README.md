# @feralfile/play

`clients/session-recipient/js/` is `@feralfile/play`, the browser library websites embed to pair a visitor's browser with their Art Computer and play a DP-1 playlist on it. Internally it is the mint-pairing requester: the browser client that requests an ephemeral browser session from the Go token minter embedded in FF1 `feral-controld`.

```sh
npm i @feralfile/play
```

The published package ships compiled ESM + type declarations from `dist/` (`npm run build`). Source stays TypeScript-first in `src/`.

Browser runtimes check `localStorage` under the current website origin for an existing ephemeral browser session. If one is missing or invalid, `requestEphemeralSession` joins a Mint Pairing Broker channel using a QR/deep-link payload or short code, sends an end-to-end encrypted `mint_request` with the origin derived from `window.location.origin` and browser/client metadata, polls for an encrypted minter result, validates the channel binding, stores the recovered token in origin-scoped storage when storage is enabled, and returns the session metadata. `displayDp1Playlist` uses that session to request DP1 playlist display through `ff-relayer` without exposing the relayer command envelope to website code. See [Sequential Flow](../../../docs/sequential-flow.md) for the end-to-end model.

```ts
import {
  displayDp1Playlist,
  requestEphemeralSession
} from "@feralfile/play";

const session = await requestEphemeralSession({
  pairing: { qrPayload },
  browserInfo: { name: "Chrome", label: "Gallery wall browser" }
});

await displayDp1Playlist({
  session,
  playlist: dp1Playlist
});
```

## Wrapped Pairing UI

For a standard integration, mount the provided **Play on Art Computer** button.
It checks origin-scoped storage first, shows the pairing-code popup only when
there is no valid local browser session, waits for mobile approval, and then
sends the DP1 playlist to `ff-relayer`.

```ts
import { mountPlayOnArtComputerButton } from "@feralfile/play";

mountPlayOnArtComputerButton({
  container: "#play-on-art-computer",
  playlist: dp1Playlist,
  brokerBaseUrl: "https://handoff.feralfile.com",
  relayerBaseUrl: "https://artwork-info.feral-file.workers.dev"
});
```

The popup instructs users to make sure the FF1 is open, open the Feral File
mobile app, go to Settings -> Art Computers, select the FF1, and toggle Browser
Pairing on. After the pairing code is entered, the popup switches to an approval
state that asks the user to approve the browser session in the Feral File mobile
app and notes that FF CLI support will be available soon.

For custom UI, use `createPairingCodeDialog`,
`requestEphemeralSessionWithPairingUi`, `hasStoredEphemeralBrowserSession`, and
`clearStoredEphemeralBrowserSession`. The dialog accepts copy and class-name
overrides so a website can keep its own styling while preserving the pairing
sequence and approval handoff.

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
