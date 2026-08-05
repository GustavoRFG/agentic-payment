import { describe, expect, it } from "vitest";
import {
  BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
  BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH,
  HUMAN_AUTHORIZATION_DEFAULT_TTL_SECONDS,
  REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
  REJECTED_PAYMENT_REQUIREMENTS_REQUEST_BINDING_MISMATCH,
  REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_INVALID,
  REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_MISSING,
  REJECTED_PAYMENT_REQUIREMENTS_VERSION_UNSUPPORTED,
  SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS,
  authorizationExpiresAt,
  calculateEffectiveSigningDeadline,
  canonicalJsonSha256,
  parseAndBindSellerPaymentRequirements,
  validateFutureBuyerValidBefore,
  validatePersistedSellerRequirementsObservation,
  type SellerRequirementsObservation,
} from "../../tools/trustforge/x402-seller-requirements-binding";

const REQUEST_HASH = "a".repeat(64);
const NETWORK = "eip155:8453";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea";

function v1Requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: "1000",
    resource: "https://seller.example/paid",
    description: "paid resource",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    asset: ASSET,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}

function v2Requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "1000",
    asset: ASSET,
    payTo: PAY_TO,
    maxTimeoutSeconds: 3600,
    extra: { name: "USD Coin", version: "2", tags: ["a", "a", "b"] },
    ...overrides,
  };
}

function v2Envelope(requirement = v2Requirement()): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: {
      url: "https://seller.example/paid?network=ethereum",
      description: "OneSource-style paid resource",
      mimeType: "application/json",
    },
    accepts: [requirement],
    extensions: { bazaar: { info: { input: { method: "GET" } } } },
  };
}

function parse(input: {
  envelope: Record<string, unknown>;
  transport?: "header" | "body";
  observedAt?: string;
  requestHash?: string;
}) {
  const transport = input.transport ?? "header";
  return parseAndBindSellerPaymentRequirements({
    headers:
      transport === "header"
        ? {
            "payment-required": Buffer.from(JSON.stringify(input.envelope), "utf8").toString("base64"),
            "www-authenticate":
              'Payment method="tempo", id="seller-id-only", expires="2026-08-05T05:18:29.803Z"',
          }
        : {},
    body: transport === "body" ? input.envelope : null,
    requestBindingSha256: input.requestHash ?? REQUEST_HASH,
    expectedNetwork: NETWORK,
    expectedAsset: ASSET,
    requirementsObservedAt: input.observedAt ?? "2026-08-05T05:13:29.000Z",
  });
}

function requireObservation(result: ReturnType<typeof parse>): SellerRequirementsObservation {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.observation;
}

describe("x402 seller PaymentRequirements binding", () => {
  it("accepts valid x402 v1 legacy body without seller nonce/expiresAt", () => {
    const observation = requireObservation(
      parse({
        transport: "body",
        envelope: { x402Version: 1, accepts: [v1Requirement()] },
      }),
    );
    expect(observation.binding).toMatchObject({
      protocol_version: 1,
      transport: "legacy-body",
      amount_field: "maxAmountRequired",
      amount_atomic: "1000",
      max_timeout_seconds: 60,
    });
    expect(observation.selected_requirements).not.toHaveProperty("nonce");
    expect(observation.selected_requirements).not.toHaveProperty("expiresAt");
  });

  it("accepts a OneSource-style v2 PAYMENT-REQUIRED header without seller nonce/expiresAt", () => {
    const observation = requireObservation(parse({ envelope: v2Envelope() }));
    expect(observation.binding).toMatchObject({
      protocol_version: 2,
      transport: "payment-required-header",
      scheme: "exact",
      network: NETWORK,
      asset: ASSET,
      amount_field: "amount",
      amount_atomic: "1000",
      pay_to: PAY_TO,
      max_timeout_seconds: 3600,
      request_binding_sha256: REQUEST_HASH,
    });
    expect(observation.ancillary_tempo_evidence).toEqual({
      transport: "www-authenticate",
      method: "tempo",
      id: "seller-id-only",
      expires: "2026-08-05T05:18:29.803Z",
      authoritative: false,
      used_as_eip3009_nonce: false,
    });
  });

  it.each([
    [1, "maxAmountRequired"],
    [2, "amount"],
  ])("rejects x402 v%s without its version-specific amount", (version, amountField) => {
    const requirement = version === 1 ? v1Requirement() : v2Requirement();
    delete requirement[amountField];
    const envelope =
      version === 1 ? { x402Version: 1, accepts: [requirement] } : v2Envelope(requirement);
    const result = parse({ envelope, transport: version === 1 ? "body" : "header" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE);
  });

  it("classifies missing and invalid timeout separately", () => {
    const missing = v2Requirement();
    delete missing.maxTimeoutSeconds;
    const missingResult = parse({ envelope: v2Envelope(missing) });
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.code).toBe(REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_MISSING);

    for (const invalid of [0, -1, 1.5, Number.POSITIVE_INFINITY, "300"]) {
      const result = parse({ envelope: v2Envelope(v2Requirement({ maxTimeoutSeconds: invalid })) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_INVALID);
    }
  });

  it("rejects an unknown x402 version", () => {
    const result = parse({ envelope: { ...v2Envelope(), x402Version: 3 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(REJECTED_PAYMENT_REQUIREMENTS_VERSION_UNSUPPORTED);
  });

  it("canonicalizes object property order while preserving array order and duplicates", () => {
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(canonicalJsonSha256({ a: 1, b: 2 }));
    expect(canonicalJsonSha256({ values: ["a", "b"] })).not.toBe(
      canonicalJsonSha256({ values: ["b", "a"] }),
    );
    expect(canonicalJsonSha256({ values: ["a", "a"] })).not.toBe(
      canonicalJsonSha256({ values: ["a"] }),
    );
  });

  it("binds every seller field and excludes requirements_observed_at from both hashes", () => {
    const first = requireObservation(
      parse({ envelope: v2Envelope(), observedAt: "2026-08-05T05:13:29.000Z" }),
    );
    const later = requireObservation(
      parse({ envelope: v2Envelope(), observedAt: "2026-08-05T05:14:29.000Z" }),
    );
    expect(later.binding.canonical_requirements_sha256).toBe(
      first.binding.canonical_requirements_sha256,
    );
    expect(later.binding.canonical_envelope_sha256).toBe(first.binding.canonical_envelope_sha256);

    const requirementChanges: Record<string, unknown>[] = [
      { scheme: "upto" },
      { amount: "1001" },
      { payTo: "0x1111111111111111111111111111111111111111" },
      { network: "eip155:84532" },
      { asset: "0x2222222222222222222222222222222222222222" },
      { maxTimeoutSeconds: 30 },
      { extra: { name: "changed" } },
    ];
    for (const change of requirementChanges) {
      const changedRequirement = v2Requirement(change);
      expect(canonicalJsonSha256(changedRequirement)).not.toBe(
        first.binding.canonical_requirements_sha256,
      );
    }
    const resourceChanged = v2Envelope();
    resourceChanged.resource = { url: "https://seller.example/changed" };
    expect(canonicalJsonSha256(resourceChanged)).not.toBe(first.binding.canonical_envelope_sha256);
    const extensionsChanged = v2Envelope();
    extensionsChanged.extensions = {
      bazaar: { info: { input: { method: "POST", body: { changed: true } } } },
    };
    expect(canonicalJsonSha256(extensionsChanged)).not.toBe(
      first.binding.canonical_envelope_sha256,
    );
  });

  it("rejects non-representable seller JSON before hashing", () => {
    const result = parse({
      envelope: v2Envelope(v2Requirement({ extra: { score: Infinity } })),
      transport: "body",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REJECTED_PAYMENT_REQUIREMENTS_HASH_INVALID");
  });

  it("fails closed on request-binding divergence and hash tampering", () => {
    const observation = requireObservation(parse({ envelope: v2Envelope() }));
    const wrongRequest = validatePersistedSellerRequirementsObservation(observation, "b".repeat(64));
    expect(wrongRequest.valid).toBe(false);
    expect(wrongRequest.reasons.join(" ")).toContain(
      REJECTED_PAYMENT_REQUIREMENTS_REQUEST_BINDING_MISMATCH,
    );

    const tampered: SellerRequirementsObservation = {
      ...observation,
      selected_requirements: { ...observation.selected_requirements, amount: "2000" },
    };
    const validation = validatePersistedSellerRequirementsObservation(tampered, REQUEST_HASH);
    expect(validation.valid).toBe(false);
    expect(validation.reasons.join(" ")).toContain(BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH);
  });
});

describe("approved seller freshness and buyer-validity policy", () => {
  it("uses the seller timeout when it is the smallest deadline", () => {
    const result = calculateEffectiveSigningDeadline({
      paytimeRequirementsObservedAt: "2026-08-05T05:00:00.000Z",
      maxTimeoutSeconds: 30,
      humanAuthorizationExpiresAt: "2026-08-05T05:15:00.000Z",
      now: new Date("2026-08-05T05:00:01.000Z"),
    });
    expect(result.effective_signing_deadline).toBe("2026-08-05T05:00:30.000Z");
  });

  it("uses the local 300-second cap and then the human expiry when each is smallest", () => {
    expect(SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS).toBe(300);
    const local = calculateEffectiveSigningDeadline({
      paytimeRequirementsObservedAt: "2026-08-05T05:00:00.000Z",
      maxTimeoutSeconds: 3600,
      humanAuthorizationExpiresAt: "2026-08-05T05:15:00.000Z",
      now: new Date("2026-08-05T05:00:01.000Z"),
    });
    expect(local.effective_signing_deadline).toBe("2026-08-05T05:05:00.000Z");

    const human = calculateEffectiveSigningDeadline({
      paytimeRequirementsObservedAt: "2026-08-05T05:00:00.000Z",
      maxTimeoutSeconds: 3600,
      humanAuthorizationExpiresAt: "2026-08-05T05:02:00.000Z",
      now: new Date("2026-08-05T05:00:01.000Z"),
    });
    expect(human.effective_signing_deadline).toBe("2026-08-05T05:02:00.000Z");
  });

  it("marks a pay-time observation stale without considering selection observation", () => {
    const result = calculateEffectiveSigningDeadline({
      paytimeRequirementsObservedAt: "2026-08-05T05:00:00.000Z",
      maxTimeoutSeconds: 60,
      humanAuthorizationExpiresAt: "2026-08-05T05:15:00.000Z",
      now: new Date("2026-08-05T05:01:00.000Z"),
    });
    expect(result.stale).toBe(true);
  });

  it("enforces default/max human TTL and future validBefore bound", () => {
    expect(HUMAN_AUTHORIZATION_DEFAULT_TTL_SECONDS).toBe(900);
    expect(authorizationExpiresAt("2026-08-05T05:00:00.000Z")).toBe(
      "2026-08-05T05:15:00.000Z",
    );
    expect(() => authorizationExpiresAt("2026-08-05T05:00:00.000Z", 1801)).toThrow(
      BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
    );
    expect(
      validateFutureBuyerValidBefore("1785906299", "2026-08-05T05:05:00.000Z").valid,
    ).toBe(true);
    const over = validateFutureBuyerValidBefore(
      "1785906301",
      "2026-08-05T05:05:00.000Z",
    );
    expect(over.valid).toBe(false);
    expect(over.reason).toContain(BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID);
  });
});
