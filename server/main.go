package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	algorithm = "P256-HKDF-SHA256-AES-256-GCM"

	defaultAddr           = ":8080"
	defaultDBPath         = "/data/mint-pairing.db"
	defaultIdleTTLSeconds = 300
	minIdleTTLSeconds     = 15
	maxIdleTTLSeconds     = 300

	maxRequestBodyBytes      = 96 * 1024
	maxEncryptedPayloadBytes = 64 * 1024
	maxPublicKeyJWKBytes     = 8 * 1024
	maxBrowserInfoBytes      = 8 * 1024
	maxOriginBytes           = 2048
	maxMessageIDBytes        = 128
	maxAADBytes              = 8 * 1024
	maxNonceBytes            = 512
	maxPollMessages          = 100

	shortCodeDigits       = 6
	shortCodeAttemptLimit = 8
	shortCodeWindow       = time.Minute
	shortCodeLockout      = 5 * time.Minute
	cleanupBatchLimit     = 100

	statusWaiting = "waiting"
	statusPaired  = "paired"
	statusClosed  = "closed"
	statusExpired = "expired"

	roleBrowser = "browser"
	roleMinter  = "minter"

	bucketMeta              = "meta"
	bucketChannels          = "channels"
	bucketPairingTokens     = "pairing_tokens"
	bucketShortCodes        = "short_codes"
	bucketShortCodeAttempts = "short_code_attempts"
	bucketCleanupByExpiry   = "cleanup_by_expiry"

	channelBucketMeta         = "meta"
	channelBucketParticipants = "participants"
	channelBucketMessages     = "messages"
	recordKey                 = "record"
	schemaVersionKey          = "schema_version"
)

var errUnauthorized = errors.New("unauthorized")

type Config struct {
	Addr          string
	DBPath        string
	BrokerBaseURL string
	Now           func() time.Time
}

type Broker struct {
	db            *bolt.DB
	brokerBaseURL string
	now           func() time.Time
}

type ChannelRecord struct {
	ChannelID             string          `json:"channelId"`
	Version               int             `json:"version"`
	Status                string          `json:"status"`
	Algorithm             string          `json:"algorithm"`
	CreatedAt             string          `json:"createdAt"`
	PairedAt              string          `json:"pairedAt,omitempty"`
	LastMessageAt         string          `json:"lastMessageAt"`
	ExpiresAt             string          `json:"expiresAt"`
	IdleTTLSeconds        int             `json:"idleTtlSeconds"`
	MinterPublicKeyJWK    json.RawMessage `json:"minterPublicKeyJwk"`
	BrowserPublicKeyJWK   json.RawMessage `json:"browserPublicKeyJwk,omitempty"`
	PairingTokenHash      string          `json:"pairingTokenHash"`
	PairingConsumedAt     string          `json:"pairingConsumedAt,omitempty"`
	ShortCodeHash         string          `json:"shortCodeHash,omitempty"`
	ShortCodeAttemptCount int             `json:"shortCodeAttemptCount"`
}

type ParticipantRecord struct {
	ChannelID string `json:"channelId"`
	Role      string `json:"role"`
	TokenHash string `json:"tokenHash"`
	CreatedAt string `json:"createdAt"`
	RevokedAt string `json:"revokedAt,omitempty"`
}

type MessageRecord struct {
	ChannelID          string          `json:"channelId"`
	Seq                uint64          `json:"seq"`
	MessageID          string          `json:"messageId"`
	Sender             string          `json:"sender"`
	Recipient          string          `json:"recipient"`
	CreatedAt          string          `json:"createdAt"`
	Algorithm          string          `json:"algorithm"`
	AAD                string          `json:"aad"`
	Nonce              string          `json:"nonce"`
	Ciphertext         string          `json:"ciphertext"`
	SenderPublicKeyJWK json.RawMessage `json:"senderPublicKeyJwk,omitempty"`
	SizeBytes          int             `json:"sizeBytes"`
}

type CreateChannelRequest struct {
	Algorithm          string          `json:"algorithm"`
	MinterPublicKeyJWK json.RawMessage `json:"minterPublicKeyJwk"`
	IdleTTLSeconds     int             `json:"idleTtlSeconds"`
	ShortCodeRequested bool            `json:"shortCodeRequested"`
}

type CreateChannelResponse struct {
	ChannelID    string          `json:"channelId"`
	MinterToken  string          `json:"minterToken"`
	PairingToken string          `json:"pairingToken"`
	ShortCode    string          `json:"shortCode,omitempty"`
	ExpiresAt    string          `json:"expiresAt"`
	QRPayload    json.RawMessage `json:"qrPayload"`
}

type JoinChannelRequest struct {
	PairingToken        string          `json:"pairingToken,omitempty"`
	ShortCode           string          `json:"shortCode,omitempty"`
	BrowserPublicKeyJWK json.RawMessage `json:"browserPublicKeyJwk"`
	Origin              string          `json:"origin,omitempty"`
	BrowserInfo         json.RawMessage `json:"browserInfo,omitempty"`
}

type JoinChannelResponse struct {
	ChannelID          string          `json:"channelId"`
	BrowserToken       string          `json:"browserToken"`
	Algorithm          string          `json:"algorithm"`
	MinterPublicKeyJWK json.RawMessage `json:"minterPublicKeyJwk"`
	ExpiresAt          string          `json:"expiresAt"`
	NextSeq            uint64          `json:"nextSeq"`
}

type ResolvePairingCodeRequest struct {
	ShortCode string `json:"shortCode"`
}

type ResolvePairingCodeResponse struct {
	ChannelID          string          `json:"channelId"`
	Algorithm          string          `json:"algorithm"`
	MinterPublicKeyJWK json.RawMessage `json:"minterPublicKeyJwk"`
	ExpiresAt          string          `json:"expiresAt"`
}

type AppendMessageRequest struct {
	MessageID          string          `json:"messageId"`
	Sender             string          `json:"sender"`
	Recipient          string          `json:"recipient"`
	Algorithm          string          `json:"algorithm"`
	AAD                string          `json:"aad"`
	Nonce              string          `json:"nonce"`
	Ciphertext         string          `json:"ciphertext"`
	SenderPublicKeyJWK json.RawMessage `json:"senderPublicKeyJwk,omitempty"`
}

type AppendMessageResponse struct {
	ChannelID string `json:"channelId"`
	Seq       uint64 `json:"seq"`
	ExpiresAt string `json:"expiresAt"`
}

type PollMessagesResponse struct {
	ChannelID string          `json:"channelId"`
	ExpiresAt string          `json:"expiresAt"`
	Messages  []MessageRecord `json:"messages"`
}

type shortCodeAttemptRecord struct {
	Count       int    `json:"count"`
	WindowStart string `json:"windowStart"`
	LockedUntil string `json:"lockedUntil,omitempty"`
}

func main() {
	cfg := Config{
		Addr:          getenv("ADDR", defaultAddr),
		DBPath:        getenv("BROKER_DB_PATH", defaultDBPath),
		BrokerBaseURL: os.Getenv("BROKER_BASE_URL"),
	}
	broker, err := NewBroker(cfg)
	if err != nil {
		log.Fatalf("open broker: %v", err)
	}
	defer broker.Close()

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           broker,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("mint pairing broker listening on %s", cfg.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

func NewBroker(cfg Config) (*Broker, error) {
	dbPath := cfg.DBPath
	if dbPath == "" {
		dbPath = defaultDBPath
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	db, err := bolt.Open(dbPath, 0o600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	b := &Broker{
		db:            db,
		brokerBaseURL: strings.TrimRight(cfg.BrokerBaseURL, "/"),
		now:           cfg.Now,
	}
	if b.now == nil {
		b.now = time.Now
	}
	if err := b.initDB(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return b, nil
}

func (b *Broker) Close() error {
	return b.db.Close()
}

func (b *Broker) initDB() error {
	return b.db.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{
			[]byte(bucketMeta),
			[]byte(bucketChannels),
			[]byte(bucketPairingTokens),
			[]byte(bucketShortCodes),
			[]byte(bucketShortCodeAttempts),
			[]byte(bucketCleanupByExpiry),
		} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return err
			}
		}
		return tx.Bucket([]byte(bucketMeta)).Put([]byte(schemaVersionKey), []byte("1"))
	})
}

func (b *Broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	addCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, struct {
			OK bool `json:"ok"`
		}{OK: true})
		return
	}
	if r.URL.Path == "/v1/channels" && r.Method == http.MethodPost {
		b.handleCreateChannel(w, r)
		return
	}
	if r.URL.Path == "/v1/pairing-codes/resolve" && r.Method == http.MethodPost {
		b.handleResolvePairingCode(w, r)
		return
	}

	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) >= 3 && parts[0] == "v1" && parts[1] == "channels" {
		channelID := parts[2]
		if !validPrefixedID(channelID, "ch_") {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
		if len(parts) == 3 && r.Method == http.MethodDelete {
			b.handleCloseChannel(w, r, channelID)
			return
		}
		if len(parts) == 4 && parts[3] == "join" && r.Method == http.MethodPost {
			b.handleJoinChannel(w, r, channelID)
			return
		}
		if len(parts) == 4 && parts[3] == "messages" {
			switch r.Method {
			case http.MethodPost:
				b.handleAppendMessage(w, r, channelID)
			case http.MethodGet:
				b.handlePollMessages(w, r, channelID)
			default:
				writeError(w, http.StatusMethodNotAllowed, "invalid_request")
			}
			return
		}
	}
	writeError(w, http.StatusNotFound, "not_found")
}

func (b *Broker) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	if err := b.cleanupExpiredChannels(b.now().UTC(), cleanupBatchLimit); err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}

	var req CreateChannelRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if req.Algorithm != algorithm || !validJSONObject(req.MinterPublicKeyJWK, maxPublicKeyJWKBytes) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if req.IdleTTLSeconds == 0 {
		req.IdleTTLSeconds = defaultIdleTTLSeconds
	}
	if req.IdleTTLSeconds < minIdleTTLSeconds || req.IdleTTLSeconds > maxIdleTTLSeconds {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}

	channelID, minterToken, pairingToken, err := newChannelMaterial()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}
	now := b.now().UTC()
	expiresAt := now.Add(time.Duration(req.IdleTTLSeconds) * time.Second)
	record := ChannelRecord{
		ChannelID:          channelID,
		Version:            1,
		Status:             statusWaiting,
		Algorithm:          algorithm,
		CreatedAt:          formatTime(now),
		LastMessageAt:      formatTime(now),
		ExpiresAt:          formatTime(expiresAt),
		IdleTTLSeconds:     req.IdleTTLSeconds,
		MinterPublicKeyJWK: cloneRaw(req.MinterPublicKeyJWK),
		PairingTokenHash:   hashString(pairingToken),
	}

	var shortCode string
	if err := b.db.Update(func(tx *bolt.Tx) error {
		channels := tx.Bucket([]byte(bucketChannels))
		if existing := channels.Bucket([]byte(channelID)); existing != nil {
			return errors.New("channel id collision")
		}
		channel, err := channels.CreateBucket([]byte(channelID))
		if err != nil {
			return err
		}
		metaBucket, err := channel.CreateBucket([]byte(channelBucketMeta))
		if err != nil {
			return err
		}
		participantsBucket, err := channel.CreateBucket([]byte(channelBucketParticipants))
		if err != nil {
			return err
		}
		if _, err := channel.CreateBucket([]byte(channelBucketMessages)); err != nil {
			return err
		}
		if req.ShortCodeRequested {
			shortCode, err = generateUniqueShortCode(tx)
			if err != nil {
				return err
			}
			record.ShortCodeHash = hashString(shortCode)
			if err := tx.Bucket([]byte(bucketShortCodes)).Put([]byte(record.ShortCodeHash), []byte(channelID)); err != nil {
				return err
			}
		}
		if err := putJSON(metaBucket, []byte(recordKey), record); err != nil {
			return err
		}
		minter := ParticipantRecord{
			ChannelID: channelID,
			Role:      roleMinter,
			TokenHash: hashString(minterToken),
			CreatedAt: formatTime(now),
		}
		if err := putJSON(participantsBucket, []byte(roleMinter), minter); err != nil {
			return err
		}
		if err := tx.Bucket([]byte(bucketPairingTokens)).Put([]byte(record.PairingTokenHash), []byte(channelID)); err != nil {
			return err
		}
		return tx.Bucket([]byte(bucketCleanupByExpiry)).Put(cleanupKey(expiresAt, channelID), nil)
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}

	qrPayload, err := json.Marshal(struct {
		Version            int             `json:"v"`
		Type               string          `json:"type"`
		BrokerBaseURL      string          `json:"brokerBaseUrl"`
		ChannelID          string          `json:"channelId"`
		PairingToken       string          `json:"pairingToken"`
		ShortCode          string          `json:"shortCode,omitempty"`
		ExpiresAt          string          `json:"expiresAt"`
		Algorithm          string          `json:"algorithm"`
		MinterPublicKeyJWK json.RawMessage `json:"minterPublicKeyJwk"`
	}{
		Version:            1,
		Type:               "ff-mint-pairing",
		BrokerBaseURL:      b.baseURL(r),
		ChannelID:          channelID,
		PairingToken:       pairingToken,
		ShortCode:          shortCode,
		ExpiresAt:          record.ExpiresAt,
		Algorithm:          algorithm,
		MinterPublicKeyJWK: record.MinterPublicKeyJWK,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}

	writeJSON(w, http.StatusCreated, CreateChannelResponse{
		ChannelID:    channelID,
		MinterToken:  minterToken,
		PairingToken: pairingToken,
		ShortCode:    shortCode,
		ExpiresAt:    record.ExpiresAt,
		QRPayload:    qrPayload,
	})
}

func (b *Broker) handleJoinChannel(w http.ResponseWriter, r *http.Request, channelID string) {
	var req JoinChannelRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !validJSONObject(req.BrowserPublicKeyJWK, maxPublicKeyJWKBytes) || !validJoinCredential(req) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !validOptionalOrigin(req.Origin) || !validOptionalJSONObject(req.BrowserInfo, maxBrowserInfoBytes) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}

	browserToken, err := randomToken("bt_", 32)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}
	now := b.now().UTC()
	var response JoinChannelResponse
	var status int
	var code string
	err = b.db.Update(func(tx *bolt.Tx) error {
		channel, metaBucket, participantsBucket, _, ok := channelBuckets(tx, channelID)
		if !ok {
			status, code = http.StatusNotFound, "not_found"
			return nil
		}
		_ = channel
		record, err := loadChannelRecord(metaBucket)
		if err != nil {
			return err
		}
		expired, err := markExpiredIfNeeded(tx, metaBucket, &record, now)
		if err != nil {
			return err
		}
		if expired {
			status, code = http.StatusGone, "expired"
			return nil
		}
		if record.Status != statusWaiting || record.PairingConsumedAt != "" {
			status, code = http.StatusUnauthorized, "unauthorized"
			return nil
		}
		credentialMatches := joinCredentialMatches(tx, record, channelID, req)
		if req.ShortCode != "" {
			attemptKey := shortCodeJoinAttemptKey(channelID)
			limited, err := rateLimitAttempt(tx, attemptKey, now)
			if err != nil {
				return err
			}
			if limited {
				status, code = http.StatusTooManyRequests, "rate_limited"
				return nil
			}
			if !credentialMatches {
				record.ShortCodeAttemptCount++
				if err := putJSON(metaBucket, []byte(recordKey), record); err != nil {
					return err
				}
				if err := recordAttemptMiss(tx, attemptKey, now); err != nil {
					return err
				}
				status, code = http.StatusUnauthorized, "unauthorized"
				return nil
			}
		} else if !credentialMatches {
			status, code = http.StatusUnauthorized, "unauthorized"
			return nil
		}
		if participantsBucket.Get([]byte(roleBrowser)) != nil {
			status, code = http.StatusUnauthorized, "unauthorized"
			return nil
		}
		record.Status = statusPaired
		record.PairedAt = formatTime(now)
		record.PairingConsumedAt = formatTime(now)
		record.BrowserPublicKeyJWK = cloneRaw(req.BrowserPublicKeyJWK)
		if err := putJSON(metaBucket, []byte(recordKey), record); err != nil {
			return err
		}
		browser := ParticipantRecord{
			ChannelID: channelID,
			Role:      roleBrowser,
			TokenHash: hashString(browserToken),
			CreatedAt: formatTime(now),
		}
		if err := putJSON(participantsBucket, []byte(roleBrowser), browser); err != nil {
			return err
		}
		if err := tx.Bucket([]byte(bucketPairingTokens)).Delete([]byte(record.PairingTokenHash)); err != nil {
			return err
		}
		if record.ShortCodeHash != "" {
			if err := tx.Bucket([]byte(bucketShortCodes)).Delete([]byte(record.ShortCodeHash)); err != nil {
				return err
			}
		}
		if req.ShortCode != "" {
			if err := tx.Bucket([]byte(bucketShortCodeAttempts)).Delete([]byte(shortCodeJoinAttemptKey(channelID))); err != nil {
				return err
			}
		}
		response = JoinChannelResponse{
			ChannelID:          channelID,
			BrowserToken:       browserToken,
			Algorithm:          record.Algorithm,
			MinterPublicKeyJWK: cloneRaw(record.MinterPublicKeyJWK),
			ExpiresAt:          record.ExpiresAt,
			NextSeq:            1,
		}
		return nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}
	if code != "" {
		writeError(w, status, code)
		return
	}
	writeJSON(w, http.StatusCreated, response)
}

func (b *Broker) handleResolvePairingCode(w http.ResponseWriter, r *http.Request) {
	var req ResolvePairingCodeRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if !validShortCode(req.ShortCode) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}

	now := b.now().UTC()
	shortCodeHash := hashString(req.ShortCode)
	var response ResolvePairingCodeResponse
	var status int
	var code string
	err := b.db.Update(func(tx *bolt.Tx) error {
		attemptKey := shortCodeResolveAttemptKey(shortCodeHash)
		aggregateAttemptKey := shortCodeResolveAggregateAttemptKey()
		if limited, err := rateLimitAttempt(tx, aggregateAttemptKey, now); err != nil {
			return err
		} else if limited {
			status, code = http.StatusTooManyRequests, "rate_limited"
			return nil
		}
		if limited, err := rateLimitAttempt(tx, attemptKey, now); err != nil {
			return err
		} else if limited {
			status, code = http.StatusTooManyRequests, "rate_limited"
			return nil
		}
		channelIDBytes := tx.Bucket([]byte(bucketShortCodes)).Get([]byte(shortCodeHash))
		if channelIDBytes == nil {
			if err := recordAttemptMiss(tx, aggregateAttemptKey, now); err != nil {
				return err
			}
			if err := recordAttemptMiss(tx, attemptKey, now); err != nil {
				return err
			}
			status, code = http.StatusNotFound, "not_found"
			return nil
		}
		channelID := string(channelIDBytes)
		_, metaBucket, _, _, ok := channelBuckets(tx, channelID)
		if !ok {
			status, code = http.StatusNotFound, "not_found"
			return nil
		}
		record, err := loadChannelRecord(metaBucket)
		if err != nil {
			return err
		}
		expired, err := markExpiredIfNeeded(tx, metaBucket, &record, now)
		if err != nil {
			return err
		}
		if expired {
			status, code = http.StatusGone, "expired"
			return nil
		}
		if record.Status != statusWaiting {
			status, code = http.StatusUnauthorized, "unauthorized"
			return nil
		}
		if err := tx.Bucket([]byte(bucketShortCodeAttempts)).Delete([]byte(attemptKey)); err != nil {
			return err
		}
		response = ResolvePairingCodeResponse{
			ChannelID:          channelID,
			Algorithm:          record.Algorithm,
			MinterPublicKeyJWK: cloneRaw(record.MinterPublicKeyJWK),
			ExpiresAt:          record.ExpiresAt,
		}
		return nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}
	if code != "" {
		writeError(w, status, code)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (b *Broker) handleAppendMessage(w http.ResponseWriter, r *http.Request, channelID string) {
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req AppendMessageRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	payloadSize, valid := validateMessageRequest(req)
	if !valid {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if payloadSize > maxEncryptedPayloadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large")
		return
	}

	now := b.now().UTC()
	var response AppendMessageResponse
	var status int
	var code string
	err := b.db.Update(func(tx *bolt.Tx) error {
		_, metaBucket, participantsBucket, messagesBucket, ok := channelBuckets(tx, channelID)
		if !ok {
			status, code = http.StatusNotFound, "not_found"
			return nil
		}
		record, err := loadChannelRecord(metaBucket)
		if err != nil {
			return err
		}
		role, err := authorizeParticipant(participantsBucket, token)
		if err != nil {
			status, code = http.StatusUnauthorized, "unauthorized"
			return nil
		}
		if req.Sender != role || req.Recipient != oppositeRole(role) {
			status, code = http.StatusUnauthorized, "unauthorized"
			return nil
		}
		expired, err := markExpiredIfNeeded(tx, metaBucket, &record, now)
		if err != nil {
			return err
		}
		if expired {
			status, code = http.StatusGone, "expired"
			return nil
		}
		if record.Status == statusClosed {
			status, code = http.StatusConflict, "closed"
			return nil
		}
		if record.Status != statusPaired {
			status, code = http.StatusUnauthorized, "unauthorized"
			return nil
		}
		duplicate, err := duplicateMessageExists(messagesBucket, req.Sender, req.MessageID)
		if err != nil {
			return err
		}
		if duplicate {
			status, code = http.StatusConflict, "duplicate_message"
			return nil
		}
		seq, err := messagesBucket.NextSequence()
		if err != nil {
			return err
		}
		expiresAt := now.Add(time.Duration(record.IdleTTLSeconds) * time.Second)
		msg := MessageRecord{
			ChannelID:          channelID,
			Seq:                seq,
			MessageID:          req.MessageID,
			Sender:             req.Sender,
			Recipient:          req.Recipient,
			CreatedAt:          formatTime(now),
			Algorithm:          req.Algorithm,
			AAD:                req.AAD,
			Nonce:              req.Nonce,
			Ciphertext:         req.Ciphertext,
			SenderPublicKeyJWK: cloneRaw(req.SenderPublicKeyJWK),
			SizeBytes:          payloadSize,
		}
		if err := putJSON(messagesBucket, uint64Key(seq), msg); err != nil {
			return err
		}
		record.LastMessageAt = formatTime(now)
		record.ExpiresAt = formatTime(expiresAt)
		if err := putJSON(metaBucket, []byte(recordKey), record); err != nil {
			return err
		}
		if err := tx.Bucket([]byte(bucketCleanupByExpiry)).Put(cleanupKey(expiresAt, channelID), nil); err != nil {
			return err
		}
		response = AppendMessageResponse{
			ChannelID: channelID,
			Seq:       seq,
			ExpiresAt: record.ExpiresAt,
		}
		return nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}
	if code != "" {
		writeError(w, status, code)
		return
	}
	writeJSON(w, http.StatusCreated, response)
}

func (b *Broker) handlePollMessages(w http.ResponseWriter, r *http.Request, channelID string) {
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	afterSeq, err := parseAfterSeq(r.URL.Query().Get("afterSeq"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}

	now := b.now().UTC()
	var response PollMessagesResponse
	var status int
	var code string
	err = b.db.Update(func(tx *bolt.Tx) error {
		_, metaBucket, participantsBucket, messagesBucket, ok := channelBuckets(tx, channelID)
		if !ok {
			status, code = http.StatusNotFound, "not_found"
			return nil
		}
		record, err := loadChannelRecord(metaBucket)
		if err != nil {
			return err
		}
		role, err := authorizeParticipant(participantsBucket, token)
		if err != nil {
			status, code = http.StatusUnauthorized, "unauthorized"
			return nil
		}
		if record.Status == statusClosed {
			status, code = http.StatusConflict, "closed"
			return nil
		}
		expired, err := markExpiredIfNeeded(tx, metaBucket, &record, now)
		if err != nil {
			return err
		}
		if expired {
			status, code = http.StatusGone, "expired"
			return nil
		}
		response = PollMessagesResponse{
			ChannelID: channelID,
			ExpiresAt: record.ExpiresAt,
			Messages:  make([]MessageRecord, 0),
		}
		cursor := messagesBucket.Cursor()
		for key, value := cursor.Seek(uint64Key(afterSeq + 1)); key != nil && len(response.Messages) < maxPollMessages; key, value = cursor.Next() {
			var msg MessageRecord
			if err := json.Unmarshal(value, &msg); err != nil {
				return err
			}
			if msg.Recipient == role {
				response.Messages = append(response.Messages, msg)
			}
		}
		return nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}
	if code != "" {
		writeError(w, status, code)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (b *Broker) handleCloseChannel(w http.ResponseWriter, r *http.Request, channelID string) {
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	now := b.now().UTC()
	var status int
	var code string
	err := b.db.Update(func(tx *bolt.Tx) error {
		_, metaBucket, participantsBucket, _, ok := channelBuckets(tx, channelID)
		if !ok {
			status, code = http.StatusNotFound, "not_found"
			return nil
		}
		record, err := loadChannelRecord(metaBucket)
		if err != nil {
			return err
		}
		if _, err := authorizeParticipant(participantsBucket, token); err != nil {
			status, code = http.StatusUnauthorized, "unauthorized"
			return nil
		}
		record.Status = statusClosed
		record.PairingConsumedAt = firstNonEmpty(record.PairingConsumedAt, formatTime(now))
		if err := putJSON(metaBucket, []byte(recordKey), record); err != nil {
			return err
		}
		if err := tx.Bucket([]byte(bucketPairingTokens)).Delete([]byte(record.PairingTokenHash)); err != nil {
			return err
		}
		if record.ShortCodeHash != "" {
			if err := tx.Bucket([]byte(bucketShortCodes)).Delete([]byte(record.ShortCodeHash)); err != nil {
				return err
			}
		}
		return tx.Bucket([]byte(bucketCleanupByExpiry)).Put(cleanupKey(now, channelID), nil)
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request")
		return
	}
	if code != "" {
		writeError(w, status, code)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Status string `json:"status"`
	}{Status: statusClosed})
}

func (b *Broker) cleanupExpiredChannels(now time.Time, limit int) error {
	if limit <= 0 {
		return nil
	}
	return b.db.Update(func(tx *bolt.Tx) error {
		cleanup := tx.Bucket([]byte(bucketCleanupByExpiry))
		channels := tx.Bucket([]byte(bucketChannels))
		if cleanup == nil || channels == nil {
			return nil
		}
		cutoff := uint64(now.UnixMilli())
		cursor := cleanup.Cursor()
		processed := 0
		for key, _ := cursor.First(); key != nil && processed < limit; key, _ = cursor.First() {
			expiryMillis, channelID, ok := parseCleanupKey(key)
			if !ok {
				if err := cleanup.Delete(key); err != nil {
					return err
				}
				processed++
				continue
			}
			if expiryMillis > cutoff {
				return nil
			}
			if err := cleanup.Delete(key); err != nil {
				return err
			}
			channel := channels.Bucket([]byte(channelID))
			if channel == nil {
				processed++
				continue
			}
			meta := channel.Bucket([]byte(channelBucketMeta))
			if meta == nil {
				if err := channels.DeleteBucket([]byte(channelID)); err != nil {
					return err
				}
				processed++
				continue
			}
			record, err := loadChannelRecord(meta)
			if err != nil {
				return err
			}
			if shouldDeleteChannel(record, now) {
				if err := deleteChannelIndexes(tx, record); err != nil {
					return err
				}
				if err := channels.DeleteBucket([]byte(channelID)); err != nil {
					return err
				}
				processed++
				continue
			}
			currentExpiresAt, err := time.Parse(time.RFC3339Nano, record.ExpiresAt)
			if err != nil {
				return err
			}
			if err := cleanup.Put(cleanupKey(currentExpiresAt, channelID), nil); err != nil {
				return err
			}
			processed++
		}
		return nil
	})
}

func (b *Broker) baseURL(r *http.Request) string {
	if b.brokerBaseURL != "" {
		return b.brokerBaseURL
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if forwarded := r.Header.Get("X-Forwarded-Proto"); forwarded == "http" || forwarded == "https" {
		scheme = forwarded
	}
	return scheme + "://" + r.Host
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing json")
	}
	return nil
}

func addCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, struct {
		Error string `json:"error"`
	}{Error: code})
}

func validJSONObject(raw json.RawMessage, maxBytes int) bool {
	if len(raw) == 0 || len(raw) > maxBytes {
		return false
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return false
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return false
	}
	_, ok := value.(map[string]any)
	return ok
}

func validOptionalJSONObject(raw json.RawMessage, maxBytes int) bool {
	if len(raw) == 0 {
		return true
	}
	return validJSONObject(raw, maxBytes)
}

func validOptionalOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	if len(origin) > maxOriginBytes {
		return false
	}
	parsed, err := url.Parse(origin)
	return err == nil && parsed.Scheme != "" && parsed.Host != ""
}

func validJoinCredential(req JoinChannelRequest) bool {
	if req.PairingToken != "" && req.ShortCode != "" {
		return false
	}
	if req.PairingToken != "" {
		return strings.HasPrefix(req.PairingToken, "pt_") && len(req.PairingToken) <= 128
	}
	return validShortCode(req.ShortCode)
}

func validShortCode(code string) bool {
	if len(code) != shortCodeDigits {
		return false
	}
	for _, ch := range code {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func validateMessageRequest(req AppendMessageRequest) (int, bool) {
	if req.Algorithm != algorithm || !validRole(req.Sender) || !validRole(req.Recipient) || req.Sender == req.Recipient {
		return 0, false
	}
	if req.MessageID == "" || len(req.MessageID) > maxMessageIDBytes {
		return 0, false
	}
	if len(req.AAD) > maxAADBytes || len(req.Nonce) == 0 || len(req.Nonce) > maxNonceBytes || len(req.Ciphertext) == 0 {
		return 0, false
	}
	if len(req.SenderPublicKeyJWK) > 0 && !validJSONObject(req.SenderPublicKeyJWK, maxPublicKeyJWKBytes) {
		return 0, false
	}
	return len(req.AAD) + len(req.Nonce) + len(req.Ciphertext) + len(req.SenderPublicKeyJWK), true
}

func validRole(role string) bool {
	return role == roleBrowser || role == roleMinter
}

func oppositeRole(role string) string {
	if role == roleBrowser {
		return roleMinter
	}
	return roleBrowser
}

func bearerToken(header string) (string, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	return token, token != ""
}

func parseAfterSeq(raw string) (uint64, error) {
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, err
	}
	return value, nil
}

func validPrefixedID(value, prefix string) bool {
	if !strings.HasPrefix(value, prefix) || len(value) <= len(prefix) || len(value) > 96 {
		return false
	}
	for _, ch := range value[len(prefix):] {
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
			continue
		}
		return false
	}
	return true
}

func newChannelMaterial() (channelID, minterToken, pairingToken string, err error) {
	channelID, err = randomToken("ch_", 18)
	if err != nil {
		return "", "", "", err
	}
	minterToken, err = randomToken("mt_", 32)
	if err != nil {
		return "", "", "", err
	}
	pairingToken, err = randomToken("pt_", 32)
	if err != nil {
		return "", "", "", err
	}
	return channelID, minterToken, pairingToken, nil
}

func randomToken(prefix string, byteCount int) (string, error) {
	buf := make([]byte, byteCount)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

func generateUniqueShortCode(tx *bolt.Tx) (string, error) {
	shortCodes := tx.Bucket([]byte(bucketShortCodes))
	for i := 0; i < 32; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(1000000))
		if err != nil {
			return "", err
		}
		code := fmt.Sprintf("%06d", n.Int64())
		if shortCodes.Get([]byte(hashString(code))) == nil {
			return code, nil
		}
	}
	return "", errors.New("short code collision")
}

func hashString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func channelBuckets(tx *bolt.Tx, channelID string) (*bolt.Bucket, *bolt.Bucket, *bolt.Bucket, *bolt.Bucket, bool) {
	channels := tx.Bucket([]byte(bucketChannels))
	if channels == nil {
		return nil, nil, nil, nil, false
	}
	channel := channels.Bucket([]byte(channelID))
	if channel == nil {
		return nil, nil, nil, nil, false
	}
	meta := channel.Bucket([]byte(channelBucketMeta))
	participants := channel.Bucket([]byte(channelBucketParticipants))
	messages := channel.Bucket([]byte(channelBucketMessages))
	if meta == nil || participants == nil || messages == nil {
		return nil, nil, nil, nil, false
	}
	return channel, meta, participants, messages, true
}

func loadChannelRecord(meta *bolt.Bucket) (ChannelRecord, error) {
	var record ChannelRecord
	raw := meta.Get([]byte(recordKey))
	if raw == nil {
		return record, errors.New("missing channel record")
	}
	if err := json.Unmarshal(raw, &record); err != nil {
		return record, err
	}
	return record, nil
}

func putJSON(bucket *bolt.Bucket, key []byte, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return bucket.Put(key, raw)
}

func authorizeParticipant(participants *bolt.Bucket, token string) (string, error) {
	tokenHash := hashString(token)
	for _, role := range []string{roleBrowser, roleMinter} {
		raw := participants.Get([]byte(role))
		if raw == nil {
			continue
		}
		var participant ParticipantRecord
		if err := json.Unmarshal(raw, &participant); err != nil {
			return "", err
		}
		if participant.RevokedAt == "" && constantTimeEqual(participant.TokenHash, tokenHash) {
			return role, nil
		}
	}
	return "", errUnauthorized
}

func joinCredentialMatches(tx *bolt.Tx, record ChannelRecord, channelID string, req JoinChannelRequest) bool {
	if req.PairingToken != "" {
		tokenHash := hashString(req.PairingToken)
		indexed := tx.Bucket([]byte(bucketPairingTokens)).Get([]byte(tokenHash))
		return string(indexed) == channelID && constantTimeEqual(record.PairingTokenHash, tokenHash)
	}
	shortCodeHash := hashString(req.ShortCode)
	indexed := tx.Bucket([]byte(bucketShortCodes)).Get([]byte(shortCodeHash))
	return string(indexed) == channelID && constantTimeEqual(record.ShortCodeHash, shortCodeHash)
}

func duplicateMessageExists(messages *bolt.Bucket, sender, messageID string) (bool, error) {
	cursor := messages.Cursor()
	for _, value := cursor.First(); value != nil; _, value = cursor.Next() {
		var msg MessageRecord
		if err := json.Unmarshal(value, &msg); err != nil {
			return false, err
		}
		if msg.Sender == sender && msg.MessageID == messageID {
			return true, nil
		}
	}
	return false, nil
}

func markExpiredIfNeeded(tx *bolt.Tx, meta *bolt.Bucket, record *ChannelRecord, now time.Time) (bool, error) {
	if !isExpired(*record, now) || record.Status == statusClosed || record.Status == statusExpired {
		return record.Status == statusExpired, nil
	}
	record.Status = statusExpired
	if err := putJSON(meta, []byte(recordKey), *record); err != nil {
		return false, err
	}
	if err := tx.Bucket([]byte(bucketPairingTokens)).Delete([]byte(record.PairingTokenHash)); err != nil {
		return false, err
	}
	if record.ShortCodeHash != "" {
		if err := tx.Bucket([]byte(bucketShortCodes)).Delete([]byte(record.ShortCodeHash)); err != nil {
			return false, err
		}
	}
	return true, nil
}

func deleteChannelIndexes(tx *bolt.Tx, record ChannelRecord) error {
	if err := tx.Bucket([]byte(bucketPairingTokens)).Delete([]byte(record.PairingTokenHash)); err != nil {
		return err
	}
	if record.ShortCodeHash != "" {
		if err := tx.Bucket([]byte(bucketShortCodes)).Delete([]byte(record.ShortCodeHash)); err != nil {
			return err
		}
	}
	if err := tx.Bucket([]byte(bucketShortCodeAttempts)).Delete([]byte(shortCodeJoinAttemptKey(record.ChannelID))); err != nil {
		return err
	}
	return nil
}

func shouldDeleteChannel(record ChannelRecord, now time.Time) bool {
	if record.Status == statusClosed || record.Status == statusExpired {
		return true
	}
	return isExpired(record, now)
}

func isExpired(record ChannelRecord, now time.Time) bool {
	expiresAt, err := time.Parse(time.RFC3339Nano, record.ExpiresAt)
	return err != nil || !expiresAt.After(now)
}

func rateLimitAttempt(tx *bolt.Tx, attemptKey string, now time.Time) (bool, error) {
	attempts := tx.Bucket([]byte(bucketShortCodeAttempts))
	raw := attempts.Get([]byte(attemptKey))
	if raw == nil {
		return false, nil
	}
	var record shortCodeAttemptRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return false, err
	}
	if record.LockedUntil != "" {
		lockedUntil, err := time.Parse(time.RFC3339Nano, record.LockedUntil)
		if err != nil {
			return false, err
		}
		if lockedUntil.After(now) {
			return true, nil
		}
		return false, attempts.Delete([]byte(attemptKey))
	}
	return false, nil
}

func recordAttemptMiss(tx *bolt.Tx, attemptKey string, now time.Time) error {
	attempts := tx.Bucket([]byte(bucketShortCodeAttempts))
	record := shortCodeAttemptRecord{
		Count:       1,
		WindowStart: formatTime(now),
	}
	if raw := attempts.Get([]byte(attemptKey)); raw != nil {
		if err := json.Unmarshal(raw, &record); err != nil {
			return err
		}
		windowStart, err := time.Parse(time.RFC3339Nano, record.WindowStart)
		if err != nil || now.Sub(windowStart) > shortCodeWindow {
			record = shortCodeAttemptRecord{Count: 1, WindowStart: formatTime(now)}
		} else {
			record.Count++
			if record.Count >= shortCodeAttemptLimit {
				record.LockedUntil = formatTime(now.Add(shortCodeLockout))
			}
		}
	}
	return putJSON(attempts, []byte(attemptKey), record)
}

func shortCodeResolveAttemptKey(shortCodeHash string) string {
	return "code:" + shortCodeHash
}

func shortCodeResolveAggregateAttemptKey() string {
	return "resolve:aggregate"
}

func shortCodeJoinAttemptKey(channelID string) string {
	return "channel:" + channelID
}

func cleanupKey(expiresAt time.Time, channelID string) []byte {
	key := make([]byte, 8+1+len(channelID))
	binary.BigEndian.PutUint64(key[:8], uint64(expiresAt.UnixMilli()))
	key[8] = 0
	copy(key[9:], channelID)
	return key
}

func parseCleanupKey(key []byte) (uint64, string, bool) {
	if len(key) <= 9 || key[8] != 0 {
		return 0, "", false
	}
	return binary.BigEndian.Uint64(key[:8]), string(key[9:]), true
}

func uint64Key(value uint64) []byte {
	key := make([]byte, 8)
	binary.BigEndian.PutUint64(key, value)
	return key
}

func cloneRaw(raw json.RawMessage) json.RawMessage {
	if raw == nil {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

func formatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
