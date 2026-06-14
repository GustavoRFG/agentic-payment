import { describe, expect, it } from "vitest";
import {
  TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV,
  TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_VALUE,
  TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV,
  TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE,
  TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV,
  TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV,
  validateRichHumanGates,
} from "../../tools/trustforge/rich-tx-explainer-policy";
import {
  parseRichTxExplainerArgs,
  resolveExecutePaidFlag,
  resolvePaidExecutionEligibility,
  TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID_ENV,
  TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID_VALUE,
} from "../../tools/run-trustforge-rich-tx-explainer";

describe("rich tx explainer orchestrator paid eligibility", () => {
  const armedGate = validateRichHumanGates({
    [TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV]:
      TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_VALUE,
    [TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV]: TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE,
    [TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV]: "rich_tx_test",
    [TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV]: "0.10",
    BUYER_PRIVATE_KEY: "0x" + "1".repeat(64),
  });

  it("parses --execute-paid from argv slice", () => {
    expect(parseRichTxExplainerArgs(["--execute-paid"]).executePaid).toBe(true);
    expect(parseRichTxExplainerArgs(["execute-paid"]).executePaid).toBe(true);
    expect(parseRichTxExplainerArgs([]).executePaid).toBe(false);
  });

  it("resolves execute paid from env when npm strips the dashed flag", () => {
    expect(
      resolveExecutePaidFlag([], {
        [TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID_ENV]:
          TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID_VALUE,
      }),
    ).toBe(true);
  });

  it("rejects unknown cli args", () => {
    expect(() => parseRichTxExplainerArgs(["--dry-run"])).toThrow(
      "unknown argument: --dry-run",
    );
  });

  it("blocks paid execution when --execute-paid is missing", () => {
    const eligibility = resolvePaidExecutionEligibility({
      executePaid: false,
      gate: armedGate,
      unpaidStatus: "PASS",
      hasAllowlistedPolicy: true,
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockedReason).toBe("EXECUTE_PAID_FLAG_MISSING");
  });

  it("allows paid execution when all guards are satisfied", () => {
    const eligibility = resolvePaidExecutionEligibility({
      executePaid: true,
      gate: armedGate,
      unpaidStatus: "PASS",
      hasAllowlistedPolicy: true,
    });
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.blockedReason).toBeNull();
  });

  it("blocks paid execution when human gates are missing", () => {
    const gate = validateRichHumanGates({});
    const eligibility = resolvePaidExecutionEligibility({
      executePaid: true,
      gate,
      unpaidStatus: "PASS",
      hasAllowlistedPolicy: true,
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockedReason).toBe("HUMAN_GATE_MISSING_CAP");
  });

  it("blocks paid execution when unpaid liveness failed", () => {
    const eligibility = resolvePaidExecutionEligibility({
      executePaid: true,
      gate: armedGate,
      unpaidStatus: "FAIL",
      hasAllowlistedPolicy: true,
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockedReason).toBe("UNPAID_LIVENESS_FAILED");
  });
});
