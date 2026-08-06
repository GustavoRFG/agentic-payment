/**
 * target-candidates - Bazaar resource normalization and TrustForge filters.
 */

import { createHash } from "node:crypto";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import type { BazaarAccept, BazaarResource } from "./bazaar-client";
import {
  createThinSettlementRequestBinding,
  REJECTED_REQUEST_BINDING_NOT_PERSISTED,
  type RequestInputProvenance,
  type ThinSettlementRequestBinding,
} from "./thin-settlement-request-binding";
import { normalizeX402NetworkIdentity } from "./x402-network-identity";

export const DEFAULT_MAX_TARGET_PRICE_ATOMIC = "10000" as const;
export const TRUSTFORGE_MAX_TARGET_PRICE_ATOMIC_ENV =
  "TRUSTFORGE_MAX_TARGET_PRICE_ATOMIC" as const;

export type TargetRejectReason =
  | "empty_accepts"
  | "malformed_accept"
  | "wrong_network"
  | "wrong_asset"
  | "over_budget";

export interface TargetAccept {
  readonly scheme: string;
  readonly network: string;
  readonly sellerNetworkRaw?: string;
  readonly canonicalNetworkCaip2?: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly payTo: string | null;
  readonly maxTimeoutSeconds: number | null;
}

export interface TargetCandidate {
  readonly candidateId: string;
  readonly resourceUrl: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  readonly accepts: readonly TargetAccept[];
  readonly x402Version: number;
  readonly freshness: {
    readonly lastUpdated: string | null;
    readonly sortKey: string;
  };
  readonly registrationMetadata: Record<string, unknown>;
  readonly requestBinding: ThinSettlementRequestBinding | null;
  readonly requestInputProvenance: RequestInputProvenance | null;
  readonly requestBindingError: string | null;
}

export interface RejectedTargetCandidate {
  readonly resourceUrl: string;
  readonly reason: TargetRejectReason;
  readonly detail: string;
}

export interface TargetFilterResult {
  readonly accepted: readonly TargetCandidate[];
  readonly rejected: readonly RejectedTargetCandidate[];
  readonly maxTargetPriceAtomic: string;
}

function sha256Short(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function candidateId(resourceUrl: string): string {
  const url = resourceUrl.toLowerCase().replace(/^https?:\/\//, "");
  const slug = url.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return `${slug || "bazaar_resource"}_${sha256Short(resourceUrl)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function bazaarHttpInput(
  extensions: Record<string, unknown>,
): Record<string, unknown> | null {
  const bazaar = extensions.bazaar;
  if (!isRecord(bazaar)) return null;
  const info = bazaar.info;
  if (!isRecord(info)) return null;
  return isRecord(info.input) ? info.input : null;
}

export function resolveTargetRequestBinding(input: {
  readonly resourceUrl: string;
  readonly method: TargetCandidate["method"];
  readonly extensions: Record<string, unknown>;
}): {
  readonly requestBinding: ThinSettlementRequestBinding | null;
  readonly requestInputProvenance: RequestInputProvenance | null;
  readonly requestBindingError: string | null;
} {
  const catalogInput = bazaarHttpInput(input.extensions);
  if (!catalogInput) {
    return {
      requestBinding: null,
      requestInputProvenance: null,
      requestBindingError: `${REJECTED_REQUEST_BINDING_NOT_PERSISTED}: Bazaar extensions.bazaar.info.input missing`,
    };
  }
  try {
    const requestBinding = createThinSettlementRequestBinding({
      endpoint: input.resourceUrl,
      method: input.method,
      input_status: "known",
      query: "queryParams" in catalogInput ? catalogInput.queryParams : [],
      body:
        input.method === "GET"
          ? null
          : "body" in catalogInput
            ? catalogInput.body
            : null,
    });
    return {
      requestBinding,
      requestInputProvenance: "bazaar.extensions.bazaar.info.input",
      requestBindingError: null,
    };
  } catch (error) {
    return {
      requestBinding: null,
      requestInputProvenance: "bazaar.extensions.bazaar.info.input",
      requestBindingError: error instanceof Error ? error.message : String(error),
    };
  }
}

function nestedRecords(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (!isRecord(node) || seen.has(node)) return;
    seen.add(node);
    out.push(node);
    for (const child of Object.values(node)) {
      if (isRecord(child)) visit(child);
      if (Array.isArray(child)) child.forEach(visit);
    }
  };
  visit(value);
  return out;
}

export function inferHttpMethod(
  extensions: Record<string, unknown>,
): TargetCandidate["method"] {
  for (const record of nestedRecords(extensions)) {
    const method = record.method;
    if (typeof method !== "string") continue;
    const upper = method.toUpperCase();
    if (
      upper === "GET" ||
      upper === "POST" ||
      upper === "PUT" ||
      upper === "PATCH" ||
      upper === "DELETE" ||
      upper === "HEAD"
    ) {
      return upper;
    }
  }
  return "GET";
}

function normalizeAccept(accept: BazaarAccept): TargetAccept {
  return {
    scheme: accept.scheme,
    network: accept.network,
    asset: accept.asset,
    amountAtomic: accept.amount,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
  };
}

function parseAtomic(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function hasValidAmount(accept: TargetAccept): boolean {
  return parseAtomic(accept.amountAtomic) !== null;
}

function isBaseAccept(accept: TargetAccept, x402Version: number): boolean {
  if (x402Version !== 1 && x402Version !== 2) return false;
  try {
    return (
      normalizeX402NetworkIdentity(x402Version, accept.network).canonical_caip2 ===
      MAINNET_NETWORK
    );
  } catch {
    return false;
  }
}

function isUsdcAccept(accept: TargetAccept): boolean {
  return accept.asset.toLowerCase() === MAINNET_USDC_ADDRESS.toLowerCase();
}

function cheapest(accepts: readonly TargetAccept[]): TargetAccept {
  return accepts.reduce((a, b) => {
    const aAmount = parseAtomic(a.amountAtomic) ?? 0n;
    const bAmount = parseAtomic(b.amountAtomic) ?? 0n;
    return aAmount <= bAmount ? a : b;
  });
}

export function normalizeTargetCandidate(resource: BazaarResource): TargetCandidate {
  const method = inferHttpMethod(resource.extensions);
  const request = resolveTargetRequestBinding({
    resourceUrl: resource.resourceUrl,
    method,
    extensions: resource.extensions,
  });
  return {
    candidateId: candidateId(resource.resourceUrl),
    resourceUrl: resource.resourceUrl,
    method,
    accepts: resource.accepts.map((accept) => normalizeAccept(accept)),
    x402Version: resource.x402Version,
    freshness: {
      lastUpdated: resource.lastUpdated,
      sortKey: resource.lastUpdated ?? "",
    },
    registrationMetadata: resource.extensions,
    ...request,
  };
}

export function resolveMaxTargetPriceAtomic(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[TRUSTFORGE_MAX_TARGET_PRICE_ATOMIC_ENV]?.trim();
  if (!configured) return DEFAULT_MAX_TARGET_PRICE_ATOMIC;
  if (!/^\d+$/.test(configured)) {
    throw new Error(`${TRUSTFORGE_MAX_TARGET_PRICE_ATOMIC_ENV} must be atomic USDC integer`);
  }
  return configured;
}

function rejectionFor(
  candidate: TargetCandidate,
  maxAtomic: bigint,
): RejectedTargetCandidate | null {
  if (candidate.accepts.length === 0) {
    return {
      resourceUrl: candidate.resourceUrl,
      reason: "empty_accepts",
      detail: "Bazaar resource has no accepts[] entries",
    };
  }
  if (!candidate.accepts.every(hasValidAmount)) {
    return {
      resourceUrl: candidate.resourceUrl,
      reason: "malformed_accept",
      detail: "At least one accepts[] amount is missing or non-integer",
    };
  }
  const base = candidate.accepts.filter((accept) =>
    isBaseAccept(accept, candidate.x402Version),
  );
  if (base.length === 0) {
    return {
      resourceUrl: candidate.resourceUrl,
      reason: "wrong_network",
      detail: `No accepts[] entry on ${MAINNET_NETWORK}`,
    };
  }
  const baseUsdc = base.filter(isUsdcAccept);
  if (baseUsdc.length === 0) {
    return {
      resourceUrl: candidate.resourceUrl,
      reason: "wrong_asset",
      detail: `No Base accepts[] entry uses USDC ${MAINNET_USDC_ADDRESS}`,
    };
  }
  const best = cheapest(baseUsdc);
  const amount = parseAtomic(best.amountAtomic);
  if (amount === null) {
    return {
      resourceUrl: candidate.resourceUrl,
      reason: "malformed_accept",
      detail: "Cheapest Base USDC accepts[] amount is missing or non-integer",
    };
  }
  if (amount > maxAtomic) {
    return {
      resourceUrl: candidate.resourceUrl,
      reason: "over_budget",
      detail: `Cheapest Base USDC quote ${best.amountAtomic} exceeds budget ${maxAtomic.toString()}`,
    };
  }
  return null;
}

export function filterTargetCandidates(
  resources: readonly BazaarResource[],
  options: {
    readonly maxTargetPriceAtomic?: string;
  } = {},
): TargetFilterResult {
  const maxTargetPriceAtomic = options.maxTargetPriceAtomic ?? resolveMaxTargetPriceAtomic();
  const maxAtomic = parseAtomic(maxTargetPriceAtomic);
  if (maxAtomic === null) {
    throw new Error("maxTargetPriceAtomic must be an atomic USDC integer");
  }

  const accepted: TargetCandidate[] = [];
  const rejected: RejectedTargetCandidate[] = [];

  for (const resource of resources) {
    const candidate = normalizeTargetCandidate(resource);
    const rejection = rejectionFor(candidate, maxAtomic);
    if (rejection) {
      rejected.push(rejection);
    } else {
      accepted.push(candidate);
    }
  }

  return {
    accepted,
    rejected,
    maxTargetPriceAtomic,
  };
}
