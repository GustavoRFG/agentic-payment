import { describe, expect, it } from "vitest";
import {
  REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED,
  assertX402NetworkMatchesCanonical,
  canonicalCaip2ChainId,
  normalizeX402NetworkIdentity,
} from "../../tools/trustforge/x402-network-identity";

describe("x402 version-aware network identity", () => {
  it.each([
    [1, "base", "eip155:8453", 8453],
    [1, "base-sepolia", "eip155:84532", 84532],
    [2, "eip155:8453", "eip155:8453", 8453],
    [2, "eip155:84532", "eip155:84532", 84532],
  ] as const)(
    "maps x402 v%s raw %s to exact CAIP-2 %s",
    (version, raw, canonical, chainId) => {
      const identity = normalizeX402NetworkIdentity(version, raw);
      expect(identity).toEqual({
        protocol_version: version,
        seller_network_raw: raw,
        canonical_caip2: canonical,
      });
      expect(canonicalCaip2ChainId(identity.canonical_caip2)).toBe(chainId);
    },
  );

  it.each([
    [1, "eip155:8453"],
    [1, "unknown"],
    [1, "Base"],
    [1, " base"],
    [2, "base"],
    [2, "8453"],
    [2, "mainnet"],
    [2, "ethereum"],
    [2, "eip155:8453 "],
  ] as const)("rejects unregistered x402 v%s network %s", (version, raw) => {
    expect(() => normalizeX402NetworkIdentity(version, raw)).toThrow(
      REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED,
    );
  });

  it("blocks Base and Base Sepolia cross-profile identity", () => {
    expect(() =>
      assertX402NetworkMatchesCanonical({
        protocolVersion: 1,
        sellerNetworkRaw: "base",
        canonicalCaip2: "eip155:84532",
      }),
    ).toThrow(REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED);
    expect(() =>
      assertX402NetworkMatchesCanonical({
        protocolVersion: 1,
        sellerNetworkRaw: "base-sepolia",
        canonicalCaip2: "eip155:8453",
      }),
    ).toThrow(REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED);
  });
});
