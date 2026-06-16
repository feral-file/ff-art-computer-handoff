package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

var testPublicJWK = json.RawMessage(`{"kty":"EC","crv":"P-256","x":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","y":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`)

type testEnv struct {
	broker *Broker
	server *httptest.Server
	clock  *time.Time
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	start := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	env := &testEnv{clock: &start}
	broker, err := NewBroker(Config{
		DBPath:        filepath.Join(t.TempDir(), "broker.db"),
		BrokerBaseURL: "https://pairing.test",
		Now: func() time.Time {
			return *env.clock
		},
	})
	if err != nil {
		t.Fatalf("NewBroker: %v", err)
	}
	env.broker = broker
	env.server = httptest.NewServer(broker)
	t.Cleanup(func() {
		env.server.Close()
		if err := env.broker.Close(); err != nil {
			t.Fatalf("close broker: %v", err)
		}
	})
	return env
}

func TestCreateAndJoinChannel(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)
	if created.ChannelID == "" || created.MinterToken == "" || created.PairingToken == "" || created.ShortCode == "" {
		t.Fatalf("create response omitted pairing material: %+v", created)
	}

	joined := joinWithPairingToken(t, env, created)
	if joined.ChannelID != created.ChannelID {
		t.Fatalf("joined channel = %q, want %q", joined.ChannelID, created.ChannelID)
	}
	if joined.BrowserToken == "" {
		t.Fatal("join response omitted browser token")
	}
	if joined.NextSeq != 1 {
		t.Fatalf("nextSeq = %d, want 1", joined.NextSeq)
	}
	if !bytes.Equal(joined.MinterPublicKeyJWK, testPublicJWK) {
		t.Fatalf("minter public key mismatch: %s", joined.MinterPublicKeyJWK)
	}
}

func TestDuplicateJoinRejected(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	_ = joinWithPairingToken(t, env, created)

	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/join", "", JoinChannelRequest{
		PairingToken:        created.PairingToken,
		BrowserPublicKeyJWK: testPublicJWK,
		Origin:              "https://nft.example",
	}, nil)
	if status != http.StatusUnauthorized || errCode != "unauthorized" {
		t.Fatalf("duplicate join status/error = %d/%q, want 401/unauthorized", status, errCode)
	}
}

func TestMessageAuth(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	req := AppendMessageRequest{
		MessageID:  "msg_auth",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	}
	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", "wrong-token", req, nil)
	if status != http.StatusUnauthorized || errCode != "unauthorized" {
		t.Fatalf("bad bearer status/error = %d/%q, want 401/unauthorized", status, errCode)
	}

	req.Sender = roleMinter
	req.Recipient = roleBrowser
	status, errCode = postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, req, nil)
	if status != http.StatusUnauthorized || errCode != "unauthorized" {
		t.Fatalf("sender mismatch status/error = %d/%q, want 401/unauthorized", status, errCode)
	}
}

func TestAppendAndPollBothDirections(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	browserAppend := appendMessage(t, env, created.ChannelID, joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_browser",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad-browser",
		Nonce:      "nonce-browser",
		Ciphertext: "ciphertext-browser",
	})
	if browserAppend.Seq != 1 {
		t.Fatalf("browser append seq = %d, want 1", browserAppend.Seq)
	}

	minterPoll := pollMessages(t, env, created.ChannelID, created.MinterToken, 0)
	if len(minterPoll.Messages) != 1 || minterPoll.Messages[0].MessageID != "msg_browser" {
		t.Fatalf("minter poll messages = %+v", minterPoll.Messages)
	}

	minterAppend := appendMessage(t, env, created.ChannelID, created.MinterToken, AppendMessageRequest{
		MessageID:  "msg_minter",
		Sender:     roleMinter,
		Recipient:  roleBrowser,
		Algorithm:  algorithm,
		AAD:        "aad-minter",
		Nonce:      "nonce-minter",
		Ciphertext: "ciphertext-minter",
	})
	if minterAppend.Seq != 2 {
		t.Fatalf("minter append seq = %d, want 2", minterAppend.Seq)
	}

	browserPoll := pollMessages(t, env, created.ChannelID, joined.BrowserToken, 0)
	if len(browserPoll.Messages) != 1 || browserPoll.Messages[0].MessageID != "msg_minter" {
		t.Fatalf("browser poll messages = %+v", browserPoll.Messages)
	}
}

func TestTTLOnlyExtendsOnAcceptedMessages(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	initialExpiresAt := created.ExpiresAt

	*env.clock = env.clock.Add(5 * time.Second)
	joined := joinWithPairingToken(t, env, created)
	if joined.ExpiresAt != initialExpiresAt {
		t.Fatalf("join extended TTL: got %s, want %s", joined.ExpiresAt, initialExpiresAt)
	}

	*env.clock = env.clock.Add(2 * time.Second)
	appendResponse := appendMessage(t, env, created.ChannelID, joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_ttl",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	})
	expectedAfterAppend := formatTime(env.clock.Add(15 * time.Second))
	if appendResponse.ExpiresAt != expectedAfterAppend {
		t.Fatalf("append expiresAt = %s, want %s", appendResponse.ExpiresAt, expectedAfterAppend)
	}

	*env.clock = env.clock.Add(3 * time.Second)
	pollResponse := pollMessages(t, env, created.ChannelID, created.MinterToken, 0)
	if pollResponse.ExpiresAt != appendResponse.ExpiresAt {
		t.Fatalf("poll extended TTL: got %s, want %s", pollResponse.ExpiresAt, appendResponse.ExpiresAt)
	}
}

func TestExpiredChannelRejectsMessages(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)
	*env.clock = env.clock.Add(16 * time.Second)

	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_expired",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	}, nil)
	if status != http.StatusGone || errCode != "expired" {
		t.Fatalf("expired append status/error = %d/%q, want 410/expired", status, errCode)
	}
}

func TestOversizedPayloadRejected(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_large",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: strings.Repeat("x", maxEncryptedPayloadBytes+1),
	}, nil)
	if status != http.StatusRequestEntityTooLarge || errCode != "payload_too_large" {
		t.Fatalf("oversized append status/error = %d/%q, want 413/payload_too_large", status, errCode)
	}
}

func TestShortCodeResolve(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)

	var resolved ResolvePairingCodeResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{
		ShortCode: created.ShortCode,
	}, &resolved)
	if status != http.StatusOK || errCode != "" {
		t.Fatalf("resolve status/error = %d/%q, want 200", status, errCode)
	}
	if resolved.ChannelID != created.ChannelID || resolved.Algorithm != algorithm {
		t.Fatalf("resolved response = %+v, created channel = %s", resolved, created.ChannelID)
	}
	if !bytes.Equal(resolved.MinterPublicKeyJWK, testPublicJWK) {
		t.Fatalf("resolved public key mismatch: %s", resolved.MinterPublicKeyJWK)
	}
}

func TestCloseChannel(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)
	joined := joinWithPairingToken(t, env, created)

	status, errCode := deleteJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID, joined.BrowserToken)
	if status != http.StatusOK || errCode != "" {
		t.Fatalf("close status/error = %d/%q, want 200", status, errCode)
	}

	status, errCode = postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_closed",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	}, nil)
	if status != http.StatusConflict || errCode != "closed" {
		t.Fatalf("closed append status/error = %d/%q, want 409/closed", status, errCode)
	}
}

func createChannel(t *testing.T, env *testEnv, shortCodeRequested bool) CreateChannelResponse {
	t.Helper()
	var response CreateChannelResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/channels", "", CreateChannelRequest{
		Algorithm:          algorithm,
		MinterPublicKeyJWK: testPublicJWK,
		IdleTTLSeconds:     15,
		ShortCodeRequested: shortCodeRequested,
	}, &response)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("create status/error = %d/%q, want 201", status, errCode)
	}
	return response
}

func joinWithPairingToken(t *testing.T, env *testEnv, created CreateChannelResponse) JoinChannelResponse {
	t.Helper()
	var response JoinChannelResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/join", "", JoinChannelRequest{
		PairingToken:        created.PairingToken,
		BrowserPublicKeyJWK: testPublicJWK,
		Origin:              "https://nft.example",
		BrowserInfo:         json.RawMessage(`{"name":"Chrome","userAgent":"test"}`),
	}, &response)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("join status/error = %d/%q, want 201", status, errCode)
	}
	return response
}

func appendMessage(t *testing.T, env *testEnv, channelID, token string, req AppendMessageRequest) AppendMessageResponse {
	t.Helper()
	var response AppendMessageResponse
	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+channelID+"/messages", token, req, &response)
	if status != http.StatusCreated || errCode != "" {
		t.Fatalf("append status/error = %d/%q, want 201", status, errCode)
	}
	return response
}

func pollMessages(t *testing.T, env *testEnv, channelID, token string, afterSeq uint64) PollMessagesResponse {
	t.Helper()
	var response PollMessagesResponse
	req, err := http.NewRequest(http.MethodGet, env.server.URL+"/v1/channels/"+channelID+"/messages?afterSeq="+strconvUint(afterSeq), nil)
	if err != nil {
		t.Fatalf("new poll request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	status, errCode := doJSON(t, req, &response)
	if status != http.StatusOK || errCode != "" {
		t.Fatalf("poll status/error = %d/%q, want 200", status, errCode)
	}
	return response
}

func postJSON(t *testing.T, url, token string, body any, out any) (int, string) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("new post request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return doJSON(t, req, out)
}

func deleteJSON(t *testing.T, url, token string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		t.Fatalf("new delete request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return doJSON(t, req, nil)
}

func doJSON(t *testing.T, req *http.Request, out any) (int, string) {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("http request: %v", err)
	}
	defer resp.Body.Close()
	var errorBody struct {
		Error string `json:"error"`
	}
	if resp.StatusCode >= 400 {
		if err := json.NewDecoder(resp.Body).Decode(&errorBody); err != nil {
			t.Fatalf("decode error response: %v", err)
		}
		return resp.StatusCode, errorBody.Error
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("decode response: %v", err)
		}
	}
	return resp.StatusCode, ""
}

func strconvUint(value uint64) string {
	return strconv.FormatUint(value, 10)
}
