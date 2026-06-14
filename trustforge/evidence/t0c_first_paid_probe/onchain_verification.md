# MVP-T0C — First External Paid TrustForge Probe (on-chain verified)

This directory holds the committed evidence for the first real, externally
settled TrustForge paid probe. The verbose, per-step run artifacts live (locally,
git-ignored) under
`D:\trustforge\artifacts\runs\fast-track-e2e\run_20260614_010720\`.

## Summary

- **Status:** `PASS` (state machine reached `PASS`)
- **Run id:** `t0c_20260613_215339`
- **Policy:** `onesource_api_chain_id_base_mainnet_v1`
- **Service:** `onesource_api_chain_id`
- **Endpoint:** `https://api.onesource.io/api/chain/chain-id?network=ethereum` (GET)
- **Network:** `eip155:8453` (Base mainnet) — **asset:** USDC
- **Observed quote:** 0.001 USDC — **actual spend:** 0.001 USDC (cap 0.005 USDC)
- **Payment attempts:** 1 — **payment-bearing HTTP requests:** 1 — **retry:** none — **fallback:** none
- **Wallet fingerprint:** `49b14ebd8f578d41` (sha256 prefix of the lowercased buyer address; not the address or key)

## Paid response (semantic)

- HTTP 200, parseable body `{"data":{"result":"0x1"},...}` → observed chain id resolves to **1** (Ethereum mainnet)
- Independent `eth_chainId` ground truth **before and after** both returned `0x1` (publicnode + cloudflare)
- `semantic_correctness: pass`

## On-chain settlement verification — `ONCHAIN_VERIFIED`

- **Transaction:** `0xb445f8c1091a55ac35d23db38371a0e0d0bbb0bf2564e3ddf9843abea70cfb11`
- **Basescan:** https://basescan.org/tx/0xb445f8c1091a55ac35d23db38371a0e0d0bbb0bf2564e3ddf9843abea70cfb11
- Verified via Base mainnet RPC `eth_getTransactionReceipt`:
  - chain context `eth_chainId` = `0x2105` = **8453**
  - receipt `status` = `0x1` (**success**)
  - log emitter / `to` = `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` = **Base mainnet USDC**
  - ERC-20 `Transfer` (`0xddf252ad…`): from `0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1` (buyer/authorizer) → `0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea` (seller)
  - amount `data` = `0x3e8` = **1000 atomic = 0.001 USDC** (== expected, ≤ 5000 atomic cap)
  - EIP-3009 `AuthorizationUsed` event present; tx `from` = facilitator `0xb87e1a2cc2b4643f2892768e80e41167f17c5860` (gasless relay — sender ≠ buyer wallet, as expected)
  - Authorizer fingerprint check: `sha256("0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1")[:16]` = `49b14ebd8f578d41` = probe `wallet_fingerprint` ✓

## Derived artifacts (this directory)

- `probe_run.json` — first real `ProbeRun` (schema `trustforge_probe_run` 0.1.0), validates against contract
- `evaluation_result.json` — first real `EvaluationResult` (deterministic, LLM-free): status `pass`, composite `1.0`
- `trust_score.json` — first real `TrustScore`: composite `1.0`, `sample_size=1`, `confidence=low`, `regression_flag=false`, methodology `trustforge-bootstrap-v0.1.0`, commercial disclosure present

## Notes / known gaps

- Per-request `latency_ms` was not captured by the one-shot executor; it is recorded as `null` in the
  ProbeRun. The active ServiceEvalTask has no latency verifier, so this does not affect the composite or
  PASS status. Capturing real latency in the executor is a candidate follow-up.
- No secrets, private keys, mnemonics, `.env` contents, signed payloads, `X-PAYMENT`, or `PAYMENT-SIGNATURE`
  values are stored in this evidence.
