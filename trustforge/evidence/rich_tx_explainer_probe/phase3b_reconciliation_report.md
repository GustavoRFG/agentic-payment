# Saved artifact gaps

- Phase 3 runs saved seller response bodies but not payment-response header metadata.
- probe_run.payment.transaction_hash remained null in all three runs.
- actual_spend_usdc in RESULT was null despite possible on-chain settlement.
- trust_score_rich.json was written by stale orchestrator before ef10841 guard.

Chain reconciliation found 2 Zapper-sized outbound transfers.