# FF1 DP1 Mint Pairing Sample

This sample should act as an NFT display website that integrates the browser token requester library with the Mint Pairing Broker.

Implementation status: the current sample code still demonstrates the earlier handoff flow against `https://handoff.feralfile.com`. It should be updated in the follow-up code change to join a token-minter receiver whose QR/deep-link payload or short code is presented on the FF1 frontend, send an E2EE mint request, and receive the E2EE token result.

## Run

```sh
cd integration
npm run sample:dev
```

Open the printed local URL, paste a DP1 JSON payload, and press **Play on FF1**.

In the target flow, if this website origin has no stored browser session, the user reads or scans the QR/code shown on the FF1 frontend, the page joins that temporary mint receiver through the Mint Pairing Broker, sends requester metadata to the Go token minter in `feral-controld` over E2EE, waits for an encrypted token result after user approval through `ff-controller` via `ff-relayer`, stores that recovered session in `localStorage`, and then sends the DP1 feed URL from the browser to `ff-relayer`.

If a stored session already exists, the page skips pairing and sends the DP1 feed URL directly.

## Delivered Session Payload

The decrypted broker result is expected to be JSON with:

- `token`, `sessionToken`, `browserSessionToken`, `accessToken`, or `bearerToken`
- Optional `relayerBaseUrl`
- Optional `expiresAt`

The target sample sends `Authorization: Bearer <token>` to `POST /api/cast` with the DP1 feed URL in the cast request body.
