/**
 * Stable, matchable error codes for integrators.
 *
 * `error.code` is the contract: match on it, not on message text. Messages
 * stay human-readable and may change between versions; codes do not.
 */
export type PlayErrorCode =
  | "pairing_code_not_found"
  | "pairing_code_expired"
  | "pairing_code_used"
  | "mint_rejected"
  | "approval_timeout"
  | "session_rejected"
  | "display_failed"
  | "display_rejected"
  | "pairing_canceled";

export class PlayError extends Error {
  readonly code: PlayErrorCode | undefined;

  constructor(message: string, code?: PlayErrorCode) {
    super(message);
    this.name = "PlayError";
    this.code = code;
  }
}
