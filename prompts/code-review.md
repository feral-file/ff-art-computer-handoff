### Review priority

1. Protocol security invariants: no DP1 playlist content through `ff-controller`, no raw session tokens stored or logged where avoidable, strict payload limits, and durable LMDB state transitions.
2. Flow correctness: expiry, revocation, duplicate claim, retry behavior, and restart durability.
3. Operational readiness: Docker image behavior, CI coverage, deployment handoff clarity, persistent `/data` storage, and production defaults.
4. Product scope: keep the repo focused on `ff-controller`, session-recipient clients, the handoff server, and `ff-relayer`.

### Required review posture

- Read `docs/sequential-flow.md` first: this is a minimal secure browser session handoff prototype, not a general relay.
- Review whether any API, log, metric, fixture, Docker layer, or error path can expose playlist content, raw session tokens, or privileged credentials.
- Prefer clear deletion or reshaping of risky behavior over compatibility shims.
- Do not speculate. Report only concrete risks or clearly better alternatives.

### Tests and docs sufficiency review

Assess only real gaps:

1. Do tests cover malformed input, expiry, revoke, duplicate claim, oversized payload, unauthorized access, and durable restart behavior where relevant?
2. Do browser, controller, and integration checks verify the expected party boundaries and public API constraints?
3. Do docs and deployment files state required persistence and secrets without changing protocol assumptions?

### Preferred review output shape

Use only sections that have real content:

1. Critical security issues
2. Correctness issues
3. Architecture / flow issues
4. Test gaps
5. Documentation gaps

If there are no meaningful findings, say so briefly.

### Verdict

End your review with a single line: **Verdict: accept** or **Verdict: revise**.
