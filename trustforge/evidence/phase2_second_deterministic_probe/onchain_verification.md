# Phase 2 — Second Deterministic TrustForge Probe (on-chain verified)

Second real, externally settled TrustForge paid probe. The verbose per-step run
artifacts live (locally, git-ignored) under
`D:\trustforge\artifacts\runs\phase2-temporal-semantic\run_20260614_025015\paid_exec\`.

## Summary

- **Status:** `PASS` (state machine reached `PASS`)
- **Run id:** `phase2_20260613_233553`
- **Policy:** `onesource_api_block_number_base_mainnet_v1`
- **Service:** `onesource_api_block_number`
- **Endpoint:** `https://api.onesource.io/api/chain/block-number?network=ethereum` (GET)
- **Network:** `eip155:8453` (Base mainnet) — **asset:** USDC
- **Observed quote:** 0.001 USDC — **actual spend:** 0.001 USDC (cap 0.005 USDC)
- **Payment attempts:** 1 — **payment-bearing HTTP requests:** 1 — **retry:** none — **fallback:** none
- **Wallet fingerprint:** `49b14ebd8f578d41` (same wallet as T0C; reuse explicitly authorized by the operator)

## Paid response (semantic — block-number tolerance window)

- HTTP 200, parseable body `{"data":{"result":"0x1824025"},...}` → observed Ethereum L1 block **25313317**
- Independent `eth_blockNumber` ground truth **before and after** both returned **25313317**
  (publicnode + drpc + 1rpc; ≥2 independent confirmations required)
- Acceptance window `[before-5, after+5] = [25313312, 25313322]` → observed 25313317 is inside
- `semantic_correctness: pass`

## On-chain settlement verification — `ONCHAIN_VERIFIED`

- **Transaction:** `0xff5ec5e20c42aff2d6d96b7854441a0d0357178a2263f02ea381a00db12d26d4`
- **Basescan:** https://basescan.org/tx/0xff5ec5e20c42aff2d6d96b7854441a0d0357178a2263f02ea381a00db12d26d4
- Verified via Base mainnet RPC `eth_getTransactionReceipt`:
  - chain context `eth_chainId` = `0x2105` = **8453**
  - receipt `status` = `0x1` (**success**)
  - log emitter / `to` = `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` = **Base mainnet USDC**
  - ERC-20 `Transfer` (`0xddf252ad…`): from `0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1` (buyer/authorizer) → `0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea` (seller)
  - amount `data` = `0x3e8` = **1000 atomic = 0.001 USDC** (== expected quote, ≤ 5000 atomic cap)
  - EIP-3009 `AuthorizationUsed` event present; tx `from` = facilitator `0xb87e1a2cc2b4643f2892768e80e41167f17c5860` (gasless relay — sender ≠ buyer wallet, as expected)
  - Authorizer fingerprint check: `sha256("0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1")[:16]` = `49b14ebd8f578d41` = probe `wallet_fingerprint` ✓
  - Settlement included in Base block `0x2d1e804` (47310852)

## Notes

- Per-request `latency_ms` is `null` (the one-shot executor does not capture it); the active
  ServiceEvalTask has no latency verifier, so the composite/PASS are unaffected.
- No secrets, private keys, mnemonics, `.env` contents, signed payloads, `X-PAYMENT`, or
  `PAYMENT-SIGNATURE` values are stored in this evidence.
- This wallet is the same address used for T0C; the operator explicitly authorized reusing it
  for this Phase 2 probe (`wallet_fingerprint_differs_from_t0c: no`).
