import {
  BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS,
  HUMAN_AUTHORIZATION_DEFAULT_TTL_SECONDS,
  SIGNED_BUT_NOT_SENT_POLICY,
  authorizationExpiresAt,
  parseAndBindSellerPaymentRequirements,
  type SellerRequirementsObservation,
} from "../../tools/trustforge/x402-seller-requirements-binding";

export const TEST_REQUIREMENTS_OBSERVED_AT = "2026-08-05T05:00:00.000Z";
export const TEST_AUTHORIZATION_DECIDED_AT = "2026-08-05T05:01:00.000Z";

export function sellerRequirementsFixture(input: {
  readonly requestBindingSha256: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly maxTimeoutSeconds?: number;
  readonly endpoint?: string;
  readonly observedAt?: string;
  readonly extra?: Record<string, unknown>;
}): SellerRequirementsObservation {
  const requirement = {
    scheme: "exact",
    network: input.network,
    amount: input.amountAtomic,
    asset: input.asset,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 300,
    extra: input.extra ?? { name: "USD Coin", version: "2" },
  };
  const envelope = {
    x402Version: 2,
    resource: {
      url: input.endpoint ?? "https://seller.example/paid",
      description: "deterministic x402 v2 test fixture",
      mimeType: "application/json",
    },
    accepts: [requirement],
  };
  const result = parseAndBindSellerPaymentRequirements({
    headers: {
      "payment-required": Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
    },
    body: null,
    requestBindingSha256: input.requestBindingSha256,
    expectedNetwork: input.network,
    expectedAsset: input.asset,
    requirementsObservedAt: input.observedAt ?? TEST_REQUIREMENTS_OBSERVED_AT,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.observation;
}

export function selectedCandidateSellerFields(observation: SellerRequirementsObservation) {
  const binding = observation.binding;
  return {
    schema_version: "trustforge_selected_candidate.v2" as const,
    protocol_version: binding.protocol_version,
    transport: binding.transport,
    scheme: binding.scheme,
    amount_field: binding.amount_field,
    max_timeout_seconds: binding.max_timeout_seconds,
    resource: binding.resource,
    extra: binding.extra,
    canonical_requirements_sha256: binding.canonical_requirements_sha256,
    canonical_envelope_sha256: binding.canonical_envelope_sha256,
    selection_requirements_observed_at: observation.requirements_observed_at,
    ancillary_tempo_evidence: observation.ancillary_tempo_evidence,
    seller_requirements: observation,
  };
}

export function humanAuthorizationSellerFields(
  observation: SellerRequirementsObservation,
  options: {
    readonly maximumAuthorizedAmountAtomic?: string;
    readonly decidedAt?: string;
    readonly ttlSeconds?: number;
  } = {},
) {
  const binding = observation.binding;
  const decidedAt = options.decidedAt ?? TEST_AUTHORIZATION_DECIDED_AT;
  const ttlSeconds = options.ttlSeconds ?? HUMAN_AUTHORIZATION_DEFAULT_TTL_SECONDS;
  return {
    authorization_schema_version: "trustforge_paid_probe_authorization.v2",
    canonical_requirements_sha256: binding.canonical_requirements_sha256,
    canonical_envelope_sha256: binding.canonical_envelope_sha256,
    x402_version: binding.protocol_version,
    scheme: binding.scheme,
    network: binding.network,
    asset: binding.asset,
    pay_to: binding.pay_to,
    amount_atomic: binding.amount_atomic,
    maximum_authorized_amount_atomic:
      options.maximumAuthorizedAmountAtomic ?? binding.amount_atomic,
    decided_at: decidedAt,
    authorization_ttl_seconds: ttlSeconds,
    authorization_expires_at: authorizationExpiresAt(decidedAt, ttlSeconds),
    buyer_nonce_policy: "cryptographic_random_32_bytes_per_attempt",
    buyer_validity_policy: {
      valid_after_clock_skew_seconds: BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS,
      valid_before_must_not_exceed: "effective_signing_deadline",
      signed_but_not_sent: SIGNED_BUT_NOT_SENT_POLICY,
    },
    requirements_refresh_policy: "exact_hash_match_before_signing",
  } as const;
}
