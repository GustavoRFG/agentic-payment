import { describe, expect, it } from "vitest";
import {
  validateHumanPaymentAuthorization,
  type HumanPaymentAuthorization,
  type TargetSelectionAuditMetadata,
} from "../../tools/trustforge/validate-human-payment-authorization";

const selected = {
  provider: "Zapper",
  service_id: "zapper_tx_explainer",
  endpoint: "https://public.zapper.xyz/x402/transaction-details",
};

const validAuth: HumanPaymentAuthorization = {
  authorization_schema_version: "trustforge_paid_probe_authorization.v1",
  decision: "authorize_one_payment",
  provider: "Zapper",
  service_id: "zapper_tx_explainer",
  endpoint: "https://public.zapper.xyz/x402/transaction-details",
  max_usdc: "0.10",
  max_payment_attempts: 1,
  allow_retry: false,
  require_dedicated_wallet: true,
  decided_at: "2026-06-15T03:30:00-03:00",
  rationale: "authorized once",
};

const audit: TargetSelectionAuditMetadata = {
  selected_resource_url: "https://public.zapper.xyz/x402/transaction-details",
  handshake_status: "live_402_ok",
  fallback_resource_urls: ["https://fallback.example/x402"],
  scoring_rationale: ["price ascending", "handshake live_402_ok"],
};

describe("validateHumanPaymentAuthorization", () => {
  it("accepts valid authorization", () => {
    const result = validateHumanPaymentAuthorization(validAuth, selected);
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects wrong decision", () => {
    const result = validateHumanPaymentAuthorization(
      { ...validAuth, decision: "PENDING" },
      selected,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects provider mismatch", () => {
    const result = validateHumanPaymentAuthorization(
      { ...validAuth, provider: "Other" },
      selected,
    );
    expect(result.valid).toBe(false);
  });

  it("accepts matching target selection audit metadata", () => {
    const result = validateHumanPaymentAuthorization(
      { ...validAuth, target_selection_audit: audit },
      { ...selected, target_selection_audit: audit },
    );
    expect(result.valid).toBe(true);
  });

  it("rejects target selection audit selected URL mismatch", () => {
    const result = validateHumanPaymentAuthorization(
      validAuth,
      {
        ...selected,
        target_selection_audit: {
          ...audit,
          selected_resource_url: "https://other.example/x402",
        },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain(
      "selected_candidate target_selection_audit selected_resource_url mismatch vs selected_candidate",
    );
  });

  it("rejects conflicting authorization and selected audit metadata", () => {
    const result = validateHumanPaymentAuthorization(
      {
        ...validAuth,
        target_selection_audit: {
          ...audit,
          scoring_rationale: ["different rationale"],
        },
      },
      { ...selected, target_selection_audit: audit },
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain(
      "authorization target_selection_audit mismatch vs selected_candidate",
    );
  });
});
