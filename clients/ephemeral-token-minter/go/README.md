# Go Ephemeral Token Minter

This package is the FF1 `feral-controld` side of browser session mint pairing. It creates Mint Pairing Broker channels, returns display material for the FF1 frontend, decrypts browser mint requests, and sends encrypted success or rejection responses back to the requester.

The package deliberately does not implement `ff-controller` approval behavior or `ff-relayer` session creation policy. Host code should inject those integrations through the documented interfaces in `interfaces.go`.

## Protocol Notes

- Crypto: `P256-HKDF-SHA256-AES-256-GCM`.
- Public keys use JSON/JWK-compatible P-256 coordinates.
- Encrypted envelopes include channel-binding AAD.
- Browser-to-minter envelopes must carry the browser public JWK as public envelope metadata so the minter can derive the ECDH shared secret without exposing plaintext to the broker.
- Session tokens must not be logged and are sent to the browser only inside encrypted `mint_succeeded` payloads.

## Test

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
```
