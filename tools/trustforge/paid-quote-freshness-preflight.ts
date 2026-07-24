/**
 * paid-quote-freshness-preflight — unsigned pay-time 402 re-handshake before key load.
 */

import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS, TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { parseUsdcDecimalToAtomic } from "./external-x402-get-policy";
import {
  classifyTargetProbeResponse,
  probeTargetLiveness,
  type RecordedProbeResponse,
  type TargetHandshakeOutcome,
} from "./target-liveness";
import type { TargetCandidate } from "./target-candidates";
import {
  ALLOWLISTED_RICH_TX_EXPLAINER_POLICIES,
  ZAPPER_TX_EXPLAINER_POLICY,
} from "./rich-tx-explainer-policy";

export interface AuthorizedPaymentQuote {
  readonly endpoint: string;
  readonly method?: TargetCandidate["method"];
  readonly quote_amount_usdc: string;
  readonly quote_atomic: string;
  readonly authorized_max_usdc: string;
  readonly pay_to: string;
  readonly network?: string;
  readonly asset?: string;
}

export interface PaidQuoteFreshnessPreflightResult {
  readonly go: boolean;
  readonly reasons: readonly string[];
  readonly outcome: TargetHandshakeOutcome | null;
}

function policyForEndpoint(endpoint: string) {
  for (const policy of Object.values(ALLOWLISTED_RICH_TX_EXPLAINER_POLICIES)) {
    if (policy.endpointUrl === endpoint) return policy;
  }
  if (endpoint.includes("/paid/analyze-text")) {
    return {
      serviceId: "local_analyze_text",
      method: "POST" as const,
      policyId: "sepolia_local_analyze_text",
      buildRequestBody: () => ({}),
    };
  }
  return null;
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
  const policy = policyForEndpoint(quote.endpoint);

  const expectedNetwork = quote.network ?? MAINNET_NETWORK;
  const expectedAsset = quote.asset ?? MAINNET_USDC_ADDRESS;
  const isZapper = policy?.policyId === ZAPPER_TX_EXPLAINER_POLICY.policyId;
  const isSepoliaLocal = quote.endpoint.includes("/paid/analyze-text");
  return {
    candidateId: policy?.serviceId ?? genericCandidateId(quote.endpoint),
    resourceUrl: quote.endpoint,
    method: policy?.method ?? quote.method ?? "GET",
    x402Version: 2,
    freshness: {
      lastUpdated: new Date().toISOString(),
      sortKey: new Date().toISOString(),
    },
    registrationMetadata: isZapper
      ? {
          bazaar: {
            info: {
              input: {
                type: "http",
                method: "POST",
                bodyType: "json",
                body: policy!.buildRequestBody(
                  "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060",
                  1,
                ),
              },
            },
          },
        }
      : isSepoliaLocal
        ? {
            bazaar: {
              info: {
                input: {
                  type: "http",
                  method: "POST",
                  bodyType: "json",
                  body: { text: "TrustForge Sepolia freshness probe.", mode: "full" },
                },
              },
            },
          }
        : {},
    accepts: [
      {
        scheme: "exact",
        network: expectedNetwork,
        asset: expectedAsset,
        amountAtomic: quote.quote_atomic,
        payTo: quote.pay_to,
        maxTimeoutSeconds: 300,
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

  if (outcome.resourceUrl && outcome.resourceUrl !== quote.endpoint) {
    reasons.push(`endpoint mismatch fresh=${outcome.resourceUrl} authorized=${quote.endpoint}`);
  }

  if (outcome.status !== "live_402_ok") {
    reasons.push(`fresh handshake status ${outcome.status}`);
  }

  const expectedNetwork = quote.network ?? MAINNET_NETWORK;
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

  const expiresAt = outcome.challenge.expiresAt;
  if (!expiresAt) {
    reasons.push("fresh challenge missing expiresAt");
  } else if (Date.parse(expiresAt) <= now.getTime()) {
    reasons.push(`fresh challenge expired at ${expiresAt}`);
  }
  if (!outcome.challenge.nonce) {
    reasons.push("fresh challenge missing nonce");
  }

  return {
    go: reasons.length === 0,
    reasons,
    outcome,
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
