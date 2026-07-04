# Mainnet payment ready — thin x402 settlement (Phase 62C)

**Status:** `PHASE62C_THIN_RUNNER_READY_FOR_HUMAN_SEPOLIA_REPROVE`  
**Agent did not load `BUYER_PRIVATE_KEY` and did not execute mainnet payment.**

## State transition (Phase 62C)

```
PHASE62C_THIN_RUNNER_READY_FOR_HUMAN_SEPOLIA_REPROVE   <-- current; MAINNET IS BLOCKED
  → Step 5 Sepolia with PASS_SETTLED
  → PHASE62C_THIN_MAINNET_RUNNER_PROVEN                 <-- only this unblocks mainnet
```

**Before Step 5, mainnet is blocked.** Mainnet settle/classify must not run until a valid
Step 5 Sepolia regression records `PHASE62C_THIN_MAINNET_RUNNER_PROVEN`.

After a valid Step 5, the classify output / closure procedure records
`RESULT: PHASE62C_THIN_MAINNET_RUNNER_PROVEN` **only if all** hold (else token withheld,
mainnet stays blocked):

- `paid_probe_outcome: PASS_SETTLED`
- `binding_status: confirmed`
- `facilitator_hash_agrees: true`
- `phase6_settlements_identified: 1`
- `unattributed_settlements_found: 0`
- balance delta == quote (`actual_spend_atomic == quote_atomic`)
- thin runner path confirmed: `runX402PaidSettlement → executeThinX402Settlement → executeSingleX402Settlement` (guarded by `tests/unit/trustforge-x402-settlement-call-chain.test.ts`)
- strict no-mainnet during the regression (no `BUYER_PRIVATE_KEY`, no `X402_USE_MAINNET`)

See [trustforge-phase62c-thin-mainnet-runner.md](./trustforge-phase62c-thin-mainnet-runner.md) for the full transition rule.

## Readiness gates (Part A)

| Gate | Status | Notes |
|---|---|---|
| A1 tests | PASS | 436+ vitest, 22 pytest |
| A2 shared executor on mainnet | **PASS** | `executeThinX402Settlement` → `executeSingleX402Settlement` via `trustforge:x402:settle` |
| A3 receipt capture | PASS | shared core, network-agnostic |
| A4 mainnet reconciler | PASS | chain 8453, `safe_to_use: yes` with keyed RPC |
| A5 three-outcome on mainnet | **PASS** | `PASS_SETTLED` / `PASS_NO_SETTLE_CLEAN` / `FAIL` via `classifyThinSettlementOutcome` |
| A6 fresh discovery | PASS | `run_20260622_070509`, primary `token-balances`, quote 0.001125 USDC |
| A7 wallet | PARTIAL | config `0x4cf3…d0c1`; key rotation unverified without loading key |
| A9 env | PARTIAL | keys absent in agent session |
| A10 tag | PASS | `pre-mainnet-paid` after 62C commits |

## Authorized target (thin adapt — honors discovered endpoint)

Use `--thin` on adapt so primary endpoint is taken from discovery (not rich allowlist):

```powershell
node ./seller-api/node_modules/tsx/dist/cli.mjs tools/run-trustforge-adapt-discovered-target.ts `
  --target-selection "D:\trustforge\artifacts\runs\bazaar-target-discovery\run_20260622_070509\target_selection.json" `
  --output "D:\trustforge\artifacts\runs\bazaar-target-discovery\run_20260622_070509\selected_candidate.json" `
  --thin
```

## Human workflow

### 1. Sepolia regression (mandatory — same code mainnet will run)

```powershell
cd D:\agentic-payments-lab
# Human: SEPOLIA_BUYER_PRIVATE_KEY + TRUSTFORGE_SEPOLIA_RPC_URL in session only
npm run trustforge:x402:settle -- --run-dir "<sepolia_run_with_authorization>"
npm run trustforge:x402:classify -- --run-dir "<sepolia_run_with_authorization>"
```

Require: `PASS_SETTLED`, `facilitator_hash_agrees: true`, `binding_status: confirmed`, `phase6_settlements_identified: 1`, `unattributed: 0`.

### 2. Mainnet (after Sepolia PASS_SETTLED)

```powershell
# Human: BUYER_PRIVATE_KEY for 0x4cf3…d0c1 + TRUSTFORGE_BASE_RPC_URL
npm run trustforge:mainnet:settle -- --run-dir "<mainnet_run>"
npm run trustforge:mainnet:classify -- --run-dir "<mainnet_run>"
```

**Exactly one attempt.** No fallback failover. No retry.

Pre-payment reconcile gate unchanged — see [trustforge-onchain-settlement-ledger.md](./trustforge-onchain-settlement-ledger.md).

## Part B residual (operational only)

- Keyed RPC at pay time
- Confirmed rotation of `0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1`
- Human authorization (`human_payment_authorization.json`)
- Sepolia regression through parameterized runner (Step 5)

## Deferred

Rich-tx-explainer mainnet (`runRichTxExplainerPhase3`) — separate milestone; not first settlement gate.

See [trustforge-phase62c-thin-mainnet-runner.md](./trustforge-phase62c-thin-mainnet-runner.md).
