/**
 * rich-tx-explainer-policy — allowlisted endpoints, human gates, caps.
 */

import { compareUsdcDecimal } from "./external-x402-get-policy";

export const TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV =
  "TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER" as const;
export const TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_VALUE =
  "YES_I_AUTHORIZE_ONE_RICH_TX_EXPLAINER_PAYMENT" as const;
export const TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV =
  "TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID" as const;
export const TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV =
  "TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC" as const;
export const TRUSTFORGE_AUTHORIZATION_HASH_ENV = "TRUSTFORGE_AUTHORIZATION_HASH" as const;
export const TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV =
  "TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED" as const;
export const TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE =
  "YES_I_AUTHORIZE_ONE_PAYMENT" as const;

export const PHASE2_FIXTURE_TX =
  "0xff5ec5e20c42aff2d6d96b7854441a0d0357178a2263f02ea381a00db12d26d4" as const;
export const T0C_FIXTURE_TX =
  "0xb445f8c1091a55ac35d23db38371a0e0d0bbb0bf2564e3ddf9843abea70cfb11" as const;

export const MAX_RICH_CAP_USDC = "0.25";

export type RichTxExplainerMethod = "GET" | "POST";

export interface RichTxExplainerPolicy {
  readonly policyId: string;
  readonly serviceId: string;
  readonly provider: string;
  readonly endpointUrl: string;
  readonly method: RichTxExplainerMethod;
  readonly allowedNetwork: "eip155:8453";
  readonly allowedAsset: "USDC";
  readonly maxPricePerCallUsdc: string;
  readonly maxTotalSpendUsdc: string;
  readonly maxPaymentAttempts: 1;
  readonly allowRedirects: false;
  readonly allowRetries: false;
  readonly allowFallback: false;
  readonly targetChainId: number;
  readonly buildRequestBody: (txHash: string, chainId: number) => unknown;
  readonly buildRequestUrl?: (txHash: string, chainId: number) => string;
}

export const ZAPPER_TX_EXPLAINER_POLICY: RichTxExplainerPolicy = {
  policyId: "zapper_tx_explainer_base_mainnet_v1",
  serviceId: "zapper_tx_explainer",
  provider: "Zapper",
  endpointUrl: "https://public.zapper.xyz/x402/transaction-details",
  method: "POST",
  allowedNetwork: "eip155:8453",
  allowedAsset: "USDC",
  maxPricePerCallUsdc: "0.10",
  maxTotalSpendUsdc: "0.10",
  maxPaymentAttempts: 1,
  allowRedirects: false,
  allowRetries: false,
  allowFallback: false,
  targetChainId: 8453,
  buildRequestBody: (txHash, chainId) => ({ hash: txHash, chainId }),
};

export const ALLOWLISTED_RICH_TX_EXPLAINER_POLICIES: Record<string, RichTxExplainerPolicy> = {
  [ZAPPER_TX_EXPLAINER_POLICY.policyId]: ZAPPER_TX_EXPLAINER_POLICY,
};

export interface RichHumanGateStatus {
  readonly authorized: boolean;
  readonly capUsdc: string | null;
  readonly runId: string | null;
  readonly missingItems: readonly string[];
  readonly blockedReason: string | null;
}

export function validateRichHumanGates(
  env: Record<string, string | undefined> = process.env,
): RichHumanGateStatus {
  const missingItems: string[] = [];
  const richAuth = env[TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV]?.trim();
  const externalAuth = env[TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV]?.trim();
  const runId = env[TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV]?.trim();
  const cap = env[TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV]?.trim();
  const buyerKey = env.BUYER_PRIVATE_KEY?.trim();

  if (richAuth !== TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_VALUE) {
    missingItems.push(TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV);
  }
  if (externalAuth !== TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE) {
    missingItems.push(TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV);
  }
  if (!runId) missingItems.push(TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV);
  if (!cap) missingItems.push(TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV);
  if (!buyerKey || !/^0x[0-9a-fA-F]{64}$/.test(buyerKey)) {
    missingItems.push("BUYER_PRIVATE_KEY");
  }

  let blockedReason: string | null = null;
  if (cap) {
    if (compareUsdcDecimal(cap, "0") <= 0) blockedReason = "HUMAN_GATE_MISSING_CAP";
    if (compareUsdcDecimal(cap, MAX_RICH_CAP_USDC) > 0) blockedReason = "BLOCKED_CAP_TOO_HIGH";
  } else {
    blockedReason = "HUMAN_GATE_MISSING_CAP";
  }

  return {
    authorized: missingItems.length === 0 && blockedReason === null,
    capUsdc: cap ?? null,
    runId: runId ?? null,
    missingItems,
    blockedReason,
  };
}

export function applyCapToPolicy(
  policy: RichTxExplainerPolicy,
  capUsdc: string,
): RichTxExplainerPolicy {
  return {
    ...policy,
    maxPricePerCallUsdc: capUsdc,
    maxTotalSpendUsdc: capUsdc,
  };
}

export function resolveRichTxExplainerPolicy(policyId: string): RichTxExplainerPolicy {
  const policy = ALLOWLISTED_RICH_TX_EXPLAINER_POLICIES[policyId];
  if (!policy) throw new Error(`unknown rich tx explainer policy: ${policyId}`);
  return policy;
}
