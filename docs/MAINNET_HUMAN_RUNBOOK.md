# MAINNET_HUMAN_RUNBOOK — first thin x402 mainnet settlement (human-executed)

**Precondition:** `PHASE62C_THIN_MAINNET_RUNNER_PROVEN` (Step 5 Sepolia PASS, run
`run_20260704_003438`, tx `0x382487eed4f79a6d4a3e29402ee1ead1ecd3ae4ebe9f757a3c2c71cc625bba93`).
The runner is proven; **the runner being proven is not a payment authorization.** Every gate below
that involves a key, an authorization, paid discovery, or a mainnet settle is **HUMAN-ONLY** — the
agent stops before all of them.

## 0. Operational gates (verified read-only; the wallet match is a human gate)

| Gate | Expected | Verified |
|---|---|---|
| chain id | `8453` (`MAINNET_CHAIN_ID`) | yes (config) |
| caip2 | `eip155:8453` (`MAINNET_NETWORK`) | yes |
| asset | Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (`MAINNET_USDC_ADDRESS`) | yes |
| env required | **only** `BUYER_PRIVATE_KEY` (`MAINNET_BUYER_PRIVATE_KEY_ENV`) | yes |
| `SEPOLIA_BUYER_PRIVATE_KEY` on mainnet | **refused** (`assertProfileEnvBeforeSettlement`) | yes |
| expected wallet | `0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1` (`MAINNET_BUYER_WALLET`) | **human gate** — do NOT load the key to check; the preflight asserts wallet==config at pay time (`BLOCKED_WRONG_WALLET`) |
| RPC | `TRUSTFORGE_BASE_RPC_URL` + configurable `--rpc-request-timeout-seconds`; fallback only via explicit `TRUSTFORGE_BASE_RPC_FALLBACK_URLS` (≤3), **no silent fallback** | yes |
| freshness | no stale endpoint/quote/payTo/authorization reused; each attempt starts from a fresh discovery | enforced by pay-time freshness preflight |

## 1. Fresh discovery — STOP before any PAID request

```powershell
cd D:\agentic-payments-lab
node ./seller-api/node_modules/tsx/dist/cli.mjs tools/run-trustforge-targets-discover.ts `
  --network mainnet --output "<mainnet_run>/target_selection.json"
```
Then adapt with `--thin` (primary endpoint from discovery, not the rich allowlist):
```powershell
node ./seller-api/node_modules/tsx/dist/cli.mjs tools/run-trustforge-adapt-discovered-target.ts `
  --target-selection "<mainnet_run>/target_selection.json" `
  --output "<mainnet_run>/selected_candidate.json" --thin
```
Confirm `selected_candidate.json` shape: `network: eip155:8453`, a fresh `endpoint`, `quote_atomic`,
`authorized_pay_to`, `asset == 0x8335…2913`. **Discovery is unpaid; the paid probe is later and human-gated.**

## 2. Preflight (read-only balances/quote) — no payment yet

```powershell
# BUYER_PRIVATE_KEY + TRUSTFORGE_BASE_RPC_URL in session (human)
node ./seller-api/node_modules/tsx/dist/cli.mjs tools/run-trustforge-sepolia-preflight.ts `
  --run-dir "<mainnet_run>"   # (mainnet preflight equivalent; confirms wallet==0x4cf3… and USDC balance)
```

## 3. HUMAN GATES — the agent STOPS here. Do these yourself, deliberately:

1. **Load key** — `BUYER_PRIVATE_KEY` for `0x4cf3…d0c1` in-session only. Confirm the address the
   key derives matches the expected wallet (the preflight/settle asserts this; `BLOCKED_WRONG_WALLET`).
2. **Create authorization** — write `<mainnet_run>/human_payment_authorization.json` with
   `decision: authorize_one_payment`, `max_usdc` ≥ the fresh quote. One payment. No retry, no failover.
3. **Settle (exactly one attempt):**
   ```powershell
   node ./seller-api/node_modules/tsx/dist/cli.mjs tools/run-trustforge-x402-paid-settlement.ts `
     --run-dir "<mainnet_run>" --network mainnet
   ```
4. **Classify:**
   ```powershell
   node ./seller-api/node_modules/tsx/dist/cli.mjs tools/run-trustforge-x402-classify.ts `
     --run-dir "<mainnet_run>" --network mainnet
   ```
   Require: `PASS_SETTLED`, `binding_status: confirmed`, `facilitator_hash_agrees: true`,
   `phase6_settlements_identified: 1`, `unattributed_settlements_found: 0`, balance delta == quote.

**Exactly one payment-bearing request. Single-shot. No fallback failover. No retry.**

The agent will not run §3. Loading the key, creating the authorization, and executing the mainnet
settle are your decisions alone.
