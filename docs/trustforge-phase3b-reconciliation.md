# TrustForge Phase 3B — On-chain settlement reconciliation

Phase 3B is **strictly no-payment**. It reconciles possible Phase 3 Zapper settlements using read-only Base USDC `Transfer` logs.

## What happened in Phase 3

- Three paid rich tx_explainer attempts returned saved Zapper seller bodies.
- The orchestrator saved `transaction_hash: null` because no settlement hash was decoded from payment-response headers.
- Initial verifier false positives were fixed in commit `ef10841`.
- Human BaseScan balance observation suggested two real `0.001125 USDC` settlements.

## Phase 3B outcomes

- **Zapper response was not factually wrong** on core identity fields (tx hash, block, addresses).
- **Response was incomplete** under v0.1 methodology (`status`, structured `amount` missing).
- **No passing TrustScore** is produced for this case.
- **Chain reconciliation** via `eth_getLogs` is the accounting backstop when header settlement evidence is missing.

## Commands

```powershell
npm run trustforge:rich-tx-explainer:phase3b
npm run trustforge:rich-tx-explainer:reconcile-settlements -- --wallet 0x4CF373373aba89b9BbD5a428fD71831bcBc7D0c1 --from-block 47310000 --to-block latest --out D:\trustforge\artifacts\runs\rich-tx-explainer-phase3b-reconciliation\reconcile.json
```

## Future rich probes

Persist sanitized payment-response metadata and run chain reconciliation before emitting `actual_spend_usdc` when saved settlement evidence is absent.
