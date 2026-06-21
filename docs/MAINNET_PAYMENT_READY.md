# Mainnet payment ready — Bazaar-discovered Zapper primary

**Status:** `PAID_DISCOVERED_TARGET_READY_HUMAN_GATE`  
**Agent did not load `BUYER_PRIVATE_KEY` and did not execute mainnet payment.**

## Authorized target (from live discovery)

| Field | Value |
|---|---|
| Resource | `https://public.zapper.xyz/x402/transaction-details` |
| Provider / service | `Zapper` / `zapper_tx_explainer` |
| Quote | **0.001125 USDC** (1125 atomic) |
| payTo | `0x43a2a720cd0911690c248075f4a29a5e7716f758` |
| Discovery run | `D:\trustforge\artifacts\runs\bazaar-target-discovery\run_20260620_071417` |
| Wallet of record | `0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1` |

## Human workflow (before mainnet)

1. Adapt discovery → `selected_candidate.json`:

```powershell
cd D:\agentic-payments-lab
node ./seller-api/node_modules/tsx/dist/cli.mjs tools/run-trustforge-adapt-discovered-target.ts `
  --target-selection "D:\trustforge\artifacts\runs\bazaar-target-discovery\run_20260620_071417\target_selection.json" `
  --output "D:\trustforge\artifacts\runs\bazaar-target-discovery\run_20260620_071417\selected_candidate.json"
```

2. Emit authorization DRAFT (agent-safe):

```powershell
node ./seller-api/node_modules/tsx/dist/cli.mjs tools/run-trustforge-emit-paid-authorization-draft.ts `
  --selected-candidate "D:\trustforge\artifacts\runs\bazaar-target-discovery\run_20260620_071417\selected_candidate.json" `
  --output "D:\trustforge\artifacts\runs\bazaar-target-discovery\run_20260620_071417\human_payment_authorization.DRAFT.json"
```

3. **Human only:** rename to `human_payment_authorization.json`, set `decision: "authorize_one_payment"`, fill `rationale`, commit.

## Single mainnet command (human executes)

Load the **dedicated rotated mainnet key** only in your shell (not in repo files). Confirm wallet rotation decision before loading if still open from prior session.

```powershell
cd D:\agentic-payments-lab
# Human: set BUYER_PRIVATE_KEY for 0x4cf3...d0c1 in D:\trustforge\.env or session env ONLY
npm run trustforge:phase6:paid-rich-probe -- --phase5-run "D:\trustforge\artifacts\runs\bazaar-target-discovery\run_20260620_071417"
```

**Exactly one attempt.** No fallback failover. No retry on failure — new human authorization required.

Pay-time freshness pre-flight runs automatically before key load. Abort if quote/payTo/challenge drift.

## Post-run verification (required)

Success is **on-chain**, not HTTP status:

```powershell
cd D:\agentic-payments-lab
npm run trustforge:onchain:reconcile
```

Confirm:

- Exactly **one** new USDC `Transfer` to `0x43a2a720cd0911690c248075f4a29a5e7716f758` for **0.001125 USDC**
- `unattributed_settlements_found: 0`
- Balance identity closes
- Phase 6 `RESULT.txt` shows `settlement_tx_hash` populated (not null)

## Safety reminders

- Agent never auto-approves authorization (`PENDING_HUMAN` only in DRAFT generator).
- Primary only — do not pay fallback #2 without separate authorization.
- If pre-flight or paid call fails, stop; do not retry without new authorization.
