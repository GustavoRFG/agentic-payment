# First Real Mainnet Payment V1 — Golden Trace

**ID:** `FIRST_REAL_MAINNET_PAYMENT_V1`  
**GOLDEN_TRACE_STATUS:** `CONFIRMED`

## Productive baseline

| Field | Value |
|---|---|
| Productive HEAD | `2806977c5e653e4b70ecb88f990c42e3824b2f5c` |
| Ancestry | `4595fa5 → 2806977` |
| Evidence run | `D:\trustforge\artifacts\runs\first-real-payment\run_20260812_035951` |
| Final result | `FIRST_REAL_PAYMENT_CONFIRMED` |
| Tx | `0x7be853241d0ca2c73c2926a9ad510471657dd8a74b271c9979f1e9a1d63ce72d` |
| On-chain | `ONCHAIN_VERIFIED` (Base / 8453) |

## Canary economics

- Buyer: `0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1`
- Asset: Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- PayTo: `0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea`
- Amount: `1000` atomic = `0.001` USDC
- Request: `GET https://api.onesource.io/api/chain/block-number?network=ethereum`

## Counts

```text
signatures = 1
payment-bearing requests = 1
retry = 0
resend = 0
```

## Authority sequence (structural)

```text
fresh unpaid 402
→ exact requirements gate
→ attempt / nonce / unsigned
→ BuyerSigningAuthorization
→ CredentialAccessAuthorization
→ real EIP-3009 signature
→ POST_SIGN_JIT_AUDIT_PASS
→ PaymentSendAuthorization
→ SEND_COMMITTED_NO_RETRY
→ B371 productive one-shot send
→ RESPONSE_OBSERVED
→ ONCHAIN_VERIFIED
```

## Do not reuse

Never reuse this run’s nonce, signature, unsigned artifact, PSA, payment header, or send authorization.

Machine-readable mirror: `config/trustforge_first_mainnet_payment_v1.json`  
Loader/compare: `tools/trustforge/first-mainnet-payment-golden-trace.ts`
