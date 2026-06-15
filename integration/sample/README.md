# FF1 DP1 Handoff Sample

This sample website integrates the browser session-recipient library with the production handoff server at `https://handoff.feralfile.com`.

## Run

```sh
cd integration
npm run sample:dev
```

Open the printed local URL, paste a DP1 JSON payload, and press **Play on FF1**.

If this website origin has no stored browser session, the page creates a handoff session, renders the QR payload in a modal, waits for `ff-controller` to deliver the encrypted browser-session payload, stores that recovered session in `localStorage`, and then sends the DP1 payload directly from the browser to `ff-relayer`.

If a stored session already exists, the page skips pairing and sends the DP1 payload directly.

## Delivered Session Payload

The decrypted handoff payload is expected to be JSON with:

- `token`, `sessionToken`, `browserSessionToken`, `accessToken`, or `bearerToken`
- `topicID`, `topicId`, `topic`, `relayTopicID`, or `relayTopicId`
- Optional `relayerBaseUrl`
- Optional `expiresAt`

The sample sends `Authorization: Bearer <token>` to `POST /api/cast?topicID=<topicID>`.
