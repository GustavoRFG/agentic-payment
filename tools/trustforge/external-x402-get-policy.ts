export interface ExternalX402GetProbePolicy {
  readonly policyId: string;
  readonly serviceId: string;
  readonly exactUrl: string;
  readonly method: "GET";
  readonly allowedNetwork: "eip155:8453";
  readonly allowedAsset: "USDC";
  readonly maxPricePerCallUsdc: string;
  readonly maxTotalSpendUsdc: string;
  readonly maxPaymentAttempts: 1;
  readonly allowRedirects: false;
  readonly allowRetries: false;
  readonly allowFallback: false;
  readonly dryRunOnly: true;
}

export interface ExternalX402GetProbeRequest {
  readonly policyId: string;
  readonly url: string;
  readonly method: string;
  readonly allowedNetwork: string;
  readonly allowedAsset: string;
  readonly maxPricePerCallUsdc: string;
  readonly maxTotalSpendUsdc: string;
  readonly maxPaymentAttempts: number;
  readonly allowRedirects: boolean;
  readonly allowRetries: boolean;
  readonly allowFallback: boolean;
  readonly batch?: boolean;
  readonly loop?: boolean;
  readonly scheduler?: boolean;
}

export const ONESOURCE_ETHEREUM_CHAIN_ID_POLICY = {
  policyId: "onesource_api_chain_id_base_mainnet_v1",
  serviceId: "onesource_api_chain_id",
  exactUrl: "https://api.onesource.io/api/chain/chain-id?network=ethereum",
  method: "GET",
  allowedNetwork: "eip155:8453",
  allowedAsset: "USDC",
  maxPricePerCallUsdc: "0.005",
  maxTotalSpendUsdc: "0.005",
  maxPaymentAttempts: 1,
  allowRedirects: false,
  allowRetries: false,
  allowFallback: false,
  dryRunOnly: true,
} as const satisfies ExternalX402GetProbePolicy;

const POLICIES: Record<string, ExternalX402GetProbePolicy> = {
  [ONESOURCE_ETHEREUM_CHAIN_ID_POLICY.policyId]: ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
};

export function resolveExternalX402GetProbePolicy(
  policyId: string,
): ExternalX402GetProbePolicy {
  const policy = POLICIES[policyId];
  if (!policy) {
    throw new Error(`unknown external probe policy: ${policyId}`);
  }
  return policy;
}

export function requestFromPolicy(
  policy: ExternalX402GetProbePolicy,
): ExternalX402GetProbeRequest {
  return {
    policyId: policy.policyId,
    url: policy.exactUrl,
    method: policy.method,
    allowedNetwork: policy.allowedNetwork,
    allowedAsset: policy.allowedAsset,
    maxPricePerCallUsdc: policy.maxPricePerCallUsdc,
    maxTotalSpendUsdc: policy.maxTotalSpendUsdc,
    maxPaymentAttempts: policy.maxPaymentAttempts,
    allowRedirects: policy.allowRedirects,
    allowRetries: policy.allowRetries,
    allowFallback: policy.allowFallback,
    batch: false,
    loop: false,
    scheduler: false,
  };
}

export function parseUsdcDecimalToAtomic(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid USDC amount: ${value}`);
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > 6) {
    throw new Error(`USDC amount has more than 6 decimals: ${value}`);
  }

  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function atomicUsdcToDecimal(amountAtomic: string): string {
  const amount = BigInt(amountAtomic);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`.replace(/\.?0+$/, "");
}

export function compareUsdcDecimal(a: string, b: string): number {
  const aAtomic = parseUsdcDecimalToAtomic(a);
  const bAtomic = parseUsdcDecimalToAtomic(b);
  if (aAtomic < bAtomic) return -1;
  if (aAtomic > bAtomic) return 1;
  return 0;
}

export function validateExternalProbeRequest(
  policy: ExternalX402GetProbePolicy,
  request: ExternalX402GetProbeRequest,
): void {
  if (request.policyId !== policy.policyId) {
    throw new Error("external probe policy id mismatch");
  }
  if (policy.dryRunOnly !== true) {
    throw new Error("external probe policy must be dry-run only");
  }
  if (policy.maxPaymentAttempts !== 1 || request.maxPaymentAttempts !== 1) {
    throw new Error("external probe requires maxPaymentAttempts == 1");
  }
  if (request.url !== policy.exactUrl) {
    throw new Error("external probe URL must match the policy exactUrl byte-for-byte");
  }

  const policyUrl = new URL(policy.exactUrl);
  const requestUrl = new URL(request.url);
  if (requestUrl.protocol !== "https:" || policyUrl.protocol !== "https:") {
    throw new Error("external probe requires https");
  }
  if (requestUrl.host !== policyUrl.host) {
    throw new Error("external probe host mismatch");
  }
  if (requestUrl.pathname !== policyUrl.pathname) {
    throw new Error("external probe path mismatch");
  }
  if (requestUrl.search !== policyUrl.search) {
    throw new Error("external probe query mismatch");
  }
  if (request.method !== "GET" || policy.method !== "GET") {
    throw new Error("external probe supports GET only");
  }
  if (request.allowRedirects || policy.allowRedirects) {
    throw new Error("external probe redirects are disabled");
  }
  if (request.allowRetries || policy.allowRetries) {
    throw new Error("external probe retries are disabled");
  }
  if (request.allowFallback || policy.allowFallback) {
    throw new Error("external probe fallback is disabled");
  }
  if (request.batch) {
    throw new Error("external probe batch execution is disabled");
  }
  if (request.loop) {
    throw new Error("external probe loop execution is disabled");
  }
  if (request.scheduler) {
    throw new Error("external probe scheduler execution is disabled");
  }
  if (request.allowedNetwork !== policy.allowedNetwork) {
    throw new Error("external probe network mismatch");
  }
  if (request.allowedAsset !== policy.allowedAsset) {
    throw new Error("external probe asset mismatch");
  }
  if (compareUsdcDecimal(request.maxPricePerCallUsdc, policy.maxPricePerCallUsdc) > 0) {
    throw new Error("external probe per-call cap exceeds policy");
  }
  if (compareUsdcDecimal(request.maxTotalSpendUsdc, policy.maxTotalSpendUsdc) > 0) {
    throw new Error("external probe total cap exceeds policy");
  }
}
