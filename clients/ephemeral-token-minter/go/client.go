package minter

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

// Client talks to the Mint Pairing Broker.
type Client struct {
	httpClient *http.Client
}

// NewClient creates a broker client. If httpClient is nil, http.DefaultClient is
// used.
func NewClient(httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{httpClient: httpClient}
}

// Channel is a local minter view of one broker pairing channel.
type Channel struct {
	client       *Client
	brokerBase   *url.URL
	channelID    string
	minterToken  string
	privateKey   *ecdh.PrivateKey
	publicKeyJWK PublicJWK
	display      PairingDisplay
}

// StartChannel creates a temporary broker channel and returns local channel
// state plus display material for the FF1 frontend.
func (c *Client) StartChannel(ctx context.Context, opts StartChannelOptions) (*Channel, error) {
	if strings.TrimSpace(opts.BrokerBaseURL) == "" {
		return nil, errors.New("broker base URL is required")
	}
	brokerBase, err := url.Parse(opts.BrokerBaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse broker base URL: %w", err)
	}
	privateKey, err := generatePrivateKey()
	if err != nil {
		return nil, err
	}
	publicJWK, err := publicKeyToJWK(privateKey.PublicKey())
	if err != nil {
		return nil, err
	}
	idleTTLSeconds := int64(0)
	if opts.IdleTTL > 0 {
		idleTTLSeconds = int64(opts.IdleTTL.Round(time.Second) / time.Second)
	}
	reqBody := createChannelRequest{
		Algorithm:          Algorithm,
		MinterPublicKeyJWK: publicJWK,
		IdleTTLSeconds:     idleTTLSeconds,
		ShortCodeRequested: opts.ShortCodeRequested,
	}
	var response createChannelResponse
	if err := c.doJSON(ctx, http.MethodPost, brokerBase, "/v1/channels", "", reqBody, &response); err != nil {
		return nil, err
	}
	if response.ChannelID == "" || response.MinterToken == "" {
		return nil, errors.New("broker create channel response missing channel id or minter token")
	}
	display := PairingDisplay{
		ChannelID: response.ChannelID,
		QRPayload: append([]byte(nil), response.QRPayload...),
		ShortCode: response.ShortCode,
		ExpiresAt: response.ExpiresAt,
	}
	return &Channel{
		client:       c,
		brokerBase:   brokerBase,
		channelID:    response.ChannelID,
		minterToken:  response.MinterToken,
		privateKey:   privateKey,
		publicKeyJWK: publicJWK,
		display:      display,
	}, nil
}

// PairingDisplay returns a copy of the frontend-safe display material.
func (ch *Channel) PairingDisplay() PairingDisplay {
	return PairingDisplay{
		ChannelID: ch.display.ChannelID,
		QRPayload: append([]byte(nil), ch.display.QRPayload...),
		ShortCode: ch.display.ShortCode,
		ExpiresAt: ch.display.ExpiresAt,
	}
}

// MinterPublicKeyJWK returns the channel public key in JWK-compatible form.
func (ch *Channel) MinterPublicKeyJWK() PublicJWK {
	return ch.publicKeyJWK
}

// PollMintRequest fetches broker messages after afterSeq and returns the first
// decryptable browser mint request addressed to this minter.
func (ch *Channel) PollMintRequest(ctx context.Context, afterSeq int64) (*MintRequest, error) {
	pollPath := "/v1/channels/" + pathEscape(ch.channelID) + "/messages"
	query := url.Values{}
	query.Set("afterSeq", strconv.FormatInt(afterSeq, 10))
	var response pollMessagesResponse
	if err := ch.client.doJSON(ctx, http.MethodGet, ch.brokerBase, pollPath+"?"+query.Encode(), ch.minterToken, nil, &response); err != nil {
		return nil, err
	}
	if response.ChannelID != "" && response.ChannelID != ch.channelID {
		return nil, errors.New("broker poll response channel mismatch")
	}
	for _, message := range response.Messages {
		if message.Sender != "browser" || message.Recipient != "minter" {
			continue
		}
		remotePublicJWK, err := chooseRemotePublicJWK(message)
		if err != nil {
			return nil, err
		}
		plaintext, aad, err := decryptMessage(ch.privateKey, message, remotePublicJWK)
		if err != nil {
			return nil, err
		}
		if aad.ChannelID != ch.channelID {
			return nil, errors.New("decrypted message channel mismatch")
		}
		var decoded mintRequestPlaintext
		if err := json.Unmarshal(plaintext, &decoded); err != nil {
			return nil, fmt.Errorf("decode mint request: %w", err)
		}
		if decoded.Type != messageTypeMintRequest {
			continue
		}
		if err := validateMintRequestPlaintext(decoded, ch.channelID, message.MessageID, remotePublicJWK); err != nil {
			return nil, err
		}
		return &MintRequest{
			ChannelID:                 ch.channelID,
			MessageID:                 message.MessageID,
			Seq:                       message.Seq,
			Origin:                    decoded.Origin,
			BrowserInfo:               decoded.BrowserInfo,
			BrowserPublicKeyJWK:       remotePublicJWK,
			RequestedExpiresInSeconds: decoded.RequestedExpiresInSeconds,
		}, nil
	}
	return nil, nil
}

// SendMintSuccess encrypts a host-created session result for the requester.
func (ch *Channel) SendMintSuccess(ctx context.Context, request MintRequest, result MintResult) (*SendMessageResult, error) {
	if result.Token == "" {
		return nil, errors.New("mint result token is required")
	}
	return ch.sendEncryptedResult(ctx, request, mintSuccessPlaintext{
		Version:          1,
		Type:             messageTypeMintSucceeded,
		ChannelID:        ch.channelID,
		RequestMessageID: request.MessageID,
		Session: mintSessionPlaintext{
			SessionID:      result.SessionID,
			Token:          result.Token,
			ExpiresAt:      result.ExpiresAt,
			RelayerBaseURL: result.RelayerBaseURL,
		},
	})
}

// SendMintRejection encrypts an application-level rejection for the requester.
func (ch *Channel) SendMintRejection(ctx context.Context, request MintRequest, rejection MintRejection) (*SendMessageResult, error) {
	return ch.sendEncryptedResult(ctx, request, mintRejectionPlaintext{
		Version:          1,
		Type:             messageTypeMintRejected,
		ChannelID:        ch.channelID,
		RequestMessageID: request.MessageID,
		Reason:           rejection.Reason,
		Retryable:        rejection.Retryable,
	})
}

// Close closes the broker channel.
func (ch *Channel) Close(ctx context.Context) error {
	return ch.client.doJSON(ctx, http.MethodDelete, ch.brokerBase, "/v1/channels/"+pathEscape(ch.channelID), ch.minterToken, nil, nil)
}

func (ch *Channel) sendEncryptedResult(ctx context.Context, request MintRequest, plaintext any) (*SendMessageResult, error) {
	if request.ChannelID != ch.channelID {
		return nil, errors.New("mint request channel does not match channel")
	}
	messageID, err := randomMessageID()
	if err != nil {
		return nil, err
	}
	aad := envelopeAAD{
		Version:   1,
		ChannelID: ch.channelID,
		MessageID: messageID,
		Seq:       0,
		Sender:    "minter",
		Recipient: "browser",
		Algorithm: Algorithm,
	}
	message, err := encryptJSON(ch.privateKey, request.BrowserPublicKeyJWK, aad, plaintext)
	if err != nil {
		return nil, err
	}
	message.SenderPublicKeyJWK = &ch.publicKeyJWK
	var response sendMessageResponse
	if err := ch.client.doJSON(ctx, http.MethodPost, ch.brokerBase, "/v1/channels/"+pathEscape(ch.channelID)+"/messages", ch.minterToken, message, &response); err != nil {
		return nil, err
	}
	if response.ChannelID != "" && response.ChannelID != ch.channelID {
		return nil, errors.New("broker send response channel mismatch")
	}
	return &SendMessageResult{
		ChannelID: response.ChannelID,
		Seq:       response.Seq,
		ExpiresAt: response.ExpiresAt,
	}, nil
}

func validateMintRequestPlaintext(decoded mintRequestPlaintext, channelID string, messageID string, senderPublicJWK PublicJWK) error {
	if decoded.Version != 1 {
		return fmt.Errorf("unsupported mint request version: %d", decoded.Version)
	}
	if decoded.ChannelID == "" || decoded.ChannelID != channelID {
		return errors.New("mint request channel mismatch")
	}
	if decoded.RequestMessageID == "" || decoded.RequestMessageID != messageID {
		return errors.New("mint request message id mismatch")
	}
	if !publicJWKMatches(decoded.BrowserPublicKeyJWK, senderPublicJWK) {
		return errors.New("mint request browser public key mismatch")
	}
	if err := validateBrowserOrigin(decoded.Origin); err != nil {
		return err
	}
	return nil
}

func validateBrowserOrigin(origin string) error {
	if origin == "" {
		return errors.New("mint request missing origin")
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return fmt.Errorf("parse mint request origin: %w", err)
	}
	if !parsed.IsAbs() || parsed.Host == "" {
		return errors.New("mint request origin must be absolute")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("mint request origin must use http or https")
	}
	if parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawPath != "" || parsed.Opaque != "" {
		return errors.New("mint request origin must not include credentials, path, query, or fragment")
	}
	return nil
}

func publicJWKMatches(a PublicJWK, b PublicJWK) bool {
	return a.KeyType == b.KeyType && a.Curve == b.Curve && a.X == b.X && a.Y == b.Y
}

func (c *Client) doJSON(ctx context.Context, method string, base *url.URL, requestPath string, bearerToken string, requestBody any, responseBody any) error {
	requestURL := *base
	cleanPath := requestPath
	if idx := strings.Index(requestPath, "?"); idx >= 0 {
		cleanPath = requestPath[:idx]
		requestURL.RawQuery = requestPath[idx+1:]
	}
	if strings.HasPrefix(cleanPath, "/") {
		requestURL.Path = path.Clean(cleanPath)
	} else {
		requestURL.Path = path.Join(requestURL.Path, cleanPath)
	}
	var bodyReader *bytes.Reader
	if requestBody == nil {
		bodyReader = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, requestURL.String(), bodyReader)
	if err != nil {
		return err
	}
	if requestBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("broker %s %s failed with status %d", method, requestURL.Path, resp.StatusCode)
	}
	if responseBody == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(responseBody)
}

func randomMessageID() (string, error) {
	randomBytes := make([]byte, 16)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", err
	}
	return "msg_" + rawBase64.EncodeToString(randomBytes), nil
}

func pathEscape(value string) string {
	return url.PathEscape(value)
}
