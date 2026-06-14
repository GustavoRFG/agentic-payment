import { describe, expect, it } from "vitest";
import {
  TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV,
  TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_VALUE,
  TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV,
  TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE,
  TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV,
  TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV,
  validateRichHumanGates,
  ZAPPER_TX_EXPLAINER_POLICY,
} from "../../tools/trustforge/rich-tx-explainer-policy";
import { discoverRichTxExplainerEndpoints } from "../../tools/trustforge/rich-tx-explainer-discovery";

describe("rich tx explainer policy and discovery", () => {
  it("blocks wallet gate when rich authorization missing", () => {
    const gate = validateRichHumanGates({});
    expect(gate.authorized).toBe(false);
    expect(gate.missingItems.length).toBeGreaterThan(0);
  });

  it("authorizes when all gates present", () => {
    const gate = validateRichHumanGates({
      [TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV]:
        TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_VALUE,
      [TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV]: TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE,
      [TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV]: "rich_tx_test",
      [TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV]: "0.10",
      BUYER_PRIVATE_KEY: "0x" + "1".repeat(64),
    });
    expect(gate.authorized).toBe(true);
    expect(gate.blockedReason).toBeNull();
  });

  it("rejects cap above 0.25", () => {
    const gate = validateRichHumanGates({
      [TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV]:
        TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_VALUE,
      [TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV]: TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE,
      [TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV]: "rich_tx_test",
      [TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV]: "0.30",
      BUYER_PRIVATE_KEY: "0x" + "1".repeat(64),
    });
    expect(gate.authorized).toBe(false);
    expect(gate.blockedReason).toBe("BLOCKED_CAP_TOO_HIGH");
  });

  it("discovers Zapper equivalent from cached Bazaar (no OATP)", () => {
    const report = discoverRichTxExplainerEndpoints({ capUsdc: "0.10" });
    expect(report.oatp_found).toBe(false);
    expect(report.discovery_status).toBe("FOUND_EQUIVALENT");
    expect(report.selected_policy_id).toBe(ZAPPER_TX_EXPLAINER_POLICY.policyId);
  });

  it("policy enforces one payment attempt max", () => {
    expect(ZAPPER_TX_EXPLAINER_POLICY.maxPaymentAttempts).toBe(1);
    expect(ZAPPER_TX_EXPLAINER_POLICY.allowRetries).toBe(false);
    expect(ZAPPER_TX_EXPLAINER_POLICY.allowFallback).toBe(false);
  });
});
