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

const AUTHORIZATION_HEADROOM_USDC = "0.001";
const AUTHORIZATION_MAX_CEILING_USDC = "0.01";

export interface DiscoveredTargetSelectionPrimary {
  readonly handshakeStatus: string;
  readonly resourceUrl: string;
  readonly quoteUsdc: string;
  readonly quoteAtomic: string;
  readonly selectedPayTo: string | null;
  readonly network?: string;
  readonly asset?: string;
  readonly scoringRationale: readonly string[];
}

export interface DiscoveredTargetSelectionInput {
  readonly selection: {
    readonly primary: DiscoveredTargetSelectionPrimary | null;
    readonly fallbacks: readonly { readonly resourceUrl: string }[];
  };
}

export interface DiscoveredSelectedCandidate {
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly quote_amount_usdc: string;
  readonly quote_atomic: string;
  readonly authorized_pay_to: string;
  readonly recommended_max_usdc: string;
  readonly network: string;
  readonly asset: string;
  readonly buyer_wallet: string;
  readonly target_selection_audit: TargetSelectionAuditMetadata;
  readonly selected_at_utc: string;
}

export type DiscoveredTargetAdaptResult =
  | { readonly ok: true; readonly candidate: DiscoveredSelectedCandidate }
  | { readonly ok: false; readonly reason: string };

function resolveAllowlistedPolicy(resourceUrl: string) {
  for (const policy of Object.values(ALLOWLISTED_RICH_TX_EXPLAINER_POLICIES)) {
    if (policy.endpointUrl === resourceUrl) return policy;
  }
  return null;
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

export function adaptDiscoveredPrimaryToSelectedCandidate(
  input: DiscoveredTargetSelectionInput,
  now: Date = new Date(),
): DiscoveredTargetAdaptResult {
  const primary = input.selection.primary;
  if (!primary) {
    return { ok: false, reason: "selection.primary is null" };
  }
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
        fallback_resource_urls: input.selection.fallbacks.map((entry) => entry.resourceUrl),
        scoring_rationale: [...primary.scoringRationale],
      },
      selected_at_utc: now.toISOString(),
    },
  };
}
