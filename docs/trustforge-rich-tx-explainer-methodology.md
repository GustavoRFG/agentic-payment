# TrustForge rich tx_explainer methodology (v0.1.0)

**Status:** Phase 3 pipeline — factual verification only; no LLM judge for prose.

## Target

- Category: `tx_explainer`
- Preferred: OATP (not found in local Bazaar cache as of 2026-06-14)
- Selected equivalent: **Zapper** `POST https://public.zapper.xyz/x402/transaction-details`
- Primary fixture: Phase 2 payment tx on Base (`0xff5ec5e…`) — TrustForge-owned, on-chain verifiable

## What is scored

Deterministic, on-chain facts only:

- tx hash, chain, status, block, from/to, logs, USDC Transfer, amount, fee/gas when present

## What is NOT scored

- prose quality, style, persuasion, LLM judgment

## Human gates (separate from OneSource 0.005 cap)

```text
TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER=YES_I_AUTHORIZE_ONE_RICH_TX_EXPLAINER_PAYMENT
TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED=YES_I_AUTHORIZE_ONE_PAYMENT
TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID=<unique>
TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC=<0 < cap <= 0.25>
BUYER_PRIVATE_KEY=0x...
```

## Safety

- one payment attempt
- one payment-bearing HTTP request
- no retry, no fallback
- cap from `TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC` only

## Tools

```powershell
npm run trustforge:tx:ground-truth -- --tx <hash> --chain base --out <path>
npm run trustforge:rich-tx-explainer -- [--execute-paid]
npm run trustforge:rich-tx-explainer:diagnostics
npm run trustforge:rich-tx-explainer:phase3b
npm run trustforge:rich-tx-explainer:reconcile-settlements -- --wallet <addr> --from-block <n>
```

## Phase 3B settlement reconciliation

The rich Zapper target did **not** receive a passing TrustScore. Saved runs missed
settlement tx hashes; Phase 3B reconciles outbound USDC `Transfer` logs on Base.
See `docs/trustforge-phase3b-reconciliation.md`.

## Confidence

- `sample_size=1` → confidence **low**
- `semantic_richness` → **high** (multi-dimensional fact verification)

## Baselines preserved

- T0C `onesource_api_chain_id` — unchanged
- Phase 2 `onesource_api_block_number` — unchanged
