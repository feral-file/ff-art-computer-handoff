package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	minter "github.com/feral-file/ff-art-computer-handoff/clients/ephemeral-token-minter/go"
)

type readyMessage struct {
	QRPayload json.RawMessage `json:"qrPayload"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	brokerBaseURL := os.Getenv("BROKER_BASE_URL")
	if brokerBaseURL == "" {
		return errors.New("BROKER_BASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	channel, err := minter.NewClient(nil).StartChannel(ctx, minter.StartChannelOptions{
		BrokerBaseURL:      brokerBaseURL,
		IdleTTL:            time.Minute,
		ShortCodeRequested: true,
	})
	if err != nil {
		return err
	}

	display := channel.PairingDisplay()
	if err := json.NewEncoder(os.Stdout).Encode(readyMessage{QRPayload: display.QRPayload}); err != nil {
		return err
	}

	var request *minter.MintRequest
	for {
		request, err = channel.PollMintRequest(ctx, 0)
		if err != nil {
			return err
		}
		if request != nil {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	if request.Origin != "https://nft.example" {
		return fmt.Errorf("unexpected request origin: %s", request.Origin)
	}
	_, err = channel.SendMintSuccess(ctx, *request, minter.MintResult{
		SessionID:      "eps_go_integration",
		Token:          "go-integration-browser-session-token",
		ExpiresAt:      time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC),
		RelayerBaseURL: "https://relayer.example",
	})
	return err
}
