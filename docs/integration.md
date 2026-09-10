# Integration Guide

This guide adds a **Play on Art Computer** action to your product: someone
selects works, presses play, and the works appear on their Feral File Art
Computer (FF1). It is for any product where people encounter art — a
marketplace, an artist's site, a gallery app, an agent. You embed a browser
library; everything else — pairing, approval, encryption, device delivery — is
handled by Feral File infrastructure.

The library targets the web runtime, so it drops into websites, web apps,
Electron, and web views inside native apps. A fully native client can
implement the same flow directly against the documented protocol
([API design](api-design.md), [sequential flow](sequential-flow.md)).

What the visitor experiences:

1. They press **Play on Art Computer** on your site.
2. First time only: a popup asks for a six-digit pairing code. They turn on
   **Browser Pairing** for their FF1 in the Feral File mobile app
   (Settings → Art Computers → select the FF1), enter the code shown, and
   approve the browser session in the app.
3. The playlist plays on their Art Computer. Subsequent plays from your site
   skip pairing entirely — the browser session is remembered per site origin
   until it expires or is removed.

Your site never receives device API keys or account credentials. It receives a
revokable browser session token scoped to the display path only — short-lived
by default, or kept until the owner removes it when they choose that.
The mint request and the returned session travel end-to-end encrypted between
the visitor's browser and their FF1, so the broker in the middle never sees
session tokens or playlist content. The broker does see what channel join
sends in the clear: the pairing code, your site's origin, and the browser
metadata you supply in `browserInfo`. The full model is in
[Sequential Flow](sequential-flow.md).

## What you need

- The requester library: [`@feralfile/play`](https://www.npmjs.com/package/@feralfile/play)
  (`npm i @feralfile/play`), source in this repo at
  [`clients/session-recipient/js`](../clients/session-recipient/js). For a
  site with no build step, download `play.js` from the
  [latest release](https://github.com/feral-file/play/releases/latest) — a
  self-contained ESM bundle — host it next to your pages, and
  `import { mountPlayOnArtComputerButton } from "./play.js"`. A CDN import
  (`https://esm.sh/@feralfile/play`) also works for quick experiments, but
  self-hosting keeps your integration free of infrastructure that neither of
  us operates.
- A [DP-1](https://github.com/display-protocol/dp1) playlist document for the
  works the visitor selected. DP-1 is an open spec; each playlist item points
  at a URL the FF1 can render (artwork pages, media files, generative works).
- Nothing server-side. No API key, no registration, no backend changes. The
  hosted Mint Pairing Broker at `https://handoff.feralfile.com` is the default
  and is open for integration use.

Your visitor needs an FF1 and the Feral File mobile app with their FF1 added.

## Quickest path: mount the button

```ts
import { mountPlayOnArtComputerButton } from "@feralfile/play";

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
- `requestedExpiresInSeconds` — session lifetime your site asks for, a whole
  number of seconds from 1 to 31536000 (one year); a value outside that throws
  where you set it, stored session or not. Leave it unset to take the device
  default. The device owner decides: if they keep your site paired, the request
  is ignored.

## Custom UI path

If the wrapped button does not fit, compose the pieces yourself:

```ts
import {
  requestEphemeralSessionWithPairingUi,
  displayDp1Playlist,
  hasStoredEphemeralBrowserSession,
  clearStoredEphemeralBrowserSession
} from "@feralfile/play";

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

- A session is `{ token, sessionId, expiresAt?, persistent?, relayerBaseUrl? }`.
  The token is a bearer credential: do not log it, report it to analytics, or
  expose it in thrown errors.
- Stored in `localStorage` under `ff:ephemeral-browser-session:<origin>`,
  scoped to your site's origin. Pass `storage: false` to manage persistence
  yourself.
- Approving in the app, the device owner can keep your site paired until they
  remove it (Settings → Art Computers → the FF1 → Paired sites). Such a session
  comes back with `persistent: true` and no `expiresAt`: it does not expire,
  and any `requestedExpiresInSeconds` your site asked for is ignored. Sessions
  the owner does not keep carry an `expiresAt` and expire as before.
- Keeping a site paired takes effect only for sites on a library version that
  supports it. Each request declares the capability, and the device sends the
  no-expiry shape only to a site that declared it; a site on an older version
  gets a timed session even when the owner chose to keep it. Upgrading the
  library is the whole fix — nothing changes on the device.
- Expiry and revocation are enforced by `ff-relayer`. The user can revoke a
  browser session from the Feral File side at any time.
- On a display attempt with a dead session the library throws a `PlayError`
  with code `session_rejected`; the wrapped button clears the stored session
  automatically so the next click re-pairs. Custom integrations should call
  `clearStoredEphemeralBrowserSession` on that code and prompt to pair again.

## Errors

Errors are `PlayError` instances carrying a stable `code`. Match on
`error.code` — messages are for humans and may change between versions;
codes will not. `pairingErrorMessage(error)` maps them to user-facing text.

| `error.code` | Meaning |
| :-- | :-- |
| `pairing_code_not_found` | Code not found — user should re-enable Browser Pairing and use the latest code. |
| `pairing_code_expired` | Code expired — same recovery. |
| `pairing_code_used` | Code already used — same recovery. |
| `mint_rejected` | User declined the approval in the mobile app. |
| `approval_timeout` | No approval within `maxWaitMs` (default 5 minutes). |
| `session_rejected` | Stored session expired or revoked — the wrapped button clears it; custom integrations clear and re-pair. |
| `pairing_canceled` | User closed the pairing dialog. |
| `display_failed` / `display_rejected` | The relayer or FF1 refused the display request. |

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
approval flow, and the FF1 display path work end to end today. One honest
caveat while this is pre-1.0: expect additive API change between 0.x versions.
Sessions authorize the display/cast path only — that is by design, and the
scope will stay narrow.

Tell us what is unclear, impractical, or missing — open an issue on this repo.
Integration questions and API-shape feedback are exactly what this stage is
for.
