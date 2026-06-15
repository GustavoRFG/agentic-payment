# TrustForge canonical on-chain settlement ledger

The blockchain is the sole source of truth for USDC settlement. Seller HTTP responses,
orchestrator RESULT files, and saved payment headers are **claims** to be reconciled
against on-chain `Transfer` events — never treated as proof.

## Tooling

Read-only reconciliation (no wallet, no private keys):

```powershell
npm run trustforge:onchain:reconcile
```

Or directly:

```powershell
python tools/run-onchain-settlement-reconciliation.py --output-dir D:\trustforge\artifacts\runs\onchain-reconciliation\run_<stamp>
```

Environment override: `BASE_RPC_URLS` (comma-separated).

## Outputs

- `onchain_settlement_ledger.json` — versioned canonical ledger
- `onchain_settlement_ledger.md` — human-readable table
- `RESULT.txt` — machine summary

## Buyer wallet

`0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1` on Base mainnet USDC
(`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`).

When a historical RESULT reports `actual_spend: null` but this ledger lists an
outbound transfer, the RESULT was wrong; this ledger is the reconciled correction
without rewriting immutable run artifacts.
