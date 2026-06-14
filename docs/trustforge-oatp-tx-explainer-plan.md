# TrustForge OATP `tx_explainer` — readiness plan

**Status (2026-06-14):** Phase 3 pipeline implemented. OATP not found in local CDP
Bazaar cache; **Zapper** `transaction-details` selected as `FOUND_EQUIVALENT`
allowlisted endpoint. Unpaid 402 liveness confirmed (quote 0.001125 USDC ≤ cap).
Paid probe requires `BUYER_PRIVATE_KEY` via safe loader + all rich gates.

**Phase 2 note:** No OATP payment was performed in Phase 2 (design only).

## Target candidate

- Not present in the current bootstrap registry (the 8 proven services are chain
  metadata / market data / prediction / weather). The OATP `tx_explainer`
  endpoint must first be added to the registry by an unpaid handshake before any
  paid probe, exactly as the OneSource services were.
- Expected shape: an x402 GET/POST that, given a transaction hash, returns a
  natural-language explanation plus structured transaction facts.

## Expected economics

- expected_price: likely **> OneSource** (richer compute / LLM generation).
  Assume it may exceed the 0.005 USDC OneSource cap; do **not** reuse the Phase 2
  cap. Set a dedicated, explicit cap when authorized.
- payment_network: Base mainnet `eip155:8453` — asset: USDC (same rails).

## Safe transaction fixture selection

- Use a **private, rotating** set of historical Base/Ethereum transactions whose
  facts are independently verifiable on-chain.
- Never publish exact fixtures (anti-gaming); rotate per probe.

## Facts verifiable on-chain (ground truth via `eth_getTransactionReceipt` / `eth_getTransactionByHash`)

- tx exists
- block number
- status (success/revert)
- fee (gasUsed × effectiveGasPrice, + L2 L1-fee on Base)
- from / to
- logs count
- token transfers (ERC-20 `Transfer` decode)
- contract addresses touched
- balance deltas (when feasible via archive `eth_getBalance` at block±1)

## Verifier taxonomy

- **deterministic facts** (exact match, weight-bearing): tx existence, block
  number, status, from/to, logs count, token-transfer set, contract addresses.
- **tolerance-based facts** (numeric ± tolerance): fee, balance deltas, gas.
- **unscored natural-language explanation**: the prose is recorded as evidence
  but is **not** scored in this phase (no LLM-judge for prose quality yet).

## Anti-gaming

- private tx set; rotating probes; no published exact fixtures; randomized
  selection per run; cross-check every scored fact against independent RPC.

## Gates (must all hold before a paid OATP probe)

- unpaid liveness handshake recorded in the registry (HTTP 402 + quote).
- quote cap: a dedicated explicit cap (likely > 0.005), never the OneSource cap.
- paid cap requires **separate explicit authorization** distinct from the Phase 2
  deterministic gate (a new `TRUSTFORGE_AUTHORIZE_OATP_*` style flag), plus the
  one-payment arming + unique run id, same one-shot / no-retry / no-fallback
  guards used for T0C and Phase 2.

## Reuse from Phase 2

The verification-profile machinery added in Phase 2
(`VerificationProfileId`, profile-aware ground truth + semantics in the executor)
extends cleanly: `tx_explainer` would add an `oatp_tx_facts` profile with the
deterministic + tolerance verifiers above, leaving the prose unscored.
