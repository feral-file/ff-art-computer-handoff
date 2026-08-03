# Third-Party Integration Guide

This guide is for a website that wants a **Play on Art Computer** action: a
visitor selects works on your site, presses play, and the works appear on their
Feral File Art Computer (FF1). You embed a browser library; everything else —
pairing, approval, encryption, device delivery — is handled by Feral File
infrastructure.

What the visitor experiences:

1. They press **Play on Art Computer** on your site.
2. First time only: a popup asks for a six-digit pairing code. They turn on
   **Browser Pairing** for their FF1 in the Feral File mobile app
   (Settings → Art Computers → select the FF1), enter the code shown, and
   approve the browser session in the app.
3. The playlist plays on their Art Computer. Subsequent plays from your site
   skip pairing entirely — the browser session is remembered per site origin
   until it expires or is revoked.

Your site never receives device API keys or account credentials. It receives a
short-lived, revokable browser session token scoped to the display path only.
The pairing exchange is end-to-end encrypted between the visitor's browser and
their FF1; the broker in the middle cannot read it. The full model is in
[Sequential Flow](sequential-flow.md).

## What you need

- The requester library: `@feral-file/mint-pairing-requester-js`, in this repo
  at [`clients/session-recipient/js`](../clients/session-recipient/js). It is
  not yet published to npm — consume it from this repo (the
  [integration sample](../integration) does so with a `file:` dependency; a
  git dependency or vendored build works the same way). npm publication is
  planned; the API below is the stable surface to build against.
- A [DP-1](https://github.com/display-protocol/dp1) playlist document for the
  works the visitor selected. DP-1 is an open spec; each playlist item points
  at a URL the FF1 can render (artwork pages, media files, generative works).
- Nothing server-side. No API key, no registration, no backend changes. The
  hosted Mint Pairing Broker at `https://handoff.feralfile.com` is the default
  and is open for integration use.

Your visitor needs an FF1 and the Feral File mobile app with their FF1 added.

## Quickest path: mount the button

```ts
import { mountPlayOnArtComputerButton } from "@feral-file/mint-pairing-requester-js";

mountPlayOnArtComputerButton({
  container: "#play-on-art-computer",
  playlist: () => buildDp1PlaylistFromSelection(),
  brokerBaseUrl: "https://handoff.feralfile.com"
});
```

This renders the button, and on click: checks origin-scoped `localStorage` for
a valid browser session; shows the pairing-code popup only when there is none;
waits for approval in the mobile app; then sends the playlist to the FF1.

`playlist` and `brokerBaseUrl` accept either a value or a (possibly async)
function, so you can build the DP-1 document at click time from the visitor's
current selection.

Useful options (see `PlayOnArtComputerButtonOptions` in
[`ui.ts`](../clients/session-recipient/js/src/ui.ts) for the full set):

- `buttonLabel`, `busyLabel`, `className`, `statusClassName` — restyle the
  button to match your site.
- `dialog.copy`, `dialog.classNames` — override the popup's copy and styling
  while keeping the pairing sequence.
- `onStatusChange`, `onSuccess`, `onError` — drive your own status UI.
- `browserInfo` — `{ name, userAgent, label }` shown to the user in the
  mobile-app approval prompt. Set `label` to something the visitor will
  recognize, e.g. your site name.

## Custom UI path

If the wrapped button does not fit, compose the pieces yourself:

```ts
import {
  requestEphemeralSessionWithPairingUi,
  displayDp1Playlist,
  hasStoredEphemeralBrowserSession,
  clearStoredEphemeralBrowserSession
} from "@feral-file/mint-pairing-requester-js";

const session = await requestEphemeralSessionWithPairingUi({
  brokerBaseUrl: "https://handoff.feralfile.com",
  browserInfo: { label: "My Gallery" }
});

await displayDp1Playlist({ session, playlist });
```

- `requestEphemeralSessionWithPairingUi` reuses a stored session when one
  exists, otherwise runs the pairing-code dialog and approval wait. Pass
  `createDialog` to replace the dialog entirely (implement the
  `PairingCodeDialog` interface).
- `requestEphemeralSession` is the headless core: you supply the pairing input
  (`{ brokerBaseUrl, shortCode }` from your own code entry UI, or
  `{ qrPayload }` from a scanned QR) and it returns the session.
- `displayDp1Playlist` owns the relayer request envelope and response
  validation. Website code never constructs relayer commands directly.

## Sessions

- A session is `{ token, sessionId, expiresAt, relayerBaseUrl? }`. The token is
  a bearer credential: do not log it, report it to analytics, or expose it in
  thrown errors.
- Stored in `localStorage` under `ff:ephemeral-browser-session:<origin>`,
  scoped to your site's origin. Pass `storage: false` to manage persistence
  yourself.
- Expiry and revocation are enforced by `ff-relayer`. The user can revoke a
  browser session from the Feral File side at any time.
- On a display attempt with a dead session the library throws
  `"browser session rejected"`; the wrapped button clears the stored session
  automatically so the next click re-pairs. Custom integrations should call
  `clearStoredEphemeralBrowserSession` on that error and prompt to pair again.

## Errors

`pairingErrorMessage(error)` maps library errors to user-facing text. The cases
worth handling:

| Error message | Meaning |
| :-- | :-- |
| `short-code resolution failed: 404` | Code not found — user should re-enable Browser Pairing and use the latest code. |
| `short-code resolution failed: 410` | Code expired — same recovery. |
| `channel join failed: 401` | Code already used — same recovery. |
| `mint request rejected` | User declined the approval in the mobile app. |
| `poll timed out` | No approval within `maxWaitMs` (default 5 minutes). |
| `browser session rejected` | Stored session expired or revoked — clear it and re-pair. |

## Network endpoints

The visitor's browser talks to two hosts. If your site sets a
`Content-Security-Policy`, allow them in `connect-src`:

- the Mint Pairing Broker (`https://handoff.feralfile.com`) — pairing-code
  resolution, channel join, encrypted message send/poll
- `ff-relayer` — the display request. The relayer base URL is delivered inside
  the approved session payload (`session.relayerBaseUrl`); the current default
  is `https://artwork-info.feral-file.workers.dev`.

Playlist content does not travel through either host: the browser sends the
DP-1 document to the relayer as part of the display command, and artwork media
is fetched directly by the FF1 from the URLs inside the playlist.

## Try it against the sample

The [integration sample](../integration/sample) is this exact flow as a
minimal page — paste a DP-1 payload, press play. From the repo root:

```sh
cd integration && npm ci && npm run sample:dev
```

Pairing against real hardware requires an FF1 and the mobile app; the sample
uses the hosted broker by default, so no local server is needed.

## Status

The requester library API documented here, the hosted broker, the mobile-app
approval flow, and the FF1 display path work end to end today. Two honest
caveats while this is pre-1.0:

- The library is not yet on npm; consume it from this repo for now.
- Sessions currently authorize the display/cast path only. That is by design —
  scope will stay narrow.

Tell us what is unclear, impractical, or missing — open an issue on this repo.
Integration questions and API-shape feedback are exactly what this stage is
for.
