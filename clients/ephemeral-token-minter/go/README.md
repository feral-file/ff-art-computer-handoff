# Go Ephemeral Token Minter

This package is the FF1 `feral-controld` side of browser session mint pairing. It creates Mint Pairing Broker channels, returns display material for the FF1 frontend, decrypts browser mint requests, and sends encrypted success or rejection responses back to the requester.

The package deliberately does not implement or abstract `ff-controller` approval behavior or `ff-relayer` session creation. `feral-controld` owns those integrations and passes only the final success or rejection payload back into this broker/E2EE library.

## Protocol Notes

- Crypto: `P256-HKDF-SHA256-AES-256-GCM`.
- Public keys use JSON/JWK-compatible P-256 coordinates.
- Encrypted envelopes include channel-binding AAD.
- Browser-to-minter envelopes must carry the browser public JWK as public envelope metadata so the minter can derive the ECDH shared secret without exposing plaintext to the broker.
- Session tokens must not be logged and are sent to the browser only inside encrypted `mint_succeeded` payloads.
- `SendMintSuccess` and `SendMintRejection` send terminal encrypted results but deliberately do not close the broker channel immediately, because the browser must still poll the accepted message. Host code should call `Close` after result delivery, timeout, cancellation, or local cleanup policy permits channel removal.

## Test

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
```
