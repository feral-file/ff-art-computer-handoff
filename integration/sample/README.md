# FF1 DP1 Mint Pairing Sample

This sample should act as an NFT display website that integrates the browser token requester library with the Mint Pairing Broker.

## Run

```sh
cd clients/session-recipient/js && npm ci && npm run build && cd ../../../integration
npm ci
npm run sample:dev
```

Open the printed local URL, paste a DP1 JSON payload, and press **Play on Art Computer**. The broker defaults to `https://handoff.feralfile.com`.

If this website origin has no stored browser session, the wrapped requester button opens the pairing-code popup. The popup instructs the user to make sure the FF1 is open, open the Feral File mobile app, go to Settings -> Art Computers, select the FF1, toggle Browser Pairing on, and enter the code. After the code is entered, the popup asks the user to approve the browser session in the Feral File mobile app.

After the code is submitted, the page joins the temporary mint receiver through the Mint Pairing Broker, sends requester metadata to the Go token minter in `feral-controld` over E2EE, waits for an encrypted token result after user approval through `ff-controller` via `ff-relayer`, stores that recovered session in `localStorage`, and then asks the requester library to display the DP1 payload through `ff-relayer`.

If a stored session already exists, the page skips pairing and sends the DP1 payload directly.

## Delivered Session Payload

The decrypted broker result is expected to be a `mint_succeeded` payload containing `session.token`, `session.sessionId`, `session.expiresAt`, and optional `session.relayerBaseUrl`.

The wrapped requester button calls `displayDp1Playlist({ session, playlist })`; the requester library owns the `POST /api/cast` command envelope and FF1 response validation.
