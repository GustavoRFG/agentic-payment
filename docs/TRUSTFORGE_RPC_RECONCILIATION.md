# TrustForge Base RPC reconciliation

Read-only on-chain USDC ledger for the TrustForge buyer wallet (`0x4cf3…d0c1`) on Base mainnet (`chainId` **8453**). No wallet load, no signing, no payment.

## Required configuration

| Variable | Required | Description |
|---|---|---|
| `TRUSTFORGE_BASE_RPC_URL` | Recommended | Primary read-only Base JSON-RPC URL (no keys in repo) |
| `TRUSTFORGE_BASE_RPC_FALLBACK_URLS` | Optional | Comma-separated fallback URLs (max **3** total endpoints including primary) |
| `BASE_RPC_URLS` | Legacy | Used only when `TRUSTFORGE_BASE_RPC_URL` is unset |

If none are set, a bounded public fallback list is used (publicnode, drpc, 1rpc, mainnet.base.org, llamarpc).

```powershell
cd D:\agentic-payments-lab
$env:TRUSTFORGE_BASE_RPC_URL = "<your-read-only-base-rpc>"
npm run trustforge:onchain:reconcile
```

Do **not** commit RPC URLs containing API keys. Logs print only redacted hostnames (e.g. `https://base-mainnet.g.alchemy.com/…`).

## RPC health preflight

Before scanning settlements, each endpoint is tried **once** (`maxAttemptsPerEndpoint = 1`, timeout 30s):

1. `eth_chainId` — must be `8453`
2. `eth_blockNumber` — must be positive
3. `eth_getLogs` — small probe window

Primary is tried first; on failure, configured fallbacks are tried once each. If all fail, reconciliation stops with **no settlement classification**.

## Error classes (distinct from settlement failure)

| Status | Meaning |
|---|---|
| `RECONCILIATION_RPC_FORBIDDEN` | HTTP 403 |
| `RECONCILIATION_RPC_RATE_LIMITED` | HTTP 429 |
| `RECONCILIATION_RPC_UNAVAILABLE` | Timeout / connection / generic HTTP |
| `RECONCILIATION_INVALID_RESPONSE` | Malformed JSON-RPC |
| `RECONCILIATION_WRONG_CHAIN` | `chainId != 8453` |
| `RECONCILIATION_PASS` | Scan complete, balance identity pass, all settlements attributed |
| `RECONCILIATION_NO_NEW_SETTLEMENT` | Scan complete, balance pass, zero outbound transfers in window |
| `RECONCILIATION_UNATTRIBUTED_SETTLEMENTS` | On-chain transfers not in known hash list |

**RPC unavailable ≠ settlement not found.** When RPC fails, `unattributed_settlements_found` is `null`, `balance_identity_status` is `not_run`, and `safe_to_use_for_payment_verification` is **false**. Never map RPC errors to `FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN`.

## Success gate (before mainnet payment verification)

Live reconcile output must show:

```txt
rpc_status: pass
chain_id: 8453
unattributed_settlements_found: 0
balance_identity_status: pass
safe_to_use_for_payment_verification: yes
reconciliation_status: RECONCILIATION_PASS or RECONCILIATION_NO_NEW_SETTLEMENT
```

## Three-outcome paid probe model

Paid pipeline outcomes (`tools/trustforge/paid-probe-outcome.ts`):

| Outcome | Condition |
|---|---|
| `PASS_SETTLED` | Payment attempted + on-chain Transfer confirmed + invariants OK |
| `PASS_NO_SETTLE_CLEAN` | No payment attempted, zero payment-bearing HTTP requests |
| `FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN` | Payment attempted but no on-chain confirmation |
| `BLOCKED_RECONCILIATION_UNAVAILABLE` | Reconciliation/RPC unavailable — not clean no-settle |
| `FAIL` | Retry, gate bypass, or other invariant violation |

## Testnet settlement status

TrustForge Phase 6 mainnet gate uses Base mainnet reconciliation. A dedicated **TrustForge Base Sepolia settlement proof for the Zapper discovered target has not been executed** under this pipeline (`TESTNET_SETTLEMENT_NOT_EXECUTED`). Prior MVP Sepolia payments exist in buyer-client docs but are not wired to the Phase 6 discovered-target gate.

Preferred next step after RPC gate passes: one real Base Sepolia settlement (testnet wallet + faucet USDC, single attempt, balance delta == quote, no mainnet key).

## Commands

```powershell
npm run trustforge:onchain:reconcile
python -m pytest tests/test_onchain_settlement_reconciliation.py -q
npm test
```
