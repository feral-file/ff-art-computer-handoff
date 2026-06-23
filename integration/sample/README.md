# FF1 DP1 Mint Pairing Sample

This sample should act as an NFT display website that integrates the browser token requester library with the Mint Pairing Broker.

## Run

```sh
cd integration
npm run sample:dev
```

Open the printed local URL, paste a DP1 JSON payload, enter the pairing code shown by the FF1 player overlay, and press **Play on FF1**. The broker defaults to `https://handoff.feralfile.com`. The page also accepts a QR/deep-link payload JSON or URL when that pairing material is available.

If this website origin has no stored browser session, the page joins the temporary mint receiver through the Mint Pairing Broker, sends requester metadata to the Go token minter in `feral-controld` over E2EE, waits for an encrypted token result after user approval through `ff-controller` via `ff-relayer`, stores that recovered session in `localStorage`, and then sends the DP1 payload from the browser to `ff-relayer` inside a `displayPlaylist` cast command.

If a stored session already exists, the page skips pairing and sends the DP1 payload directly.

## Delivered Session Payload

The decrypted broker result is expected to be a `mint_succeeded` payload containing `session.token`, `session.sessionId`, `session.expiresAt`, and optional `session.relayerBaseUrl`.

The target sample sends `Authorization: Bearer <token>` to `POST /api/cast` with the DP1 JSON payload wrapped as:

```json
{
  "command": "displayPlaylist",
  "request": {
    "intent": {
      "action": "now_display"
    },
    "dp1_call": {
      "items": []
    }
  }
}
```
