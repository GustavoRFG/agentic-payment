/**
 * Pure, version-aware x402 seller network identity.
 *
 * x402 v1 uses protocol aliases while v2 uses CAIP-2. TrustForge accepts only
 * the explicitly registered Base identities below: no trimming, case folding,
 * numeric shortcuts, or heuristic aliases are allowed.
 */

export const REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED =
  "REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED" as const;

export interface X402NetworkIdentity {
  readonly protocol_version: 1 | 2;
  readonly seller_network_raw: string;
  readonly canonical_caip2: "eip155:8453" | "eip155:84532";
}

const V1_NETWORKS: Readonly<Record<string, X402NetworkIdentity["canonical_caip2"]>> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};

const V2_NETWORKS: Readonly<Record<string, X402NetworkIdentity["canonical_caip2"]>> = {
  "eip155:8453": "eip155:8453",
  "eip155:84532": "eip155:84532",
};

export function normalizeX402NetworkIdentity(
  protocolVersion: 1 | 2,
  sellerNetworkRaw: unknown,
): X402NetworkIdentity {
  if (typeof sellerNetworkRaw !== "string") {
    throw new Error(
      `${REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED}: seller network must be a string`,
    );
  }
  const canonical =
    protocolVersion === 1 ? V1_NETWORKS[sellerNetworkRaw] : V2_NETWORKS[sellerNetworkRaw];
  if (!canonical) {
    throw new Error(
      `${REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED}: x402 v${protocolVersion} network ${JSON.stringify(sellerNetworkRaw)} is not registered`,
    );
  }
  return {
    protocol_version: protocolVersion,
    seller_network_raw: sellerNetworkRaw,
    canonical_caip2: canonical,
  };
}

export function canonicalCaip2ChainId(
  canonicalCaip2: X402NetworkIdentity["canonical_caip2"],
): 8453 | 84532 {
  return canonicalCaip2 === "eip155:8453" ? 8453 : 84532;
}

export function assertX402NetworkMatchesCanonical(input: {
  readonly protocolVersion: 1 | 2;
  readonly sellerNetworkRaw: string;
  readonly canonicalCaip2: string;
}): X402NetworkIdentity {
  const identity = normalizeX402NetworkIdentity(
    input.protocolVersion,
    input.sellerNetworkRaw,
  );
  if (identity.canonical_caip2 !== input.canonicalCaip2) {
    throw new Error(
      `${REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED}: canonical network ${input.canonicalCaip2} does not match seller network ${JSON.stringify(input.sellerNetworkRaw)}`,
    );
  }
  return identity;
}
