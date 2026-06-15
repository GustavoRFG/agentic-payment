import { describe, expect, it } from "vitest";
import {
  validateHumanPaymentAuthorization,
  type HumanPaymentAuthorization,
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
});
