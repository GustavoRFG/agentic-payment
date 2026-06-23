import { describe, expect, it } from "vitest";

import {
  classifyThinSettlementOutcome,
  type ThinSettlementOutcomeInput,
} from "../../tools/trustforge/thin-settlement-outcome";
import type { SettlementBindingRecord } from "../../tools/trustforge/settlement-run-binding";

function confirmedBinding(): SettlementBindingRecord {
  return {
    attempt_id: "attempt_1",
    run_id: "run_1",
    authorization_hash: "hash",
    settlement_tx_hash: "0xabc",
    actual_spend_atomic: "1000",
    settlement_status: "confirmed",
    block_number: "1",
    matched_by: ["independent"],
    facilitator_hash_agrees: true,
    facilitator_hash_cross_check: "agree",
    facilitator_reported_hash: "0xabc",
    reconciler_found_hash: "0xabc",
    facilitator_receipt: {
      source: "payment-response-header",
      parse_status: "parsed",
      transaction_hash: "0xabc",
    },
    independent_match: {
      settlement_tx_hash: "0xabc",
      block_number: 1,
      timestamp_utc: "2026-06-21T00:00:00.000Z",
      actual_spend_atomic: "1000",
    },
    current_attempt_candidates_after_filter: 1,
    rejected_candidates: [],
    detail: "confirmed",
  };
}

function settledInput(overrides: Partial<ThinSettlementOutcomeInput> = {}): ThinSettlementOutcomeInput {
  return {
    httpStatus: 200,
    paymentAttempted: true,
    paymentBearingHttpRequestCount: 1,
    facilitatorReceiptParseStatus: "parsed",
    facilitatorReceiptPresent: true,
    onChainBindingConfirmed: true,
    balanceIdentityPass: true,
    noNewOutboundTransfer: false,
    reconciliationUnavailable: false,
    reconciliationStatus: "RECONCILIATION_PASS",
    binding: confirmedBinding(),
    invariantsOk: true,
    ...overrides,
  };
}

describe("classifyThinSettlementOutcome", () => {
  it("PASS_SETTLED when payment, 200, binding confirmed, balance pass", () => {
    expect(classifyThinSettlementOutcome(settledInput())).toBe("PASS_SETTLED");
  });

  it("FAIL when 200 + payment evidence but no on-chain Transfer", () => {
    expect(
      classifyThinSettlementOutcome(
        settledInput({
          onChainBindingConfirmed: false,
          binding: null,
        }),
      ),
    ).toBe("FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN");
  });

  it("PASS_NO_SETTLE_CLEAN when non-200 and no outbound transfer", () => {
    expect(
      classifyThinSettlementOutcome(
        settledInput({
          httpStatus: 402,
          paymentAttempted: false,
          paymentBearingHttpRequestCount: 0,
          facilitatorReceiptPresent: false,
          facilitatorReceiptParseStatus: "missing",
          onChainBindingConfirmed: false,
          noNewOutboundTransfer: true,
          binding: null,
        }),
      ),
    ).toBe("PASS_NO_SETTLE_CLEAN");
  });

  it("FAIL when facilitator hash mismatches independent match", () => {
    const binding = {
      ...confirmedBinding(),
      settlement_status: "hash_mismatch" as const,
      facilitator_hash_cross_check: "disagree" as const,
    };
    expect(
      classifyThinSettlementOutcome(
        settledInput({
          binding,
          onChainBindingConfirmed: false,
        }),
      ),
    ).toBe("FAIL_SETTLEMENT_HASH_MISMATCH");
  });

  it("never maps RPC unavailable to settlement-not-found or no-settle-clean", () => {
    const outcome = classifyThinSettlementOutcome(
      settledInput({
        reconciliationUnavailable: true,
        paymentAttempted: false,
        noNewOutboundTransfer: true,
      }),
    );
    expect(outcome).toBe("BLOCKED_RECONCILIATION_UNAVAILABLE");
  });
});
