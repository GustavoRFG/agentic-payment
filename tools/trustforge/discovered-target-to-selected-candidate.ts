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
  probePaidMethodHonored,
  REJECTED_PAID_METHOD_NOT_HONORED,
  type PaidMethodHonoredProbeResult,
} from "./paid-method-honored-probe";
import {
  probeQuoteStability,
  REJECTED_QUOTE_UNSTABLE,
  type QuoteStabilityEvidence,
  type QuoteStabilityResult,
} from "./quote-stability-probe";

const AUTHORIZATION_HEADROOM_USDC = "0.001";
const AUTHORIZATION_MAX_CEILING_USDC = "0.01";

export interface DiscoveredTargetSelectionPrimary {
  readonly rank?: number;
  readonly candidateId?: string;
  readonly method?: TargetCandidate["method"];
  readonly handshakeStatus: string;
  readonly resourceUrl: string;
  readonly quoteUsdc: string;
  readonly quoteAtomic: string;
  readonly selectedPayTo: string | null;
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
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly method?: TargetCandidate["method"];
  readonly quote_amount_usdc: string;
  readonly quote_atomic: string;
  readonly authorized_pay_to: string;
  readonly recommended_max_usdc: string;
  readonly network: string;
  readonly asset: string;
  readonly buyer_wallet: string;
  readonly target_selection_audit: TargetSelectionAuditMetadata;
  readonly selected_at_utc: string;
  readonly adapt_evidence?: {
    readonly quote_stability: QuoteStabilityEvidence;
  };
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
}

export interface DiscoveredTargetAdaptRejection {
  readonly resourceUrl: string;
  readonly reason: string;
  readonly evidence?: {
    readonly quote_stability: QuoteStabilityEvidence;
  };
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

  const sepoliaPolicy = resolveSepoliaLocalPolicy(primary.resourceUrl);
  const network = primary.network ?? (sepoliaPolicy ? TESTNET_NETWORK : MAINNET_NETWORK);
  const isSepolia = network === TESTNET_NETWORK || network === "84532";
  const asset = primary.asset ?? (isSepolia ? TESTNET_USDC_ADDRESS : MAINNET_USDC_ADDRESS);
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
      provider,
      service_id: serviceId,
      endpoint: primary.resourceUrl,
      ...(primary.method ? { method: primary.method } : {}),
      quote_amount_usdc: primary.quoteUsdc,
      quote_atomic: primary.quoteAtomic,
      authorized_pay_to: primary.selectedPayTo,
      recommended_max_usdc: recommendedAuthorizationMaxUsdc(primary.quoteUsdc),
      network,
      asset,
      buyer_wallet: buyerWallet,
      target_selection_audit: {
        selected_resource_url: primary.resourceUrl,
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

  const sepoliaPolicy = resolveSepoliaLocalPolicy(primary.resourceUrl);
  const policy = sepoliaPolicy ?? resolveAllowlistedPolicy(primary.resourceUrl);
  if (!policy) {
    return {
      ok: false,
      reason: `selection.primary endpoint is not allowlisted for paid adaptation: ${primary.resourceUrl}`,
    };
  }

  const isSepolia = Boolean(sepoliaPolicy);
  const network = primary.network ?? (isSepolia ? TESTNET_NETWORK : MAINNET_NETWORK);
  const asset = primary.asset ?? (isSepolia ? TESTNET_USDC_ADDRESS : MAINNET_USDC_ADDRESS);
  const buyerWallet = isSepolia ? SEPOLIA_TESTNET_BUYER_WALLET : MAINNET_BUYER_WALLET;

  return {
    ok: true,
    candidate: {
      provider: policy.provider,
      service_id: policy.serviceId,
      endpoint: primary.resourceUrl,
      ...(primary.method ? { method: primary.method } : {}),
      quote_amount_usdc: primary.quoteUsdc,
      quote_atomic: primary.quoteAtomic,
      authorized_pay_to: primary.selectedPayTo,
      recommended_max_usdc: recommendedAuthorizationMaxUsdc(primary.quoteUsdc),
      network,
      asset,
      buyer_wallet: buyerWallet,
      target_selection_audit: {
        selected_resource_url: primary.resourceUrl,
        handshake_status: primary.handshakeStatus,
        fallback_resource_urls: fallbacks.map((entry) => entry.resourceUrl),
        scoring_rationale: [...(primary.scoringRationale ?? [])],
      },
      selected_at_utc: now.toISOString(),
    },
  };
}

/**
 * Adapt after a live 402 handshake: keyless settle-method probe (POST, no payment),
 * then a second 402 for quote stability. REJECTED_PAID_METHOD_NOT_HONORED /
 * REJECTED_QUOTE_UNSTABLE fall through to the next fallback.
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

  const explicitResourceUrl = options.resourceUrl?.trim();
  if (explicitResourceUrl) {
    const resolved = resolveAdaptSelection(input, { resourceUrl: explicitResourceUrl });
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason,
        paidMethodProbe: null,
        quoteStability: null,
        rejectedCandidates: [],
      };
    }
  } else if (!input.selection.primary) {
    return {
      ok: false,
      reason: "selection.primary is null",
      paidMethodProbe: null,
      quoteStability: null,
      rejectedCandidates: [],
    };
  }

  const ranked = rankedAdaptCandidates(input, options);
  if (ranked.length === 0) {
    return {
      ok: false,
      reason: explicitResourceUrl
        ? `resource_url not found in live target_selection candidates: ${explicitResourceUrl}`
        : "selection.primary is null",
      paidMethodProbe: null,
      quoteStability: null,
      rejectedCandidates: [],
    };
  }

  const rejectedCandidates: DiscoveredTargetAdaptRejection[] = [];
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
      endpoint: adapted.candidate.endpoint,
      expectedNetwork: adapted.candidate.network,
      fetchImpl: options.fetchImpl,
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
      endpoint: adapted.candidate.endpoint,
      firstMaxAmountRequiredAtomic: probe.maxAmountRequiredAtomic,
      expectedNetwork: adapted.candidate.network,
      fetchImpl: options.fetchImpl,
    });
    lastStability = stability;
    if (!stability.stable) {
      const reason =
        stability.reason ??
        `${REJECTED_QUOTE_UNSTABLE}: quote unstable for ${adapted.candidate.endpoint}`;
      rejectedCandidates.push({
        resourceUrl: entry.resourceUrl,
        reason,
        evidence: { quote_stability: stability.evidence },
      });
      continue;
    }

    return {
      ok: true,
      candidate: {
        ...adapted.candidate,
        adapt_evidence: {
          quote_stability: stability.evidence,
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
    entry.reason.includes(REJECTED_QUOTE_UNSTABLE),
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
