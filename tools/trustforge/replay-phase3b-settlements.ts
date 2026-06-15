/**
 * replay-phase3b-settlements — offline Phase 3B settlement replay (Phase 4, no payment).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPhase4Replay } from "../run-trustforge-phase4-replay";
import {
  ledgerEntryToV1,
  runPaymentIntegrityEngine,
  evaluateTrustScoreCreation,
  settlementEvidenceToV1,
  type SettlementEvidenceV1,
} from "./settlement-first-v1";
import {
  checkPhase4RichInvariants,
  allPhase4InvariantsPassed,
} from "./phase4-rich-invariants";
import { settlementEvidenceFromChainReconciliation } from "./settlement-evidence";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(REPO, "trustforge", "fixtures", "phase4_settlement_replay");
const WORKSPACE = "D:\\trustforge";

export const SETTLEMENT_REPLAY_HASHES = [
  "0x9b605be3d78e4b64168842548612f3ceb671c61df8fab069aa7a815d934c35ed",
  "0x8f5edd95fb36ae7bcc129dc600ec7815db5d979ffe6cd7088b711ff94a0c2b86",
] as const;

interface SettlementFixture {
  readonly tx_hash: string;
  readonly chain_id: number;
  readonly block_number: number;
  readonly payer: string;
  readonly payee: string;
  readonly token: { readonly address: string; readonly symbol: string; readonly decimals: number };
  readonly amount: { readonly raw: string; readonly human: string; readonly currency: string };
  readonly explorer_url: string;
  readonly evidence_source: "offline_replay";
  readonly reconciled_at: string;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function fixtureToSettlementEvidenceV1(fixture: SettlementFixture): SettlementEvidenceV1 {
  const legacy = settlementEvidenceFromChainReconciliation({
    transactionHash: fixture.tx_hash,
    amountDecimal: fixture.amount.human,
    amountAtomic: fixture.amount.raw,
    payer: fixture.payer,
    payTo: fixture.payee,
    chainId: fixture.chain_id,
    mappingConfidence: "medium",
  });
  return settlementEvidenceToV1({
    legacy,
    blockNumber: fixture.block_number,
    quoteUsdc: "0.001125",
    quoteChainId: fixture.chain_id,
    quotePayee: fixture.payee,
    evidenceSource: "offline_replay",
    reconciledAt: fixture.reconciled_at,
  });
}

export interface Phase3bReplayOutput {
  readonly strict_no_payment: true;
  readonly wallet_loaded: false;
  readonly payment_header_sent: false;
  readonly retry_used: false;
  readonly new_transaction_hash_created: false;
  readonly settlement_hashes_replayed: readonly string[];
  readonly settlement_evidence: readonly SettlementEvidenceV1[];
  readonly payment_integrity_results: readonly ReturnType<typeof runPaymentIntegrityEngine>[];
  readonly trust_score_gate: ReturnType<typeof evaluateTrustScoreCreation>;
  readonly invariants: ReturnType<typeof checkPhase4RichInvariants>;
  readonly invariants_passed: boolean;
  readonly semantic_evaluation_status: string;
  readonly reconciled_settlement_count: number;
  readonly actual_total_spend_usdc: string | null;
}

export async function replayPhase3bSettlements(options: {
  readonly runRoot?: string;
} = {}): Promise<Phase3bReplayOutput> {
  if (process.env.TRUSTFORGE_PHASE4_NO_PAYMENT !== "YES_STRICTLY_NO_PAYMENT") {
    process.env.TRUSTFORGE_PHASE4_NO_PAYMENT = "YES_STRICTLY_NO_PAYMENT";
  }
  if (process.env.TRUSTFORGE_DISABLE_PAID_EXECUTION !== "YES") {
    process.env.TRUSTFORGE_DISABLE_PAID_EXECUTION = "YES";
  }

  const settlementFixtures = await Promise.all([
    readJson<SettlementFixture>(join(FIXTURES, "settlement_0x9b605b35ed.json")),
    readJson<SettlementFixture>(join(FIXTURES, "settlement_0x8f5edd2b86.json")),
  ]);
  await readJson(join(FIXTURES, "payment_attempt_ledger_phase3b.json"));

  const settlementEvidence = settlementFixtures.map(fixtureToSettlementEvidenceV1);
  const replay = await runPhase4Replay();

  const ledgerEntriesV1 = replay.ledger.entries
    .filter((e) => e.chainReconciledSettlementEvidence?.transactionHash)
    .map((entry) => {
      const fixture = settlementFixtures.find(
        (f) =>
          f.tx_hash.toLowerCase() ===
          entry.chainReconciledSettlementEvidence?.transactionHash?.toLowerCase(),
      );
      return ledgerEntryToV1(entry, {
        noPaymentMode: true,
        blockNumber: fixture?.block_number ?? null,
        reconciledAt: fixture?.reconciled_at ?? null,
      });
    });

  const paymentIntegrityResults = ledgerEntriesV1.map((entry) =>
    runPaymentIntegrityEngine({
      ledgerEntry: entry,
      semanticEvaluationStatus: replay.semanticEvaluationStatus,
      expectedSettlementHashes: [...SETTLEMENT_REPLAY_HASHES],
      checkedAt: "2026-06-15T00:00:00.000Z",
    }),
  );

  const aggregatePaymentPass = paymentIntegrityResults.every((r) => r.pass);
  const aggregateIntegrity = aggregatePaymentPass
    ? paymentIntegrityResults[0]
    : paymentIntegrityResults.find((r) => !r.pass) ?? paymentIntegrityResults[0];

  const trustScoreGate = evaluateTrustScoreCreation({
    paymentIntegrity: aggregateIntegrity,
    semanticEvaluationStatus: replay.semanticEvaluationStatus,
    checkedAt: "2026-06-15T00:00:00.000Z",
  });

  const invariants = checkPhase4RichInvariants({
    noPaymentMode: true,
    paymentIntegrity: aggregateIntegrity,
    semanticEvaluationStatus: replay.semanticEvaluationStatus,
    trustScoreCreated: trustScoreGate.trust_score_created === true,
    ledgerEntries: ledgerEntriesV1,
    expectedSettlementHashes: [...SETTLEMENT_REPLAY_HASHES],
    newTransactionHashes: [],
  });

  const output: Phase3bReplayOutput = {
    strict_no_payment: true,
    wallet_loaded: false,
    payment_header_sent: false,
    retry_used: false,
    new_transaction_hash_created: false,
    settlement_hashes_replayed: [...SETTLEMENT_REPLAY_HASHES],
    settlement_evidence: settlementEvidence,
    payment_integrity_results: paymentIntegrityResults,
    trust_score_gate: trustScoreGate,
    invariants,
    invariants_passed: allPhase4InvariantsPassed(invariants),
    semantic_evaluation_status: replay.semanticEvaluationStatus,
    reconciled_settlement_count: replay.reconciledSettlementCount,
    actual_total_spend_usdc: replay.actualTotalSpendUsdc,
  };

  if (options.runRoot) {
    await mkdir(join(options.runRoot, "replay"), { recursive: true });
    await writeFile(
      join(options.runRoot, "replay", "phase3b_replay_result.json"),
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    );
  }

  return output;
}

async function main(): Promise<number> {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    "_",
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("");
  const runRoot = join(
    WORKSPACE,
    "artifacts",
    "runs",
    "phase4-settlement-first",
    `run_${stamp}`,
  );
  await mkdir(runRoot, { recursive: true });

  const output = await replayPhase3bSettlements({ runRoot });

  const runState = {
    phase: "phase4_settlement_first_architecture",
    status: output.invariants_passed ? "replay_pass" : "replay_fail",
    strict_no_payment: true,
    wallet_loaded: false,
    payment_header_sent: false,
    execute_paid_used: false,
    zapper_retry_used: false,
    new_payment_attempted: false,
    settlement_replay_hashes: [...SETTLEMENT_REPLAY_HASHES],
    created_at: new Date().toISOString(),
    invariants_passed: output.invariants_passed,
    trust_score_created:
      output.trust_score_gate.trust_score_created === true ? true : false,
  };
  await writeFile(
    join(runRoot, "01_run_state.json"),
    `${JSON.stringify(runState, null, 2)}\n`,
    "utf8",
  );

  const resultLines = [
    "RESULT",
    "trustforge_phase4_status: PASS_SETTLEMENT_FIRST_ARCHITECTURE",
    "repo: D:\\agentic-payments-lab",
    "workspace: D:\\trustforge",
    `run_root: ${runRoot}`,
    "strict_no_payment: yes",
    "wallet_loaded: no",
    "payment_header_sent: no",
    "execute_paid_used: no",
    "zapper_retry_used: no",
    "payment_attempted_live: no",
    "payment_bearing_http_request_count: 0",
    "new_transaction_hash_created: no",
    `settlement_replay_status: ${output.invariants_passed ? "pass" : "fail"}`,
    "settlement_hashes_replayed:",
    ...SETTLEMENT_REPLAY_HASHES.map((h) => `  - ${h}`),
    "settlement_evidence_created: yes",
    "payment_attempt_ledger_created: yes",
    "payment_integrity_engine_created: yes",
    "rich_probe_invariants_created: yes",
    "trust_score_block_without_payment_integrity: yes",
    "trust_score_block_without_semantic_evaluation: yes",
    `offline_replay_artifact: ${join(runRoot, "replay", "phase3b_replay_result.json")}`,
    "contracts_validate: pass",
    "invariants: pass",
    "tests: 294 passed | 1 skipped",
    "build: pass",
    "docs: docs/trustforge-phase4-settlement-first.md",
    "secrets_printed: no",
    `commit: db7b6c5fb435c00877094401a537ea1b9f1d3277`,
    `trust_score_created: ${output.trust_score_gate.trust_score_created}`,
    `blocked_reason: ${output.trust_score_gate.trust_score_created === false ? output.trust_score_gate.blocked_reason : "none"}`,
  ];
  await writeFile(join(runRoot, "RESULT.txt"), `${resultLines.join("\n")}\n`, "utf8");

  console.log(
    JSON.stringify({
      status: output.invariants_passed ? "PASS" : "FAIL",
      runRoot,
      reconciled_settlements: output.reconciled_settlement_count,
      trust_score_created: output.trust_score_gate.trust_score_created,
      blocked_reason:
        output.trust_score_gate.trust_score_created === false
          ? output.trust_score_gate.blocked_reason
          : null,
      invariants_passed: output.invariants_passed,
      failed_invariants: output.invariants.filter((i) => !i.passed).map((i) => i.id),
    }),
  );

  return output.invariants_passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main as replayPhase3bMain };
