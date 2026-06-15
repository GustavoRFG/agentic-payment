/**
 * run-trustforge-rich-invariants — assert settlement-first rich probe invariants.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRichProbeInvariants } from "./trustforge/rich-probe-invariants";
import { runPhase4Replay } from "./run-trustforge-phase4-replay";

async function main(): Promise<number> {
  const replay = await runPhase4Replay();
  if (replay.invariantViolations.length > 0) {
    console.error("INVARIANT FAILURES:");
    for (const violation of replay.invariantViolations) {
      console.error(`- ${violation}`);
    }
    return 1;
  }

  const badQuoteSpend = assertRichProbeInvariants({
    quote_usdc: "0.001125",
    actual_spend_usdc: "0.001125",
    transaction_hash: null,
    transaction_hash_source: null,
    settlement_evidence_status: "missing_header_tx_hash",
    payment_integrity_status: "ambiguous",
    payment_bearing_http_request_count: 1,
    trust_score_rich_created: false,
    semantic_evaluation_status: "incomplete",
    chain_reconciliation_attempted: false,
  });
  if (badQuoteSpend.passed) {
    console.error("expected quote-as-spend invariant to fail");
    return 1;
  }

  const badScore = assertRichProbeInvariants({
    quote_usdc: "0.001125",
    actual_spend_usdc: "0.001125",
    transaction_hash: "0x" + "a".repeat(64),
    transaction_hash_source: "chain_reconciliation",
    settlement_evidence_status: "chain_reconciled",
    payment_integrity_status: "fail",
    payment_bearing_http_request_count: 1,
    trust_score_rich_created: true,
    semantic_evaluation_status: "incomplete",
  });
  if (badScore.passed) {
    console.error("expected trust score with failed payment integrity to fail");
    return 1;
  }

  console.log(
    JSON.stringify({
      status: "PASS",
      phase3b_replay_settlements: replay.reconciledSettlementCount,
      phase3b_replay_total_usdc: replay.actualTotalSpendUsdc,
      trust_score_eligible: replay.trustScoreEligible,
      blocked_reason: replay.positiveScoreBlockedReason,
    }),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main as runRichInvariantsMain };
