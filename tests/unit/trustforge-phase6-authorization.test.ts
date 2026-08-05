import { describe, expect, it } from "vitest";
import {
  validateHumanPaymentAuthorization,
  type HumanPaymentAuthorization,
  type TargetSelectionAuditMetadata,
} from "../../tools/trustforge/validate-human-payment-authorization";
import {
  createThinSettlementRequestBinding,
  thinSettlementRequestSummary,
} from "../../tools/trustforge/thin-settlement-request-binding";

const POST_BINDING = createThinSettlementRequestBinding({
  endpoint: "https://public.zapper.xyz/x402/transaction-details",
  method: "POST",
  input_status: "known",
  query: [],
  body: { hash: "0xabc", chainId: 1 },
});
const GET_BINDING = createThinSettlementRequestBinding({
  endpoint: "https://public.zapper.xyz/x402/transaction-details",
  method: "GET",
  input_status: "known",
  query: { network: "ethereum" },
  body: null,
});

const selected = {
  provider: "Zapper",
  service_id: "zapper_tx_explainer",
  endpoint: "https://public.zapper.xyz/x402/transaction-details",
  method: "POST",
  request_input_status: "known" as const,
  request_query: POST_BINDING.query,
  request_body: POST_BINDING.body,
  request_binding_sha256: POST_BINDING.binding_sha256,
};

const validAuth: HumanPaymentAuthorization = {
  authorization_schema_version: "trustforge_paid_probe_authorization.v1",
  decision: "authorize_one_payment",
  provider: "Zapper",
  service_id: "zapper_tx_explainer",
  endpoint: "https://public.zapper.xyz/x402/transaction-details",
  method: "POST",
  request_binding_sha256: POST_BINDING.binding_sha256,
  request_summary: thinSettlementRequestSummary(POST_BINDING),
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

  it("rejects an authorization with no method", () => {
    const { method: _omitted, ...withoutMethod } = validAuth;
    const result = validateHumanPaymentAuthorization(
      withoutMethod as HumanPaymentAuthorization,
      selected,
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("BLOCKED_AUTHORIZATION_METHOD_MISSING");
  });

  it("rejects a cross-method authorization vs the selected candidate", () => {
    const result = validateHumanPaymentAuthorization({ ...validAuth, method: "GET" }, selected);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("BLOCKED_AUTHORIZATION_METHOD_MISMATCH");
  });

  it("accepts a GET authorization for a GET candidate", () => {
    const result = validateHumanPaymentAuthorization(
      { ...validAuth, method: "GET" },
      {
        ...selected,
        method: "GET",
        request_query: GET_BINDING.query,
        request_body: GET_BINDING.body,
        request_binding_sha256: GET_BINDING.binding_sha256,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH");
  });

  it("accepts a GET authorization whose request binding matches the GET candidate", () => {
    const result = validateHumanPaymentAuthorization(
      {
        ...validAuth,
        method: "GET",
        request_binding_sha256: GET_BINDING.binding_sha256,
        request_summary: thinSettlementRequestSummary(GET_BINDING),
      },
      {
        ...selected,
        method: "GET",
        request_query: GET_BINDING.query,
        request_body: GET_BINDING.body,
        request_binding_sha256: GET_BINDING.binding_sha256,
      },
    );
    expect(result).toEqual({ valid: true, reasons: [] });
  });

  it("rejects missing and mismatched request binding authorization", () => {
    const { request_binding_sha256: _hash, ...withoutHash } = validAuth;
    expect(
      validateHumanPaymentAuthorization(withoutHash as HumanPaymentAuthorization, selected).reasons.join(" "),
    ).toContain("BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING");
    expect(
      validateHumanPaymentAuthorization(
        { ...validAuth, request_binding_sha256: "0".repeat(64) },
        selected,
      ).reasons.join(" "),
    ).toContain("BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH");
  });

  it("compares request_summary semantically instead of by property order", () => {
    const reorderedSummary: HumanPaymentAuthorization["request_summary"] = {
      body: { hash: "0xabc", chainId: 1 },
      query: [],
      endpoint: POST_BINDING.endpoint,
      method: "POST",
    };
    expect(
      validateHumanPaymentAuthorization(
        { ...validAuth, request_summary: reorderedSummary },
        selected,
      ),
    ).toEqual({ valid: true, reasons: [] });
  });

  it("rejects absent or semantically divergent request_summary", () => {
    expect(
      validateHumanPaymentAuthorization(
        { ...validAuth, request_summary: null },
        selected,
      ).reasons.join(" "),
    ).toContain("BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING");

    expect(
      validateHumanPaymentAuthorization(
        {
          ...validAuth,
          request_summary: {
            ...thinSettlementRequestSummary(POST_BINDING),
            body: { hash: "0xdef", chainId: 1 },
          },
        },
        selected,
      ).reasons.join(" "),
    ).toContain("BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH");
  });

  it("detects removed GET query and altered POST body", () => {
    const getAuth: HumanPaymentAuthorization = {
      ...validAuth,
      method: "GET",
      request_binding_sha256: GET_BINDING.binding_sha256,
      request_summary: thinSettlementRequestSummary(GET_BINDING),
    };
    const getSelected = {
      ...selected,
      method: "GET",
      request_query: [],
      request_body: null,
      request_binding_sha256: GET_BINDING.binding_sha256,
    };
    expect(validateHumanPaymentAuthorization(getAuth, getSelected).reasons.join(" ")).toContain(
      "BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH",
    );

    const changedPost = {
      ...selected,
      request_body: { hash: "0xdef", chainId: 1 },
    };
    expect(
      validateHumanPaymentAuthorization(validAuth, changedPost).reasons.join(" "),
    ).toContain("BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH");
  });

  it.each(["PUT", "PATCH", "DELETE", "HEAD"])("rejects unsupported authorized %s", (method) => {
    const result = validateHumanPaymentAuthorization(
      { ...validAuth, method },
      { ...selected, method },
    );
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("BLOCKED_AUTHORIZATION_METHOD_UNSUPPORTED");
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
