# TrustForge Phase 62C — Thin mainnet settlement runner

**Status:** code ready; human Sepolia re-prove + mainnet authorization pending.

## Principle

One network-parameterized thin settle + classify path. Sepolia and mainnet invoke the **same** code (`executeSingleX402Settlement` via `executeThinX402Settlement`). No `runRichTxExplainerPhase3` on the money path.

## CLI (human executes)

### Adapt discovery (thin — any `live_402_ok` primary)

```powershell
node ./seller-api/node_modules/tsx/dist/cli.mjs tools/run-trustforge-adapt-discovered-target.ts `
  --target-selection "<run>/target_selection.json" `
  --output "<run>/selected_candidate.json" `
  --thin
```

### Sepolia regression (Step 5 — mandatory before mainnet)

```powershell
npm run trustforge:x402:settle -- --run-dir "<sepolia_run>"
npm run trustforge:x402:classify -- --run-dir "<sepolia_run>"
```

Legacy aliases still work: `trustforge:sepolia:settle`, `trustforge:sepolia:classify`.

### Mainnet (config + human trigger only)

```powershell
npm run trustforge:mainnet:settle -- --run-dir "<mainnet_run>"
npm run trustforge:mainnet:classify -- --run-dir "<mainnet_run>"
```

Requires `BUYER_PRIVATE_KEY` (rotated `0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1`), `TRUSTFORGE_BASE_RPC_URL`, and `human_payment_authorization.json` with `decision: authorize_one_payment`.

## Three-outcome classify

| Outcome | Meaning |
|---|---|
| `PASS_SETTLED` | 200 + on-chain Transfer + facilitator hash agrees + binding confirmed + balance delta == quote |
| `PASS_NO_SETTLE_CLEAN` | Seller declined (non-200 / no payment-response) + no outbound Transfer + balance intact |
| `FAIL` | 200 with payment evidence but no Transfer; hash mismatch; unattributed balance movement; retry/fallback |

Discriminator: `classifyThinSettlementOutcome` in `tools/trustforge/thin-settlement-outcome.ts`.

## Network guards (shared executor)

- Mainnet: chainId 8453, Base USDC, `BUYER_PRIVATE_KEY`, refuse `SEPOLIA_BUYER_PRIVATE_KEY`, wallet == `0x4cf3…d0c1` (`BLOCKED_WRONG_WALLET`)
- Sepolia: inverse
- Pre-payment 402 intent match against discovered endpoint/payTo/asset/amount

## Phase 62C state transition

The runner advances through explicit, machine-checkable tokens:

1. `PHASE62C_THIN_RUNNER_READY_FOR_HUMAN_SEPOLIA_REPROVE` — code ready; **mainnet is blocked**. The agent has not loaded `BUYER_PRIVATE_KEY` and has not executed any mainnet payment.
2. **Step 5 (Sepolia reprove)** — the human runs settle + classify on Sepolia (the same code mainnet will run) and obtains `PASS_SETTLED`.
3. `PHASE62C_THIN_MAINNET_RUNNER_PROVEN` — emitted/recorded **only after** a valid Step 5.

```
PHASE62C_THIN_RUNNER_READY_FOR_HUMAN_SEPOLIA_REPROVE
  → Step 5 Sepolia with PASS_SETTLED
  → PHASE62C_THIN_MAINNET_RUNNER_PROVEN
```

Until `PHASE62C_THIN_MAINNET_RUNNER_PROVEN` is recorded, **mainnet stays blocked**.

### Closure criteria — emitting `RESULT: PHASE62C_THIN_MAINNET_RUNNER_PROVEN`

After a valid Step 5 Sepolia run, the classify output / closure procedure records the token **only if all** of these hold (any missing/failed criterion → token withheld, mainnet remains blocked):

- `paid_probe_outcome: PASS_SETTLED`
- `binding_status: confirmed`
- `facilitator_hash_agrees: true`
- `phase6_settlements_identified: 1`
- `unattributed_settlements_found: 0`
- balance delta == quote (`actual_spend_atomic == quote_atomic`)
- thin runner path confirmed: `runX402PaidSettlement → executeThinX402Settlement → executeSingleX402Settlement` (regression-guarded by `tests/unit/trustforge-x402-settlement-call-chain.test.ts`)
- strict no-mainnet during the regression (no `BUYER_PRIVATE_KEY`, no `X402_USE_MAINNET`)

## Out of scope (separate milestone)

Rich-tx-explainer mainnet path (`runRichTxExplainerPhase3`) — product demo; not first settlement gate.
