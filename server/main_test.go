package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

var testPublicJWK = json.RawMessage(`{"kty":"EC","crv":"P-256","x":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","y":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`)

type testEnv struct {
	broker *Broker
	server *httptest.Server
	clock  *time.Time
	dbPath string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	start := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	env := &testEnv{
		clock:  &start,
		dbPath: filepath.Join(t.TempDir(), "broker.db"),
	}
	broker, err := NewBroker(Config{
		DBPath:        env.dbPath,
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

func (env *testEnv) restart(t *testing.T) {
	t.Helper()
	env.server.Close()
	if err := env.broker.Close(); err != nil {
		t.Fatalf("close broker before restart: %v", err)
	}
	broker, err := NewBroker(Config{
		DBPath:        env.dbPath,
		BrokerBaseURL: "https://pairing.test",
		Now: func() time.Time {
			return *env.clock
		},
	})
	if err != nil {
		t.Fatalf("restart broker: %v", err)
	}
	env.broker = broker
	env.server = httptest.NewServer(broker)
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

func TestDuplicateMessageRejected(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	req := AppendMessageRequest{
		MessageID:  "msg_duplicate",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	}
	first := appendMessage(t, env, created.ChannelID, joined.BrowserToken, req)
	if first.Seq != 1 {
		t.Fatalf("first append seq = %d, want 1", first.Seq)
	}

	status, errCode := postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, req, nil)
	if status != http.StatusConflict || errCode != "duplicate_message" {
		t.Fatalf("duplicate append status/error = %d/%q, want 409/duplicate_message", status, errCode)
	}

	minterAppend := appendMessage(t, env, created.ChannelID, created.MinterToken, AppendMessageRequest{
		MessageID:  "msg_duplicate",
		Sender:     roleMinter,
		Recipient:  roleBrowser,
		Algorithm:  algorithm,
		AAD:        "aad-minter",
		Nonce:      "nonce-minter",
		Ciphertext: "ciphertext-minter",
	})
	if minterAppend.Seq != 2 {
		t.Fatalf("opposite sender duplicate messageId seq = %d, want 2", minterAppend.Seq)
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

func TestPollExpiryPersistsAfterRestart(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)
	*env.clock = env.clock.Add(16 * time.Second)

	status, errCode := getJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages?afterSeq=0", created.MinterToken, nil)
	if status != http.StatusGone || errCode != "expired" {
		t.Fatalf("expired poll status/error = %d/%q, want 410/expired", status, errCode)
	}
	if got := channelStatus(t, env, created.ChannelID); got != statusExpired {
		t.Fatalf("channel status after expired poll = %q, want %q", got, statusExpired)
	}

	env.restart(t)
	if got := channelStatus(t, env, created.ChannelID); got != statusExpired {
		t.Fatalf("channel status after restart = %q, want %q", got, statusExpired)
	}
	status, errCode = postJSON(t, env.server.URL+"/v1/channels/"+created.ChannelID+"/messages", joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_after_expiry",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	}, nil)
	if status != http.StatusGone || errCode != "expired" {
		t.Fatalf("append after persisted expiry status/error = %d/%q, want 410/expired", status, errCode)
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

func TestShortCodeResolveAggregateRateLimitPersistsAcrossRestart(t *testing.T) {
	env := newTestEnv(t)
	for i := 0; i < shortCodeAttemptLimit; i++ {
		code := fmt.Sprintf("%06d", i)
		status, errCode := postJSON(t, env.server.URL+"/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{
			ShortCode: code,
		}, nil)
		if status != http.StatusNotFound || errCode != "not_found" {
			t.Fatalf("resolve miss %d status/error = %d/%q, want 404/not_found", i, status, errCode)
		}
	}

	env.restart(t)
	status, errCode := postJSON(t, env.server.URL+"/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{
		ShortCode: "999999",
	}, nil)
	if status != http.StatusTooManyRequests || errCode != "rate_limited" {
		t.Fatalf("aggregate limited resolve status/error = %d/%q, want 429/rate_limited", status, errCode)
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

func TestCleanupRemovesExpiredChannelAfterRestart(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, true)
	*env.clock = env.clock.Add(16 * time.Second)
	env.restart(t)

	if err := env.broker.cleanupExpiredChannels(*env.clock, cleanupBatchLimit); err != nil {
		t.Fatalf("cleanup expired channels: %v", err)
	}
	if channelExists(t, env, created.ChannelID) {
		t.Fatalf("expired channel %s still exists after cleanup", created.ChannelID)
	}

	status, errCode := postJSON(t, env.server.URL+"/v1/pairing-codes/resolve", "", ResolvePairingCodeRequest{
		ShortCode: created.ShortCode,
	}, nil)
	if status != http.StatusNotFound || errCode != "not_found" {
		t.Fatalf("resolve cleaned short code status/error = %d/%q, want 404/not_found", status, errCode)
	}
}

func TestCleanupIgnoresStaleExpiryIndexUntilCurrentExpiry(t *testing.T) {
	env := newTestEnv(t)
	created := createChannel(t, env, false)
	joined := joinWithPairingToken(t, env, created)

	*env.clock = env.clock.Add(5 * time.Second)
	appendResponse := appendMessage(t, env, created.ChannelID, joined.BrowserToken, AppendMessageRequest{
		MessageID:  "msg_extend_expiry",
		Sender:     roleBrowser,
		Recipient:  roleMinter,
		Algorithm:  algorithm,
		AAD:        "aad",
		Nonce:      "nonce",
		Ciphertext: "ciphertext",
	})

	*env.clock = env.clock.Add(11 * time.Second)
	if err := env.broker.cleanupExpiredChannels(*env.clock, cleanupBatchLimit); err != nil {
		t.Fatalf("cleanup stale expiry: %v", err)
	}
	if !channelExists(t, env, created.ChannelID) {
		t.Fatalf("channel was removed at stale initial expiry")
	}

	expiresAt, err := time.Parse(time.RFC3339Nano, appendResponse.ExpiresAt)
	if err != nil {
		t.Fatalf("parse append expiresAt: %v", err)
	}
	*env.clock = expiresAt.Add(time.Second)
	if err := env.broker.cleanupExpiredChannels(*env.clock, cleanupBatchLimit); err != nil {
		t.Fatalf("cleanup current expiry: %v", err)
	}
	if channelExists(t, env, created.ChannelID) {
		t.Fatalf("channel still exists after current expiry cleanup")
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

func channelStatus(t *testing.T, env *testEnv, channelID string) string {
	t.Helper()
	var status string
	err := env.broker.db.View(func(tx *bolt.Tx) error {
		_, metaBucket, _, _, ok := channelBuckets(tx, channelID)
		if !ok {
			return fmt.Errorf("channel %s not found", channelID)
		}
		record, err := loadChannelRecord(metaBucket)
		if err != nil {
			return err
		}
		status = record.Status
		return nil
	})
	if err != nil {
		t.Fatalf("read channel status: %v", err)
	}
	return status
}

func channelExists(t *testing.T, env *testEnv, channelID string) bool {
	t.Helper()
	var exists bool
	err := env.broker.db.View(func(tx *bolt.Tx) error {
		channels := tx.Bucket([]byte(bucketChannels))
		exists = channels != nil && channels.Bucket([]byte(channelID)) != nil
		return nil
	})
	if err != nil {
		t.Fatalf("read channel existence: %v", err)
	}
	return exists
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

func getJSON(t *testing.T, url, token string, out any) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("new get request: %v", err)
	}
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
