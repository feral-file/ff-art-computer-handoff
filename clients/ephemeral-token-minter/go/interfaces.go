package minter

import "context"

// ApprovalClient is implemented by host code that asks ff-controller, through
// ff-relayer or another approved path, whether a decrypted mint request should
// be granted. Implementations must not receive raw browser session tokens.
type ApprovalClient interface {
	RequestMintApproval(ctx context.Context, request MintRequest) (ApprovalDecision, error)
}

// ApprovalDecision is the host approval result for a browser mint request.
type ApprovalDecision struct {
	Approved        bool
	RejectionReason string
	Retryable       bool
}

// RelayerClient is implemented by host code that creates ephemeral browser
// sessions through ff-relayer after approval. The returned token should be
// passed directly to SendMintSuccess and must not be logged.
type RelayerClient interface {
	CreateEphemeralSession(ctx context.Context, topicID string, request MintRequest) (MintResult, error)
}
