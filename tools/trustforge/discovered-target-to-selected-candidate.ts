/**
 * discovered-target-to-selected-candidate — map canonical Bazaar selection to Phase 6 input.
 */

import { atomicUsdcToDecimal, parseUsdcDecimalToAtomic } from "./external-x402-get-policy";
import { ALLOWLISTED_RICH_TX_EXPLAINER_POLICIES } from "./rich-tx-explainer-policy";
import {
  SEPOLIA_LOCAL_PROVIDER,
  SEPOLIA_LOCAL_SERVICE_ID,
} from "./sepolia-seller-handshake";
import { SEPOLIA_TESTNET_BUYER_WALLET, MAINNET_BUYER_WALLET } from "./network-config";
import {
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";
import type { TargetSelectionAuditMetadata } from "./validate-human-payment-authorization";
import type { TargetCandidate } from "./target-candidates";
import {
  isMethodSupportedByThinRunner,
  probePaidMethodHonored,
  REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER,
  REJECTED_PAID_METHOD_NOT_HONORED,
  type PaidMethodHonoredProbeResult,
} from "./paid-method-honored-probe";
import { THIN_RUNNER_SETTLEABLE_METHODS } from "./thin-settlement-method-contract";
import {
  createThinSettlementRequestBinding,
  REJECTED_REQUEST_BINDING_NOT_PERSISTED,
  type CanonicalJsonValue,
  type CanonicalQuery,
  type RequestInputProvenance,
  type ThinSettlementRequestBinding,
} from "./thin-settlement-request-binding";
import {
  probeQuoteStability,
  REJECTED_NON_POSITIVE_QUOTE,
  REJECTED_QUOTE_EXTRACTION_FAILED,
  REJECTED_QUOTE_SOURCE_DISAGREEMENT,
  REJECTED_QUOTE_UNSTABLE,
  type QuoteStabilityEvidence,
  type QuoteStabilityResult,
} from "./quote-stability-probe";
import {
  blocklistSkipReason,
  loadProviderBlocklist,
  partitionByBlocklist,
  type ProviderBlocklist,
  type ProviderBlocklistEntry,
} from "./provider-blocklist";
import {
  BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH,
  REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED,
  canonicalJson,
  validatePersistedSellerRequirementsObservation,
  type AncillaryTempoEvidence,
  type SellerAmountField,
  type SellerRequirementsObservation,
  type SellerRequirementsTransport,
  type X402ProtocolVersion,
} from "./x402-seller-requirements-binding";

const AUTHORIZATION_HEADROOM_USDC = "0.001";
const AUTHORIZATION_MAX_CEILING_USDC = "0.01";
const THIN_RUNNER_METHOD_LABEL = THIN_RUNNER_SETTLEABLE_METHODS.join("|");

export interface DiscoveredTargetSelectionPrimary {
  readonly rank?: number;
  readonly candidateId?: string;
  readonly method?: TargetCandidate["method"];
  readonly requestEndpoint?: string;
  readonly requestInputStatus?: "known";
  readonly requestQuery?: CanonicalQuery;
  readonly requestBody?: CanonicalJsonValue | null;
  readonly requestInputProvenance?: RequestInputProvenance;
  readonly requestBindingSha256?: string;
  readonly handshakeStatus: string;
  readonly resourceUrl: string;
  readonly quoteUsdc: string;
  readonly quoteAtomic: string;
  readonly selectedPayTo: string | null;
  readonly sellerRequirements?: SellerRequirementsObservation;
  readonly sellerNetworkRaw?: string;
  readonly canonicalNetworkCaip2?: string;
  /** Operational network alias; when present it must equal canonicalNetworkCaip2. */
  readonly network?: string;
  readonly asset?: string;
  readonly scoringRationale: readonly string[];
}

export type DiscoveredTargetSelectionFallback = Partial<DiscoveredTargetSelectionPrimary> & {
  readonly resourceUrl: string;
};

export interface DiscoveredTargetSelectionInput {
  readonly selection: {
    readonly primary: DiscoveredTargetSelectionPrimary | null;
    readonly fallbacks: readonly DiscoveredTargetSelectionFallback[];
  };
}

export interface DiscoveredSelectedCandidate {
  readonly schema_version: "trustforge_selected_candidate.v3";
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly method?: TargetCandidate["method"];
  readonly request_input_status: "known";
  readonly request_query: CanonicalQuery;
  readonly request_body: CanonicalJsonValue | null;
  readonly request_input_provenance: RequestInputProvenance;
  readonly request_binding_sha256: string;
  readonly protocol_version: X402ProtocolVersion;
  readonly transport: SellerRequirementsTransport;
  readonly scheme: string;
  readonly amount_field: SellerAmountField;
  readonly max_timeout_seconds: number;
  readonly resource: unknown;
  readonly extra: unknown;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
  readonly selection_requirements_observed_at: string;
  readonly ancillary_tempo_evidence: AncillaryTempoEvidence | null;
  readonly seller_requirements: SellerRequirementsObservation;
  readonly quote_amount_usdc: string;
  readonly quote_atomic: string;
  readonly authorized_pay_to: string;
  readonly recommended_max_usdc: string;
  readonly seller_network_raw: string;
  readonly canonical_network_caip2: string;
  /** Operational network, required to equal canonical_network_caip2. */
  readonly network: string;
  readonly asset: string;
  readonly buyer_wallet: string;
  readonly target_selection_audit: TargetSelectionAuditMetadata;
  readonly selected_at_utc: string;
  readonly adapt_evidence?: {
    readonly quote_stability: QuoteStabilityEvidence;
    /** Proof the persisted quote_atomic is bound to the live 402 the probe read. */
    readonly quote_binding?: QuoteBindingEvidence;
  };
}

export interface QuoteBindingEvidence {
  readonly bound_atomic: string;
  readonly catalog_atomic: string;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
  readonly requirements_observed_at: string;
}

export type DiscoveredTargetAdaptResult =
  | { readonly ok: true; readonly candidate: DiscoveredSelectedCandidate }
  | { readonly ok: false; readonly reason: string };

export interface DiscoveredTargetAdaptOptions {
  readonly resourceUrl?: string;
}

export interface DiscoveredTargetLiveAdaptOptions extends DiscoveredTargetAdaptOptions {
  readonly thin?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly now?: Date;
  /** Skip the settle-method keyless probe (unit tests / offline mapping only). */
  readonly skipPaidMethodProbe?: boolean;
  /** Override the evidence-backed provider blocklist (defaults to the versioned config). */
  readonly providerBlocklist?: ProviderBlocklist;
  /**
   * When a pin (`resourceUrl`) is excluded, fall through to the ranking in the same
   * execution instead of failing. Without it, a pin is honored strictly: the pin
   * alone is tried and an exclusion is terminal.
   */
  readonly pinWithFallback?: boolean;
}

export interface MethodMismatchEvidence {
  readonly catalog_method: string;
  readonly thin_runner_method: string;
}

export interface QuoteValidationEvidence {
  readonly first_atomic: string | null;
  readonly second_atomic: string | null;
  readonly bound_atomic: string | null;
  readonly raw_source_field: "maxAmountRequired" | "amount" | null;
  readonly raw_source_value: string | null;
  readonly endpoint: string;
  readonly method: string;
  readonly http_status: number | null;
  readonly reason: string;
}

export interface DiscoveredTargetAdaptRejection {
  readonly resourceUrl: string;
  readonly reason: string;
  readonly evidence?: {
    readonly quote_stability?: QuoteStabilityEvidence;
    readonly blocklist?: ProviderBlocklistEntry;
    readonly method?: MethodMismatchEvidence;
    readonly quote_source?: { readonly bound_atomic: string | null; readonly catalog_atomic: string };
    /** @deprecated Proprietary challenge diagnostics only. */
    readonly challenge?: { readonly nonce_present: boolean; readonly expires_at_present: boolean };
    readonly seller_requirements?: { readonly first_hash: string | null; readonly second_hash: string | null };
    readonly quote_validation?: QuoteValidationEvidence;
  };
}

function bindingFromSelectionEntry(
  entry: DiscoveredTargetSelectionFallback,
):
  | {
      readonly ok: true;
      readonly binding: ThinSettlementRequestBinding;
      readonly provenance: RequestInputProvenance;
    }
  | { readonly ok: false; readonly reason: string } {
  if (
    entry.requestInputStatus !== "known" ||
    !Array.isArray(entry.requestQuery) ||
    !Object.prototype.hasOwnProperty.call(entry, "requestBody") ||
    !entry.requestInputProvenance ||
    !entry.requestBindingSha256
  ) {
    return {
      ok: false,
      reason: `${REJECTED_REQUEST_BINDING_NOT_PERSISTED}: ${entry.resourceUrl} lacks canonical request input`,
    };
  }
  try {
    const binding = createThinSettlementRequestBinding({
      endpoint: entry.requestEndpoint ?? entry.resourceUrl,
      method: String(entry.method ?? ""),
      input_status: "known",
      query: entry.requestQuery,
      body: entry.requestBody,
    });
    if (binding.binding_sha256 !== entry.requestBindingSha256.toLowerCase()) {
      return {
        ok: false,
        reason: `REJECTED_REQUEST_BINDING_INVALID: ${entry.resourceUrl} persisted hash mismatch`,
      };
    }
    return { ok: true, binding, provenance: entry.requestInputProvenance };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function sellerRequirementsFromSelectionEntry(
  entry: DiscoveredTargetSelectionFallback,
  requestBindingSha256: string,
):
  | { readonly ok: true; readonly observation: SellerRequirementsObservation }
  | { readonly ok: false; readonly reason: string } {
  if (!entry.sellerRequirements) {
    return {
      ok: false,
      reason: `${REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED}: ${entry.resourceUrl} lacks seller requirements binding`,
    };
  }
  const validation = validatePersistedSellerRequirementsObservation(
    entry.sellerRequirements,
    requestBindingSha256,
  );
  if (!validation.valid) return { ok: false, reason: validation.reasons.join("; ") };
  const binding = entry.sellerRequirements.binding;
  if (
    binding.amount_atomic !== entry.quoteAtomic ||
    binding.pay_to.toLowerCase() !== (entry.selectedPayTo ?? "").toLowerCase() ||
    (entry.sellerNetworkRaw && binding.seller_network_raw !== entry.sellerNetworkRaw) ||
    (entry.canonicalNetworkCaip2 &&
      binding.canonical_network_caip2 !== entry.canonicalNetworkCaip2) ||
    (entry.network && binding.canonical_network_caip2 !== entry.network) ||
    (entry.asset && binding.asset.toLowerCase() !== entry.asset.toLowerCase())
  ) {
    return {
      ok: false,
      reason: `${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: selection fields differ from bound seller requirements`,
    };
  }
  return { ok: true, observation: entry.sellerRequirements };
}

export function sellerRequirementsFromSelectedCandidate(
  candidate: DiscoveredSelectedCandidate,
): SellerRequirementsObservation {
  if (candidate.schema_version !== "trustforge_selected_candidate.v3" || !candidate.seller_requirements) {
    throw new Error(
      `${REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED}: selected_candidate lacks seller requirements binding`,
    );
  }
  const validation = validatePersistedSellerRequirementsObservation(
    candidate.seller_requirements,
    candidate.request_binding_sha256,
  );
  if (!validation.valid) throw new Error(validation.reasons.join("; "));
  const binding = candidate.seller_requirements.binding;
  const normalizedMatches =
    candidate.protocol_version === binding.protocol_version &&
    candidate.transport === binding.transport &&
    candidate.scheme === binding.scheme &&
    candidate.seller_network_raw === binding.seller_network_raw &&
    candidate.canonical_network_caip2 === binding.canonical_network_caip2 &&
    candidate.network === binding.canonical_network_caip2 &&
    candidate.asset.toLowerCase() === binding.asset.toLowerCase() &&
    candidate.amount_field === binding.amount_field &&
    candidate.quote_atomic === binding.amount_atomic &&
    candidate.authorized_pay_to.toLowerCase() === binding.pay_to.toLowerCase() &&
    candidate.max_timeout_seconds === binding.max_timeout_seconds &&
    canonicalJson(candidate.resource) === canonicalJson(binding.resource) &&
    canonicalJson(candidate.extra) === canonicalJson(binding.extra) &&
    canonicalJson(candidate.ancillary_tempo_evidence) ===
      canonicalJson(candidate.seller_requirements.ancillary_tempo_evidence) &&
    candidate.canonical_requirements_sha256 === binding.canonical_requirements_sha256 &&
    candidate.canonical_envelope_sha256 === binding.canonical_envelope_sha256 &&
    candidate.selection_requirements_observed_at ===
      candidate.seller_requirements.requirements_observed_at;
  if (!normalizedMatches) {
    throw new Error(
      `${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: selected_candidate normalized fields differ from binding`,
    );
  }
  return candidate.seller_requirements;
}

export function requestBindingFromSelectedCandidate(
  candidate: DiscoveredSelectedCandidate,
): ThinSettlementRequestBinding {
  if (
    candidate.request_input_status !== "known" ||
    !Array.isArray(candidate.request_query) ||
    !Object.prototype.hasOwnProperty.call(candidate, "request_body") ||
    !candidate.request_input_provenance ||
    !candidate.request_binding_sha256
  ) {
    throw new Error(
      `${REJECTED_REQUEST_BINDING_NOT_PERSISTED}: selected_candidate lacks canonical request input`,
    );
  }
  const binding = createThinSettlementRequestBinding({
    endpoint: candidate.endpoint,
    method: String(candidate.method ?? ""),
    input_status: candidate.request_input_status,
    query: candidate.request_query,
    body: candidate.request_body,
  });
  if (binding.binding_sha256 !== candidate.request_binding_sha256?.toLowerCase()) {
    throw new Error(
      "REJECTED_REQUEST_BINDING_INVALID: selected_candidate request binding hash mismatch",
    );
  }
  return binding;
}

function quoteValidationEvidence(
  stability: QuoteStabilityResult,
  endpoint: string,
  method: string | null | undefined,
  reason: string,
): QuoteValidationEvidence {
  return {
    first_atomic: stability.evidence.first_max_amount_required_atomic,
    second_atomic: stability.evidence.second_max_amount_required_atomic,
    bound_atomic: stability.bound.atomic,
    raw_source_field: stability.bound.rawSourceField,
    raw_source_value: stability.bound.rawSourceValue,
    endpoint,
    method: method ?? "",
    http_status: stability.httpStatus,
    reason,
  };
}

/** Honest reason a pinned candidate cannot be selected — matched against the fresh selection, not the catalog. */
export const PIN_EXCLUDED_NOT_IN_FRESH_DISCOVERY = "EXCLUDED_NOT_IN_FRESH_DISCOVERY";
export const PIN_EXCLUDED_HANDSHAKE_MALFORMED = "EXCLUDED_HANDSHAKE_MALFORMED";

function handshakeIsWellFormed(candidate: DiscoveredTargetSelectionFallback): boolean {
  return (
    candidate.handshakeStatus === "live_402_ok" &&
    Boolean(candidate.quoteUsdc?.trim()) &&
    Boolean(candidate.quoteAtomic?.trim()) &&
    Boolean(candidate.selectedPayTo?.trim())
  );
}

export type PinResolution =
  | { readonly ok: true; readonly candidate: DiscoveredTargetSelectionFallback }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly evidence?: DiscoveredTargetAdaptRejection["evidence"];
    };

/**
 * Resolve a pin (resource_url) against the fresh discovery selection with a reason
 * that names the real cause: not present in fresh discovery, blocklisted, catalog
 * method unsupported by the thin runner, or a malformed handshake.
 */
export function resolvePinnedCandidate(
  freshDiscovery: readonly DiscoveredTargetSelectionFallback[],
  pinUrl: string,
  blocklist: ProviderBlocklist,
): PinResolution {
  const candidate = freshDiscovery.find((entry) => entry.resourceUrl === pinUrl);
  if (!candidate) {
    return {
      ok: false,
      reason: `${PIN_EXCLUDED_NOT_IN_FRESH_DISCOVERY}: ${pinUrl} not among the fresh target_selection candidates`,
    };
  }
  const blocklistEntry = blocklist.entries.find((entry) => {
    const domain = entry.domain.toLowerCase();
    try {
      const host = new URL(candidate.resourceUrl).hostname.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  });
  if (blocklistEntry) {
    return {
      ok: false,
      reason: blocklistSkipReason(blocklistEntry),
      evidence: { blocklist: blocklistEntry },
    };
  }
  if (!isMethodSupportedByThinRunner(candidate.method)) {
    return {
      ok: false,
      reason: `${REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER}: catalog method ${candidate.method} not in ${THIN_RUNNER_SETTLEABLE_METHODS.join(", ")}`,
      evidence: {
        method: { catalog_method: String(candidate.method), thin_runner_method: THIN_RUNNER_METHOD_LABEL },
      },
    };
  }
  if (!handshakeIsWellFormed(candidate)) {
    return {
      ok: false,
      reason: `${PIN_EXCLUDED_HANDSHAKE_MALFORMED}: ${pinUrl} handshakeStatus=${candidate.handshakeStatus}`,
    };
  }
  return { ok: true, candidate };
}

export type DiscoveredTargetLiveAdaptResult =
  | {
      readonly ok: true;
      readonly candidate: DiscoveredSelectedCandidate;
      readonly paidMethodProbe: PaidMethodHonoredProbeResult | null;
      readonly quoteStability: QuoteStabilityResult | null;
      readonly rejectedCandidates: readonly DiscoveredTargetAdaptRejection[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly paidMethodProbe: PaidMethodHonoredProbeResult | null;
      readonly quoteStability: QuoteStabilityResult | null;
      readonly rejectedCandidates: readonly DiscoveredTargetAdaptRejection[];
    };

interface ResolvedAdaptSelection {
  readonly primary: DiscoveredTargetSelectionPrimary;
  readonly fallbacks: readonly DiscoveredTargetSelectionFallback[];
}

function rankedAdaptCandidates(
  input: DiscoveredTargetSelectionInput,
  options: DiscoveredTargetAdaptOptions = {},
): DiscoveredTargetSelectionFallback[] {
  const ranked: DiscoveredTargetSelectionFallback[] = [
    ...(input.selection.primary ? [input.selection.primary] : []),
    ...input.selection.fallbacks,
  ];
  const explicitResourceUrl = options.resourceUrl?.trim();
  if (!explicitResourceUrl) return ranked;
  const index = ranked.findIndex((entry) => entry.resourceUrl === explicitResourceUrl);
  if (index < 0) return [];
  return [...ranked.slice(index), ...ranked.slice(0, index)];
}

function selectionForCandidate(
  candidate: DiscoveredTargetSelectionFallback,
  remaining: readonly DiscoveredTargetSelectionFallback[],
): DiscoveredTargetSelectionInput {
  return {
    selection: {
      primary: candidate as DiscoveredTargetSelectionPrimary,
      fallbacks: remaining,
    },
  };
}

function resolveAllowlistedPolicy(resourceUrl: string) {
  for (const policy of Object.values(ALLOWLISTED_RICH_TX_EXPLAINER_POLICIES)) {
    if (policy.endpointUrl === resourceUrl) return policy;
  }
  return null;
}

function resolveAdaptSelection(
  input: DiscoveredTargetSelectionInput,
  options: DiscoveredTargetAdaptOptions = {},
): { readonly ok: true; readonly selection: ResolvedAdaptSelection } | { readonly ok: false; readonly reason: string } {
  const explicitResourceUrl = options.resourceUrl?.trim();
  const ranked: DiscoveredTargetSelectionFallback[] = [
    ...(input.selection.primary ? [input.selection.primary] : []),
    ...input.selection.fallbacks,
  ];

  if (!explicitResourceUrl) {
    const primary = input.selection.primary;
    if (!primary) {
      return { ok: false, reason: "selection.primary is null" };
    }
    return {
      ok: true,
      selection: {
        primary,
        fallbacks: input.selection.fallbacks,
      },
    };
  }

  const index = ranked.findIndex((entry) => entry.resourceUrl === explicitResourceUrl);
  if (index < 0) {
    return {
      ok: false,
      reason: `resource_url not found in live target_selection candidates: ${explicitResourceUrl}`,
    };
  }

  return {
    ok: true,
    selection: {
      primary: ranked[index] as DiscoveredTargetSelectionPrimary,
      fallbacks: ranked.filter((_, entryIndex) => entryIndex !== index),
    },
  };
}

export function recommendedAuthorizationMaxUsdc(quoteUsdc: string): string {
  const quoteAtomic = parseUsdcDecimalToAtomic(quoteUsdc);
  const headroomAtomic = parseUsdcDecimalToAtomic(AUTHORIZATION_HEADROOM_USDC);
  const ceilingAtomic = parseUsdcDecimalToAtomic(AUTHORIZATION_MAX_CEILING_USDC);
  const withHeadroom = quoteAtomic + headroomAtomic;
  const capped = withHeadroom > ceilingAtomic ? ceilingAtomic : withHeadroom;
  return atomicUsdcToDecimal(capped.toString());
}

function selectedCandidateRequirementsFields(observation: SellerRequirementsObservation) {
  const binding = observation.binding;
  return {
    schema_version: "trustforge_selected_candidate.v3" as const,
    protocol_version: binding.protocol_version,
    transport: binding.transport,
    scheme: binding.scheme,
    seller_network_raw: binding.seller_network_raw,
    canonical_network_caip2: binding.canonical_network_caip2,
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

function resolveSepoliaLocalPolicy(resourceUrl: string) {
  if (!resourceUrl.includes("/paid/analyze-text")) return null;
  if (!resourceUrl.startsWith("http://localhost:") && !resourceUrl.startsWith("http://127.0.0.1:")) {
    return null;
  }
  return {
    provider: SEPOLIA_LOCAL_PROVIDER,
    serviceId: SEPOLIA_LOCAL_SERVICE_ID,
    endpointUrl: resourceUrl,
    network: TESTNET_NETWORK,
    asset: TESTNET_USDC_ADDRESS,
    buyerWallet: SEPOLIA_TESTNET_BUYER_WALLET,
  };
}

export function adaptDiscoveredPrimaryToThinSettlementCandidate(
  input: DiscoveredTargetSelectionInput,
  now: Date = new Date(),
  options: DiscoveredTargetAdaptOptions = {},
): DiscoveredTargetAdaptResult {
  const resolved = resolveAdaptSelection(input, options);
  if (!resolved.ok) return resolved;
  const { primary, fallbacks } = resolved.selection;
  if (primary.handshakeStatus !== "live_402_ok") {
    return {
      ok: false,
      reason: `selection.primary handshakeStatus must be live_402_ok, got ${primary.handshakeStatus}`,
    };
  }
  if (!primary.quoteUsdc?.trim() || !primary.quoteAtomic?.trim()) {
    return { ok: false, reason: "selection.primary is missing quoteUsdc or quoteAtomic" };
  }
  if (!primary.selectedPayTo?.trim()) {
    return { ok: false, reason: "selection.primary is missing selectedPayTo" };
  }
  const request = bindingFromSelectionEntry(primary);
  if (!request.ok) return request;
  const requirements = sellerRequirementsFromSelectionEntry(
    primary,
    request.binding.binding_sha256,
  );
  if (!requirements.ok) return requirements;

  const sepoliaPolicy = resolveSepoliaLocalPolicy(primary.resourceUrl);
  const network = requirements.observation.binding.canonical_network_caip2;
  const isSepolia = network === TESTNET_NETWORK;
  const asset = requirements.observation.binding.asset;
  const buyerWallet = isSepolia ? SEPOLIA_TESTNET_BUYER_WALLET : MAINNET_BUYER_WALLET;
  const allowlisted = resolveAllowlistedPolicy(primary.resourceUrl);
  const provider = sepoliaPolicy?.provider ?? allowlisted?.provider ?? "discovered_x402";
  const serviceId =
    sepoliaPolicy?.serviceId ??
    allowlisted?.serviceId ??
    primary.resourceUrl.replace(/^https?:\/\//, "").replace(/[^\w]+/g, "_").slice(0, 64);

  return {
    ok: true,
    candidate: {
      ...selectedCandidateRequirementsFields(requirements.observation),
      provider,
      service_id: serviceId,
      endpoint: request.binding.endpoint,
      ...(primary.method ? { method: primary.method } : {}),
      request_input_status: request.binding.input_status,
      request_query: request.binding.query,
      request_body: request.binding.body,
      request_input_provenance: request.provenance,
      request_binding_sha256: request.binding.binding_sha256,
      quote_amount_usdc: primary.quoteUsdc,
      quote_atomic: primary.quoteAtomic,
      authorized_pay_to: requirements.observation.binding.pay_to,
      recommended_max_usdc: recommendedAuthorizationMaxUsdc(primary.quoteUsdc),
      network,
      asset,
      buyer_wallet: buyerWallet,
      target_selection_audit: {
        selected_resource_url: request.binding.endpoint,
        handshake_status: primary.handshakeStatus,
        fallback_resource_urls: fallbacks.map((entry) => entry.resourceUrl),
        scoring_rationale: [...(primary.scoringRationale ?? [])],
      },
      selected_at_utc: now.toISOString(),
    },
  };
}

export function adaptDiscoveredPrimaryToSelectedCandidate(
  input: DiscoveredTargetSelectionInput,
  now: Date = new Date(),
  options: DiscoveredTargetAdaptOptions = {},
): DiscoveredTargetAdaptResult {
  const resolved = resolveAdaptSelection(input, options);
  if (!resolved.ok) return resolved;
  const { primary, fallbacks } = resolved.selection;
  if (primary.handshakeStatus !== "live_402_ok") {
    return {
      ok: false,
      reason: `selection.primary handshakeStatus must be live_402_ok, got ${primary.handshakeStatus}`,
    };
  }
  if (!primary.quoteUsdc?.trim() || !primary.quoteAtomic?.trim()) {
    return { ok: false, reason: "selection.primary is missing quoteUsdc or quoteAtomic" };
  }
  if (!primary.selectedPayTo?.trim()) {
    return { ok: false, reason: "selection.primary is missing selectedPayTo" };
  }
  const request = bindingFromSelectionEntry(primary);
  if (!request.ok) return request;
  const requirements = sellerRequirementsFromSelectionEntry(
    primary,
    request.binding.binding_sha256,
  );
  if (!requirements.ok) return requirements;

  const sepoliaPolicy = resolveSepoliaLocalPolicy(primary.resourceUrl);
  const policy = sepoliaPolicy ?? resolveAllowlistedPolicy(primary.resourceUrl);
  if (!policy) {
    return {
      ok: false,
      reason: `selection.primary endpoint is not allowlisted for paid adaptation: ${primary.resourceUrl}`,
    };
  }

  const isSepolia = Boolean(sepoliaPolicy);
  const network = requirements.observation.binding.canonical_network_caip2;
  const asset = requirements.observation.binding.asset;
  const buyerWallet = isSepolia ? SEPOLIA_TESTNET_BUYER_WALLET : MAINNET_BUYER_WALLET;

  return {
    ok: true,
    candidate: {
      ...selectedCandidateRequirementsFields(requirements.observation),
      provider: policy.provider,
      service_id: policy.serviceId,
      endpoint: request.binding.endpoint,
      ...(primary.method ? { method: primary.method } : {}),
      request_input_status: request.binding.input_status,
      request_query: request.binding.query,
      request_body: request.binding.body,
      request_input_provenance: request.provenance,
      request_binding_sha256: request.binding.binding_sha256,
      quote_amount_usdc: primary.quoteUsdc,
      quote_atomic: primary.quoteAtomic,
      authorized_pay_to: requirements.observation.binding.pay_to,
      recommended_max_usdc: recommendedAuthorizationMaxUsdc(primary.quoteUsdc),
      network,
      asset,
      buyer_wallet: buyerWallet,
      target_selection_audit: {
        selected_resource_url: request.binding.endpoint,
        handshake_status: primary.handshakeStatus,
        fallback_resource_urls: fallbacks.map((entry) => entry.resourceUrl),
        scoring_rationale: [...(primary.scoringRationale ?? [])],
      },
      selected_at_utc: now.toISOString(),
    },
  };
}

/**
 * Adapt after a live 402 handshake: keyless settle-method probe (POST/GET, no
 * payment), then a second 402. Extraction failure, instability, stable non-positive
 * quotes, source disagreement, and incomplete challenges remain distinct gates.
 */
export async function adaptDiscoveredTargetWithPaidMethodProbe(
  input: DiscoveredTargetSelectionInput,
  options: DiscoveredTargetLiveAdaptOptions = {},
): Promise<DiscoveredTargetLiveAdaptResult> {
  const now = options.now ?? new Date();
  const thin = options.thin ?? false;
  const adaptOne = thin
    ? adaptDiscoveredPrimaryToThinSettlementCandidate
    : adaptDiscoveredPrimaryToSelectedCandidate;

  const pin = options.resourceUrl?.trim();
  const freshDiscovery = rankedAdaptCandidates(input, {});
  if (freshDiscovery.length === 0) {
    return {
      ok: false,
      reason: "selection.primary is null",
      paidMethodProbe: null,
      quoteStability: null,
      rejectedCandidates: [],
    };
  }

  const rejectedCandidates: DiscoveredTargetAdaptRejection[] = [];
  const blocklist = options.providerBlocklist ?? loadProviderBlocklist();

  // A pin (resource_url) is matched against the fresh selection, not the catalog.
  // Without --pin-with-fallback the pin is strict: its exclusion is terminal and
  // names the real cause (not-in-fresh-discovery / blocklisted / method-unsupported /
  // handshake-malformed). With fallback, an excluded pin drops to the ranking.
  let ordered: DiscoveredTargetSelectionFallback[];
  if (pin) {
    const resolution = resolvePinnedCandidate(freshDiscovery, pin, blocklist);
    if (resolution.ok) {
      ordered = options.pinWithFallback
        ? [resolution.candidate, ...freshDiscovery.filter((entry) => entry.resourceUrl !== pin)]
        : [resolution.candidate];
    } else {
      rejectedCandidates.push({ resourceUrl: pin, reason: resolution.reason, evidence: resolution.evidence });
      if (!options.pinWithFallback) {
        return {
          ok: false,
          reason: resolution.reason,
          paidMethodProbe: null,
          quoteStability: null,
          rejectedCandidates,
        };
      }
      ordered = freshDiscovery.filter((entry) => entry.resourceUrl !== pin);
    }
  } else {
    ordered = freshDiscovery;
  }

  // Drop blocklisted provider domains before ranking is acted upon: never probed,
  // never selected. Each recorded as SKIPPED_BLOCKLISTED. Removal is a human decision.
  const { allowed: afterBlocklist, skipped } = partitionByBlocklist(
    ordered,
    blocklist,
    (candidate) => candidate.resourceUrl,
  );
  for (const skip of skipped) {
    rejectedCandidates.push({
      resourceUrl: skip.item.resourceUrl,
      reason: blocklistSkipReason(skip.entry),
      evidence: { blocklist: skip.entry },
    });
  }

  // Method-awareness: reject methods outside the shared POST/GET contract before
  // spending even a keyless HTTP request on them.
  const ranked: DiscoveredTargetSelectionFallback[] = [];
  for (const candidate of afterBlocklist) {
    if (!isMethodSupportedByThinRunner(candidate.method)) {
      rejectedCandidates.push({
        resourceUrl: candidate.resourceUrl,
        reason: `${REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER}: catalog method ${candidate.method} not in ${THIN_RUNNER_SETTLEABLE_METHODS.join(", ")}`,
        evidence: {
          method: {
            catalog_method: String(candidate.method),
            thin_runner_method: THIN_RUNNER_METHOD_LABEL,
          },
        },
      });
      continue;
    }
    ranked.push(candidate);
  }

  if (ranked.length === 0) {
    return {
      ok: false,
      reason:
        rejectedCandidates[rejectedCandidates.length - 1]?.reason ??
        "no adaptable candidate remained after blocklist and method-awareness exclusion",
      paidMethodProbe: null,
      quoteStability: null,
      rejectedCandidates,
    };
  }
  let lastProbe: PaidMethodHonoredProbeResult | null = null;
  let lastStability: QuoteStabilityResult | null = null;

  for (let index = 0; index < ranked.length; index += 1) {
    const entry = ranked[index]!;
    const remaining = ranked.filter((_, entryIndex) => entryIndex !== index);
    const adapted = adaptOne(selectionForCandidate(entry, remaining), now);
    if (!adapted.ok) {
      rejectedCandidates.push({ resourceUrl: entry.resourceUrl, reason: adapted.reason });
      continue;
    }

    if (options.skipPaidMethodProbe) {
      return {
        ok: true,
        candidate: adapted.candidate,
        paidMethodProbe: null,
        quoteStability: null,
        rejectedCandidates,
      };
    }

    const probe = await probePaidMethodHonored({
      requestBinding: requestBindingFromSelectedCandidate(adapted.candidate),
      expectedNetwork: adapted.candidate.network,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
    lastProbe = probe;
    if (!probe.honored) {
      const reason =
        probe.reason ??
        `${REJECTED_PAID_METHOD_NOT_HONORED}: settle method not honored for ${adapted.candidate.endpoint}`;
      rejectedCandidates.push({ resourceUrl: entry.resourceUrl, reason });
      continue;
    }

    const stability = await probeQuoteStability({
      requestBinding: requestBindingFromSelectedCandidate(adapted.candidate),
      firstMaxAmountRequiredAtomic: probe.maxAmountRequiredAtomic,
      expectedNetwork: adapted.candidate.network,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
    lastStability = stability;
    if (!stability.stable) {
      const reason =
        stability.reason ??
        `${REJECTED_QUOTE_UNSTABLE}: quote unstable for ${adapted.candidate.endpoint}`;
      const extractionFailed = reason.includes(REJECTED_QUOTE_EXTRACTION_FAILED);
      rejectedCandidates.push({
        resourceUrl: entry.resourceUrl,
        reason,
        evidence: {
          quote_stability: stability.evidence,
          ...(extractionFailed
            ? {
                quote_validation: quoteValidationEvidence(
                  stability,
                  adapted.candidate.endpoint,
                  adapted.candidate.method,
                  reason,
                ),
              }
            : {}),
        },
      });
      continue;
    }

    const { atomic: boundAtomic } = stability.bound;
    if (boundAtomic === null) {
      const reason = `${REJECTED_QUOTE_EXTRACTION_FAILED}: stable comparison produced no bound atomic quote for ${adapted.candidate.endpoint}`;
      rejectedCandidates.push({
        resourceUrl: entry.resourceUrl,
        reason,
        evidence: {
          quote_stability: stability.evidence,
          quote_validation: quoteValidationEvidence(
            stability,
            adapted.candidate.endpoint,
            adapted.candidate.method,
            reason,
          ),
        },
      });
      continue;
    }

    // Equality answers stability only. An equal zero quote is stable but not an
    // acceptable payment quote, and must never materialize a candidate.
    if (BigInt(boundAtomic) <= 0n) {
      const reason = `${REJECTED_NON_POSITIVE_QUOTE}: first=${stability.evidence.first_max_amount_required_atomic ?? "null"} second=${stability.evidence.second_max_amount_required_atomic ?? "null"} bound=${boundAtomic} for ${adapted.candidate.endpoint}`;
      rejectedCandidates.push({
        resourceUrl: entry.resourceUrl,
        reason,
        evidence: {
          quote_stability: stability.evidence,
          quote_validation: quoteValidationEvidence(
            stability,
            adapted.candidate.endpoint,
            adapted.candidate.method,
            reason,
          ),
        },
      });
      continue;
    }

    // Seller requirements completeness is protocol-versioned; buyer nonce and
    // EIP-3009 validity are intentionally outside this unsigned 402 gate.
    const firstRequirements = probe.sellerRequirements;
    const secondRequirements = stability.bound.sellerRequirements;
    if (!firstRequirements || !secondRequirements) {
      const reason =
        probe.sellerRequirementsError ??
        stability.bound.sellerRequirementsError ??
        `${REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED}: live probes did not persist requirements binding`;
      rejectedCandidates.push({
        resourceUrl: entry.resourceUrl,
        reason,
        evidence: {
          quote_stability: stability.evidence,
          seller_requirements: {
            first_hash: firstRequirements?.binding.canonical_requirements_sha256 ?? null,
            second_hash: secondRequirements?.binding.canonical_requirements_sha256 ?? null,
          },
        },
      });
      continue;
    }
    if (
      firstRequirements.binding.canonical_requirements_sha256 !==
        secondRequirements.binding.canonical_requirements_sha256 ||
      firstRequirements.binding.canonical_envelope_sha256 !==
        secondRequirements.binding.canonical_envelope_sha256
    ) {
      rejectedCandidates.push({
        resourceUrl: entry.resourceUrl,
        reason: `${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: requirements changed between method and stability probes`,
        evidence: {
          quote_stability: stability.evidence,
          seller_requirements: {
            first_hash: firstRequirements.binding.canonical_requirements_sha256,
            second_hash: secondRequirements.binding.canonical_requirements_sha256,
          },
        },
      });
      continue;
    }

    // Quote binding: the persisted quote_atomic MUST come from the same live 402 the
    // stability probe read — never catalog/census/cache. If the live 402 and the
    // catalog quote disagree, reject instead of materializing a mis-bound candidate.
    const catalogAtomic = adapted.candidate.quote_atomic;
    if (boundAtomic === null || boundAtomic !== catalogAtomic) {
      rejectedCandidates.push({
        resourceUrl: entry.resourceUrl,
        reason: `${REJECTED_QUOTE_SOURCE_DISAGREEMENT}: live_402=${boundAtomic ?? "null"} catalog=${catalogAtomic} for ${adapted.candidate.endpoint}`,
        evidence: {
          quote_stability: stability.evidence,
          quote_source: { bound_atomic: boundAtomic, catalog_atomic: catalogAtomic },
        },
      });
      continue;
    }

    return {
      ok: true,
      candidate: {
        ...adapted.candidate,
        ...selectedCandidateRequirementsFields(secondRequirements),
        // Bound to the live 402 (equals catalog here, since they must agree).
        quote_atomic: boundAtomic,
        adapt_evidence: {
          quote_stability: stability.evidence,
          quote_binding: {
            bound_atomic: boundAtomic,
            catalog_atomic: catalogAtomic,
            canonical_requirements_sha256:
              secondRequirements.binding.canonical_requirements_sha256,
            canonical_envelope_sha256: secondRequirements.binding.canonical_envelope_sha256,
            requirements_observed_at: secondRequirements.requirements_observed_at,
          },
        },
      },
      paidMethodProbe: probe,
      quoteStability: stability,
      rejectedCandidates,
    };
  }

  const methodRejection = rejectedCandidates.find((entry) =>
    entry.reason.includes(REJECTED_PAID_METHOD_NOT_HONORED),
  );
  const quoteRejection = rejectedCandidates.find((entry) =>
    [
      REJECTED_QUOTE_EXTRACTION_FAILED,
      REJECTED_NON_POSITIVE_QUOTE,
      REJECTED_QUOTE_UNSTABLE,
    ].some((code) => entry.reason.includes(code)),
  );
  return {
    ok: false,
    reason:
      quoteRejection?.reason ??
      methodRejection?.reason ??
      rejectedCandidates[rejectedCandidates.length - 1]?.reason ??
      "no adaptable candidate remained after paid-method and quote-stability probes",
    paidMethodProbe: lastProbe,
    quoteStability: lastStability,
    rejectedCandidates,
  };
}
