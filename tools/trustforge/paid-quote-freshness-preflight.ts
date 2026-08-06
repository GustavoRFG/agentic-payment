/**
 * paid-quote-freshness-preflight — unsigned pay-time 402 re-handshake before key load.
 */

import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { parseUsdcDecimalToAtomic } from "./external-x402-get-policy";
import {
  classifyTargetProbeResponse,
  probeTargetLiveness,
  type RecordedProbeResponse,
  type TargetHandshakeOutcome,
} from "./target-liveness";
import type { TargetCandidate } from "./target-candidates";
import {
  requireThinSettlementRequestBinding,
  type ThinSettlementRequestBinding,
} from "./thin-settlement-request-binding";
import {
  BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH,
  BLOCKED_PAYMENT_REQUIREMENTS_STALE,
  REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED,
  calculateEffectiveSigningDeadline,
  validatePersistedSellerRequirementsObservation,
  type SellerRequirementsObservation,
} from "./x402-seller-requirements-binding";

export interface AuthorizedPaymentQuote {
  readonly endpoint: string;
  readonly method?: TargetCandidate["method"];
  readonly request_binding: ThinSettlementRequestBinding;
  readonly seller_requirements: SellerRequirementsObservation;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
  readonly human_authorization_expires_at?: string;
  readonly quote_amount_usdc: string;
  readonly quote_atomic: string;
  readonly authorized_max_usdc: string;
  readonly pay_to: string;
  readonly seller_network_raw: string;
  readonly canonical_network_caip2: string;
  /** @deprecated Operational alias; must equal canonical_network_caip2. */
  readonly network?: string;
  readonly asset?: string;
}

export interface PaidQuoteFreshnessPreflightResult {
  readonly go: boolean;
  readonly reasons: readonly string[];
  readonly outcome: TargetHandshakeOutcome | null;
  readonly paytime_requirements_observed_at: string | null;
  readonly effective_signing_deadline: string | null;
  readonly fresh_unsigned_402_required_before_signing: boolean;
}

function genericCandidateId(endpoint: string): string {
  return endpoint
    .replace(/^https?:\/\//, "")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "discovered_x402";
}

export function buildProbeCandidateForAuthorizedQuote(
  quote: AuthorizedPaymentQuote,
): TargetCandidate {
  const requestBinding = requireThinSettlementRequestBinding(quote.request_binding);
  if (requestBinding.endpoint !== quote.endpoint) {
    throw new Error("BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH: freshness endpoint differs from binding");
  }
  if (quote.method && requestBinding.method !== quote.method) {
    throw new Error("BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH: freshness method differs from binding");
  }
  const expectedNetwork = quote.canonical_network_caip2;
  const expectedAsset = quote.asset ?? MAINNET_USDC_ADDRESS;
  const requirements = quote.seller_requirements.binding;
  if (
    quote.seller_network_raw !== requirements.seller_network_raw ||
    expectedNetwork !== requirements.canonical_network_caip2 ||
    (quote.network !== undefined && quote.network !== expectedNetwork)
  ) {
    throw new Error(
      `${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: freshness network identity differs from authorized requirements`,
    );
  }
  return {
    candidateId: genericCandidateId(quote.endpoint),
    resourceUrl: quote.endpoint,
    method: requestBinding.method,
    x402Version: requirements.protocol_version,
    freshness: {
      lastUpdated: new Date().toISOString(),
      sortKey: new Date().toISOString(),
    },
    registrationMetadata: {},
    requestBinding,
    requestInputProvenance: "legacy_explicit_request_binding",
    requestBindingError: null,
    accepts: [
      {
        scheme: requirements.scheme,
        network: quote.seller_network_raw,
        sellerNetworkRaw: quote.seller_network_raw,
        canonicalNetworkCaip2: expectedNetwork,
        asset: expectedAsset,
        amountAtomic: quote.quote_atomic,
        payTo: quote.pay_to,
        maxTimeoutSeconds: requirements.max_timeout_seconds,
      },
    ],
  };
}

export function evaluateFresh402AgainstAuthorizedQuote(
  outcome: TargetHandshakeOutcome,
  quote: AuthorizedPaymentQuote,
  now: Date = new Date(),
): PaidQuoteFreshnessPreflightResult {
  const reasons: string[] = [];
  let effectiveSigningDeadline: string | null = null;

  if (outcome.resourceUrl && outcome.resourceUrl !== quote.endpoint) {
    reasons.push(`endpoint mismatch fresh=${outcome.resourceUrl} authorized=${quote.endpoint}`);
  }

  if (outcome.status !== "live_402_ok") {
    reasons.push(`fresh handshake status ${outcome.status}`);
    if (outcome.detail) reasons.push(`fresh handshake detail ${outcome.detail}`);
  }

  const freshRequirements = outcome.sellerRequirements;
  if (!freshRequirements) {
    reasons.push(`${REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED}: fresh 402 binding absent`);
  } else {
    const validation = validatePersistedSellerRequirementsObservation(
      freshRequirements,
      quote.request_binding.binding_sha256,
    );
    reasons.push(...validation.reasons);
    if (
      freshRequirements.binding.canonical_requirements_sha256 !==
      quote.canonical_requirements_sha256
    ) {
      reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: requirements hash mismatch`);
    }
    if (freshRequirements.binding.canonical_envelope_sha256 !== quote.canonical_envelope_sha256) {
      reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: envelope hash mismatch`);
    }
    if (quote.human_authorization_expires_at) {
      try {
        const freshness = calculateEffectiveSigningDeadline({
          paytimeRequirementsObservedAt: freshRequirements.requirements_observed_at,
          maxTimeoutSeconds: freshRequirements.binding.max_timeout_seconds,
          humanAuthorizationExpiresAt: quote.human_authorization_expires_at,
          now,
        });
        effectiveSigningDeadline = freshness.effective_signing_deadline;
        if (freshness.stale) {
          reasons.push(
            `${BLOCKED_PAYMENT_REQUIREMENTS_STALE}: pay-time requirements exceeded effective signing deadline`,
          );
        }
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const expectedNetwork = quote.canonical_network_caip2;
  const expectedAsset = (quote.asset ?? MAINNET_USDC_ADDRESS).toLowerCase();
  const selected = outcome.selectedAccept;
  if (!selected) {
    reasons.push("fresh 402 missing selectedAccept");
  } else {
    if (selected.scheme !== "exact") {
      reasons.push(`unsupported scheme ${selected.scheme}`);
    }
    if (selected.network !== expectedNetwork) {
      reasons.push(`wrong network ${selected.network}`);
    }
    if (selected.sellerNetworkRaw !== quote.seller_network_raw) {
      reasons.push(
        `wrong seller network raw ${selected.sellerNetworkRaw ?? "null"}`,
      );
    }
    if (selected.asset.toLowerCase() !== expectedAsset) {
      reasons.push(`wrong asset ${selected.asset}`);
    }
    if ((selected.payTo ?? "").toLowerCase() !== quote.pay_to.toLowerCase()) {
      reasons.push(`payTo mismatch fresh=${selected.payTo ?? "null"} authorized=${quote.pay_to}`);
    }
  }

  if (outcome.quoteAtomic !== quote.quote_atomic) {
    reasons.push(
      `quote drift fresh_atomic=${outcome.quoteAtomic ?? "null"} authorized_atomic=${quote.quote_atomic}`,
    );
  }

  const maxAtomic = parseUsdcDecimalToAtomic(quote.authorized_max_usdc);
  const freshAtomic = outcome.quoteAtomic ? BigInt(outcome.quoteAtomic) : null;
  if (freshAtomic !== null && freshAtomic > maxAtomic) {
    reasons.push(`fresh quote ${outcome.quoteAtomic} exceeds authorized max budget`);
  }

  return {
    go: reasons.length === 0,
    reasons,
    outcome,
    paytime_requirements_observed_at: freshRequirements?.requirements_observed_at ?? null,
    effective_signing_deadline: effectiveSigningDeadline,
    fresh_unsigned_402_required_before_signing: reasons.length > 0,
  };
}

export function evaluateFreshProbeResponseAgainstAuthorizedQuote(
  candidate: TargetCandidate,
  response: RecordedProbeResponse,
  quote: AuthorizedPaymentQuote,
  options: { readonly maxTargetPriceAtomic?: string; readonly now?: Date } = {},
): PaidQuoteFreshnessPreflightResult {
  const maxAtomic =
    options.maxTargetPriceAtomic ??
    parseUsdcDecimalToAtomic(quote.authorized_max_usdc).toString();
  const outcome = classifyTargetProbeResponse(candidate, response, {
    maxTargetPriceAtomic: maxAtomic,
    requirementsObservedAt: options.now,
  });
  return evaluateFresh402AgainstAuthorizedQuote(outcome, quote, options.now);
}

export async function runPaidQuoteFreshnessPreflight(input: {
  readonly authorized: AuthorizedPaymentQuote;
  readonly fetchImpl?: typeof fetch;
  readonly now?: Date;
}): Promise<PaidQuoteFreshnessPreflightResult> {
  const candidate = buildProbeCandidateForAuthorizedQuote(input.authorized);

  const maxAtomic = parseUsdcDecimalToAtomic(input.authorized.authorized_max_usdc).toString();

  const outcome = await probeTargetLiveness(candidate, {
    fetchImpl: input.fetchImpl,
    maxTargetPriceAtomic: maxAtomic,
  });

  return evaluateFresh402AgainstAuthorizedQuote(outcome, input.authorized, input.now);
}
