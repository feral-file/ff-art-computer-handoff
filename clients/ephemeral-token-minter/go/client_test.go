package minter

import (
	"context"
	"crypto/ecdh"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCryptoRoundTrip(t *testing.T) {
	minterKey, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	browserKey, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	minterJWK, err := publicKeyToJWK(minterKey.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	browserJWK, err := publicKeyToJWK(browserKey.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	aad := envelopeAAD{
		Version:   1,
		ChannelID: "ch_test",
		MessageID: "msg_test",
		Seq:       0,
		Sender:    "browser",
		Recipient: "minter",
		Algorithm: Algorithm,
	}
	encrypted, err := encryptJSON(browserKey, minterJWK, aad, mintRequestPlaintext{
		Type:   messageTypeMintRequest,
		Origin: "https://nft.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	encrypted.SenderPublicKeyJWK = &browserJWK
	plaintext, decodedAAD, err := decryptMessage(minterKey, encrypted, browserJWK)
	if err != nil {
		t.Fatal(err)
	}
	if decodedAAD.ChannelID != "ch_test" {
		t.Fatalf("channel binding mismatch: %s", decodedAAD.ChannelID)
	}
	var decoded mintRequestPlaintext
	if err := json.Unmarshal(plaintext, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Type != messageTypeMintRequest || decoded.Origin != "https://nft.example" {
		t.Fatalf("unexpected plaintext: %#v", decoded)
	}
}

func TestStartChannelParsesBrokerResponse(t *testing.T) {
	expiresAt := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/channels" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		rawBody := readRequestBody(t, r)
		if strings.Contains(rawBody, "topic-1") || strings.Contains(rawBody, "topicId") {
			t.Fatalf("topic context leaked to broker create request: %s", rawBody)
		}
		var request createChannelRequest
		if err := json.Unmarshal([]byte(rawBody), &request); err != nil {
			t.Fatal(err)
		}
		if request.Algorithm != Algorithm {
			t.Fatalf("unexpected algorithm: %s", request.Algorithm)
		}
		if request.MinterPublicKeyJWK.Curve != "P-256" {
			t.Fatalf("unexpected key: %#v", request.MinterPublicKeyJWK)
		}
		if request.IdleTTLSeconds != 300 || !request.ShortCodeRequested {
			t.Fatalf("unexpected create request: %#v", request)
		}
		writeJSON(t, w, createChannelResponse{
			ChannelID:   "ch_123",
			MinterToken: "mt_secret",
			ShortCode:   "123456",
			ExpiresAt:   expiresAt,
			QRPayload:   json.RawMessage(`{"v":1,"type":"ff-mint-pairing"}`),
		})
	}))
	defer server.Close()

	channel, err := NewClient(server.Client()).StartChannel(context.Background(), StartChannelOptions{
		BrokerBaseURL:      server.URL,
		IdleTTL:            5 * time.Minute,
		ShortCodeRequested: true,
		TopicID:            "topic-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	display := channel.PairingDisplay()
	if display.ChannelID != "ch_123" || display.ShortCode != "123456" || !display.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("unexpected display: %#v", display)
	}
	if string(display.QRPayload) != `{"v":1,"type":"ff-mint-pairing"}` {
		t.Fatalf("unexpected QR payload: %s", display.QRPayload)
	}
}

func TestPollMintRequestDecryptsBrowserMessage(t *testing.T) {
	harness := newChannelHarness(t)
	requestPlaintext := mintRequestPlaintext{
		Type:   messageTypeMintRequest,
		Origin: "https://nft.example",
		BrowserInfo: BrowserInfo{
			Name:      "Chrome",
			UserAgent: "Mozilla/5.0",
			Label:     "Gallery laptop",
		},
		RequestedExpiresInSeconds: 900,
	}
	message := harness.encryptBrowserMessage(t, "msg_browser", 7, requestPlaintext)
	harness.messages = []encryptedMessage{message}

	request, err := harness.channel.PollMintRequest(context.Background(), 6)
	if err != nil {
		t.Fatal(err)
	}
	if request == nil {
		t.Fatal("expected mint request")
	}
	if request.ChannelID != "ch_test" || request.MessageID != "msg_browser" || request.Seq != 7 {
		t.Fatalf("unexpected request binding: %#v", request)
	}
	if request.Origin != "https://nft.example" || request.BrowserInfo.Name != "Chrome" || request.RequestedExpiresInSeconds != 900 {
		t.Fatalf("unexpected request payload: %#v", request)
	}
}

func TestSendMintSuccessAndRejectionEncryptPayloads(t *testing.T) {
	harness := newChannelHarness(t)
	request := harness.mintRequest(t)
	expiresAt := time.Date(2026, 6, 16, 11, 0, 0, 0, time.UTC)

	result, err := harness.channel.SendMintSuccess(context.Background(), request, MintResult{
		SessionID:      "eps_123",
		Token:          "browser-token-secret",
		ExpiresAt:      expiresAt,
		RelayerBaseURL: "https://relayer.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Seq != 100 {
		t.Fatalf("unexpected send result: %#v", result)
	}
	if len(harness.sentMessages) != 1 {
		t.Fatalf("expected one sent message, got %d", len(harness.sentMessages))
	}
	if strings.Contains(harness.sentBodies[0], "browser-token-secret") {
		t.Fatal("raw token appeared in broker-visible request body")
	}
	successPlaintext := harness.decryptMinterMessage(t, harness.sentMessages[0])
	var success mintSuccessPlaintext
	if err := json.Unmarshal(successPlaintext, &success); err != nil {
		t.Fatal(err)
	}
	if success.Type != messageTypeMintSucceeded || success.ChannelID != "ch_test" || success.Session.Token != "browser-token-secret" || success.Session.SessionID != "eps_123" {
		t.Fatalf("unexpected success plaintext: %#v", success)
	}

	_, err = harness.channel.SendMintRejection(context.Background(), request, MintRejection{
		Reason:    "rejected_by_user",
		Retryable: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	rejectionPlaintext := harness.decryptMinterMessage(t, harness.sentMessages[1])
	var rejection mintRejectionPlaintext
	if err := json.Unmarshal(rejectionPlaintext, &rejection); err != nil {
		t.Fatal(err)
	}
	if rejection.Type != messageTypeMintRejected || rejection.ChannelID != "ch_test" || rejection.Reason != "rejected_by_user" || !rejection.Retryable {
		t.Fatalf("unexpected rejection plaintext: %#v", rejection)
	}
}

func TestCloseSendsDelete(t *testing.T) {
	harness := newChannelHarness(t)
	if err := harness.channel.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !harness.closed {
		t.Fatal("expected broker close request")
	}
}

type channelHarness struct {
	t            *testing.T
	server       *httptest.Server
	channel      *Channel
	browserKey   *ecdh.PrivateKey
	browserJWK   PublicJWK
	messages     []encryptedMessage
	sentMessages []encryptedMessage
	sentBodies   []string
	closed       bool
}

func newChannelHarness(t *testing.T) *channelHarness {
	t.Helper()
	h := &channelHarness{t: t}
	browserKey, err := generatePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	browserJWK, err := publicKeyToJWK(browserKey.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	h.browserKey = browserKey
	h.browserJWK = browserJWK
	h.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/channels":
			writeJSON(t, w, createChannelResponse{
				ChannelID:   "ch_test",
				MinterToken: "mt_test",
				ShortCode:   "654321",
				ExpiresAt:   time.Now().Add(5 * time.Minute).UTC(),
				QRPayload:   json.RawMessage(`{"v":1}`),
			})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/channels/ch_test/messages":
			if r.Header.Get("Authorization") != "Bearer mt_test" {
				t.Fatalf("missing authorization: %s", r.Header.Get("Authorization"))
			}
			if r.URL.Query().Get("afterSeq") == "" {
				t.Fatal("missing afterSeq")
			}
			writeJSON(t, w, pollMessagesResponse{
				ChannelID: "ch_test",
				ExpiresAt: time.Now().Add(5 * time.Minute).UTC(),
				Messages:  h.messages,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/channels/ch_test/messages":
			if r.Header.Get("Authorization") != "Bearer mt_test" {
				t.Fatalf("missing authorization: %s", r.Header.Get("Authorization"))
			}
			var message encryptedMessage
			rawBody := readRequestBody(t, r)
			if err := json.Unmarshal([]byte(rawBody), &message); err != nil {
				t.Fatal(err)
			}
			h.sentBodies = append(h.sentBodies, rawBody)
			h.sentMessages = append(h.sentMessages, message)
			writeJSON(t, w, sendMessageResponse{
				ChannelID: "ch_test",
				Seq:       int64(99 + len(h.sentMessages)),
				ExpiresAt: time.Now().Add(5 * time.Minute).UTC(),
			})
		case r.Method == http.MethodDelete && r.URL.Path == "/v1/channels/ch_test":
			if r.Header.Get("Authorization") != "Bearer mt_test" {
				t.Fatalf("missing authorization: %s", r.Header.Get("Authorization"))
			}
			h.closed = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(h.server.Close)

	channel, err := NewClient(h.server.Client()).StartChannel(context.Background(), StartChannelOptions{
		BrokerBaseURL: h.server.URL,
		IdleTTL:       5 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.channel = channel
	return h
}

func (h *channelHarness) encryptBrowserMessage(t *testing.T, messageID string, seq int64, plaintext mintRequestPlaintext) encryptedMessage {
	t.Helper()
	aad := envelopeAAD{
		Version:   1,
		ChannelID: h.channel.channelID,
		MessageID: messageID,
		Seq:       seq,
		Sender:    "browser",
		Recipient: "minter",
		Algorithm: Algorithm,
	}
	message, err := encryptJSON(h.browserKey, h.channel.publicKeyJWK, aad, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	message.Seq = seq
	message.SenderPublicKeyJWK = &h.browserJWK
	return message
}

func (h *channelHarness) mintRequest(t *testing.T) MintRequest {
	t.Helper()
	return MintRequest{
		ChannelID:           h.channel.channelID,
		MessageID:           "msg_browser",
		Seq:                 7,
		Origin:              "https://nft.example",
		BrowserPublicKeyJWK: h.browserJWK,
	}
}

func (h *channelHarness) decryptMinterMessage(t *testing.T, message encryptedMessage) []byte {
	t.Helper()
	plaintext, aad, err := decryptMessage(h.browserKey, message, h.channel.publicKeyJWK)
	if err != nil {
		t.Fatal(err)
	}
	if aad.ChannelID != h.channel.channelID || aad.Sender != "minter" || aad.Recipient != "browser" {
		t.Fatalf("unexpected AAD: %#v", aad)
	}
	return plaintext
}

func writeJSON(t *testing.T, w http.ResponseWriter, body any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		t.Fatal(err)
	}
}

func readRequestBody(t *testing.T, r *http.Request) string {
	t.Helper()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
