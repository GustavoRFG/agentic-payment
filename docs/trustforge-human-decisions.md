# TrustForge Human Decisions

The following decisions remain human-only and must not be automated by agents:

- [x] create a new dedicated wallet
- [x] fund the wallet with a controlled minimum balance
- [x] configure `BUYER_PRIVATE_KEY` locally without committing it
- [x] authorize MVP-T0C with a 0.005 USDC total spend cap
- [x] verify the transaction on-chain after MVP-T0C (tx `0xb445f8c1…0cfb11`, `ONCHAIN_VERIFIED`)
- [ ] decide whether to create a private GitHub backup
- [ ] decide whether to publish publicly only after T0C
- [ ] review commercial and legal policy before publishing public scores

## T0C arming (set only for the duration of an authorized paid run)

The `fast-track-e2e` run `run_20260614_010720` executed with all gates armed and
the dedicated wallet key loaded for a single invocation (not persisted, not
printed). Result: `PASS`, on-chain verified. These should be **unset again** now
that the authorized run is complete:

- [x] `TRUSTFORGE_AUTHORIZE_T0C=YES_I_AUTHORIZE_ONE_EXTERNAL_PAYMENT`
- [x] `TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED=YES_I_AUTHORIZE_ONE_PAYMENT`
- [x] `TRUSTFORGE_T0C_RUN_ID=t0c_20260613_215339`
- [x] `BUYER_PRIVATE_KEY` loaded via the local loader for one invocation (never committed)

### Follow-up for the human
- The dedicated wallet private key was stored locally as a bare 64-hex line in
  `D:\trustforge\.env` (no variable name, no `0x` prefix), which the paid
  executor does not read directly. For the next run, set it as
  `BUYER_PRIVATE_KEY=0x…` in the process environment / secure loader. Consider
  rotating this dedicated wallet key since it surfaced in a session name-scan.

## Request-shape authorization

Any future human payment authorization must copy both
`request_binding_sha256` and the auditable `request_summary` from the selected
candidate. A missing or changed endpoint, method, query, or body requires a new
candidate and a new human decision; agents must not reconstruct, default, or
silently amend the authorized invocation shape.

For the rich flow, the Phase 5 template is the source of the request-binding
decision. Phase 6 must read the approved hash and summary from the resulting
human artifact; it may canonicalize them for validation, but it must never use
the runtime planner's own hash as the authorized value.

## B.3.7.1 productive one-shot authorized send bridge (inactive / no payment)

The productive send bridge (`sendAuthorizedPaymentOnce`) may perform at most one
payment-bearing HTTP request only when given an exact current
`PaymentSendAuthorization` plus a matching persisted signed artifact. It never
accepts a private key, signer, or wallet client. Payment headers are reconstructed
from the persisted signature (serialize-only). `SEND_COMMITTED_NO_RETRY` is
persisted before the network call; second send and automatic retry are forbidden.
Ambiguous outcomes (timeout, redirect, crash after commit) are terminal
reconcile. Bridge readiness does not authorize payment. No operational SEND
mandate or payment run is active after B.3.7.1 engineering.

Evidence:
`D:\trustforge\artifacts\runs\b371-productive-send-bridge\run_20260812_024002`
→ `B371_PRODUCTIVE_ONE_SHOT_SEND_BRIDGE_READY_INACTIVE_NO_PAYMENT`.

The first real payment attempt
`D:\trustforge\artifacts\runs\first-real-payment\run_20260812_012234` correctly
stopped at `BLOCKED_FIRST_PAYMENT_PRODUCTIVE_SEND_PATH_MISSING_NO_PAYMENT` and
did not consume authorization. That human authorization must not be reused after
these engineering changes; a new human authorization is required later.

## B.4 Windows operational mode (ready / inactive until vault setup)

B.4 wires a thin mainnet runner over the existing payment core with pluggable
custody (`windows-dpapi-local-signer`) and approve/reject UX. Payment still
requires exact conditional signing + send mandates sharing one
`human_decision_id`, fresh 402, derived PSA, and B.3.7.1 one-shot send. One-time
`trustforge:secure-signer-setup` for expected buyer `0x4cf3…` is a separate human
action; until the DPAPI vault exists and a human Approves, no payment runs.
See `docs/trustforge-b4-windows-operational-mode.md`.

## B.4.1 approval UI explicit-decision corrective (ready / no payment)

Operator statement: the B.4 canary
`run_20260812_043500` was not an explicit Reject; the dialog closed before a
decision. Historical evidence is write-once; corrective interpretation is
`CORRECTIVE_INTERPRETATION_B41.json`. Production now requires explicit Approve
or Reject button activation; window close is `ABORT` (fail-closed, not Reject);
no approval-dialog timeout; approval remains before the fresh unpaid 402.
See `docs/trustforge-b41-approval-ui-explicit-decision.md`.

## B.4.1.1 Windows PowerShell 5.1 approval UI encoding (ready / no payment)

Probe `run_20260812_174124` failed at UI parse (`UI_FAILED`) due to UTF-8
typography in the approval `.ps1` under PowerShell 5.1. Encoding corrective
makes the launcher ASCII-safe; no payment authorization and no canary relaunch
in that task. See `docs/trustforge-b411-ps51-approval-ui-encoding.md`.

## B.3.7 conditional one-shot payment send mandate (offline)

A human conditional payment-send mandate may authorize deterministic derivation
of at most one exact `PaymentSendAuthorization` after a fresh signed artifact
passes an internal post-sign JIT audit. The send mandate itself cannot reach the
network and cannot authorize credential access or signing. The signing mandate
cannot authorize payment-bearing send. Ambiguous send outcomes are terminal
(`AMBIGUOUS_SEND_TERMINAL_RECONCILE`) with no automatic retry/resend. No
operational SEND mandate is created until a separate human decision; B.3.7
proves the contract offline with synthetic fixtures only.

The first real signed artifact audit
`D:\trustforge\artifacts\runs\first-real-signed-artifact-audit\run_20260811_232958`
classified the R6 signature as
`FIRST_REAL_SIGNED_ARTIFACT_AUDIT_PASS_EXPIRED_ABANDON_REAUTHORIZE`. That
artifact is permanently `EXPIRED_EVIDENCE_ONLY_REAUTHORIZE` and must not be
reused for send.

## B.3.6.3 conditional credential+signing mandate (offline)

A human conditional credential+signing mandate may authorize deterministic
derivation of at most one exact B.3 signing authorization and one exact B.3.1
credential-access authorization after a fresh unpaid 402 matches the mandate.
The mandate itself cannot acquire credentials or invoke the signer. Derived
signing authorization still does not authorize payment-bearing send. No
operational conditional mandate is created until a separate human decision;
B.3.6.3 proves the contract offline with synthetic fixtures only.

The prior B.3.6.2 operational JIT run
`D:\trustforge\artifacts\runs\b362-operational-jit-mandate\run_20260811_002106`
is evidence-only and must not be signed or reused.

## B.3.6.1 JIT one-shot signing mandate (offline)

A human one-shot signing mandate may authorize deterministic derivation of at
most one exact B.3 signing authorization after a fresh unpaid 402 matches the
mandate exactly. The mandate itself is never accepted by the signer. Derived
signing authorization does not authorize credential access, payment-bearing
send, or settlement. No operational mandate is created until a separate human
decision; B.3.6.1 proves the contract offline with synthetic fixtures only.

The prior B.3.6 prepare run
`D:\trustforge\artifacts\runs\b36-fresh-signing-candidate-prepare\run_20260810_175224`
is evidence-only: its unsigned artifact expired and must not be signed or reused.

## Seller requirements / buyer authorization separation (B.1)

The human decision `ACCEPT_X402_CHALLENGE_MODEL_ALIGNMENT_AUDIT` establishes
three separate contracts: seller `PaymentRequirements`, human payment
authorization, and the future buyer-signed EIP-3009 authorization. Seller
requirements do not own `nonce`, `validAfter`, `validBefore`, `expiresAt`, or a
signature.

Approved policy constants are: seller local freshness cap 300 seconds; human
authorization default TTL 900 seconds and maximum TTL 1800 seconds; buyer
`validAfter` clock skew 60 seconds; Tempo `id`/`expires` record-only and
non-authoritative; signed-but-not-sent attempts terminal-abandoned and requiring
reauthorization. B.1 creates no buyer nonce or signed payload. A future B.2 must
refresh an unsigned 402 immediately before signing and require exact authorized
requirements/envelope hashes.

## B.1 corrective R1

The human decision `REQUEST_B1_CORRECTIVE_R1` keeps every productive paid path
technically disabled until B.2. The stable blocker is
`BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED`; it has no
environment or CLI bypass. Test-only seams may exercise historical deterministic
core logic but are not imported by productive tools.

Seller network identity is version-aware and exact: x402 v1 `base` maps to
`eip155:8453`, v1 `base-sepolia` maps to `eip155:84532`, and x402 v2 requires the
corresponding CAIP-2 string. Numeric, case-folded, whitespace-normalized, and
heuristic aliases are rejected. Human authorization and future intent bind both
the raw seller identifier and canonical CAIP-2 identity; seller hashes continue
to cover the unmodified raw JSON.
