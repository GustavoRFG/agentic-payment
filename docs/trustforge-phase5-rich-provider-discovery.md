# TrustForge Phase 5 — Rich Provider Discovery

Phase 5 performs **unpaid only** discovery for the next settlement-first rich probe.
No wallet, no payment header, no `--execute-paid`.

## Goal

Find rich paid-service candidates suitable for settlement-first evaluation under Phase 4
architecture, select at most one for a future Phase 6 single paid probe, and stop at
the human payment authorization gate.

## Commands

```powershell
$env:TRUSTFORGE_PHASE4_NO_PAYMENT="YES_STRICTLY_NO_PAYMENT"
$env:TRUSTFORGE_DISABLE_PAID_EXECUTION="YES"

npm run trustforge:phase5:discovery
```

## What discovery does

1. Offline scan of Bazaar cache, registry, and OATP draft for `tx_explainer` endpoints.
2. Live unpaid HTTP 402 handshake against Zapper (no payment header, no wallet).
3. Registry cross-check of bootstrap services for comparison.
4. Candidate scoring and selection.
5. Human authorization **template** creation (`decision: PENDING`).

## Selection criteria

1. Unpaid discovery works (HTTP 402 with quote).
2. Quote visible before payment.
3. Settlement metadata reconstructable (chain reconciliation path).
4. Semantic evaluation possible (fact verification pipeline).
5. Strict cap compatible.
6. No retry required.
7. Phase 4 SettlementEvidence / PaymentAttemptLedger compatible.

## Selected candidate (2026-06-15)

**Zapper** `zapper_tx_explainer` — `POST https://public.zapper.xyz/x402/transaction-details`

- Observed quote: `0.001125 USDC`
- Recommended cap: `0.10 USDC`
- Phase 3B chain reconciliation proven for this provider
- Semantic evaluation pipeline exists; Phase 3 responses were **incomplete** (no passing TrustScore yet)

## Human payment gate (Phase 6)

Phase 6 does **not** run until this file exists and validates:

```text
D:\trustforge\artifacts\runs\phase5-rich-provider-discovery\run_<ts>\human_payment_authorization.json
```

Copy from `human_payment_authorization_template.json` and set:

```json
{
  "decision": "authorize_one_payment",
  "max_usdc": "0.10",
  "rationale": "<your reason>"
}
```

Required fields: `decision`, `max_payment_attempts: 1`, `allow_retry: false`,
`require_dedicated_wallet: true`, provider/service_id/endpoint matching `selected_candidate.json`.

## Forbidden before authorization

- `npm run trustforge:rich-tx-explainer:paid`
- `--execute-paid`
- Loading `BUYER_PRIVATE_KEY`
- Payment headers
- Zapper paid retry

## Artifacts

```text
D:\trustforge\artifacts\runs\phase5-rich-provider-discovery\run_<timestamp>\
  01_run_state.json
  02_offline_discovery.json
  03_unpaid_liveness_handshake.json
  candidate_provider_*.json
  selected_candidate.json
  selected_candidate.md
  human_payment_authorization_template.json
  provider_discovery_summary.json
  provider_discovery_summary.md
  RESULT.txt
```

## Next step

Review `selected_candidate.json`. If you want exactly one paid probe, create
`human_payment_authorization.json` from the template. Otherwise leave `decision: PENDING`
or set `decision: reject`.
