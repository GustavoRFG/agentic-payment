import { describe, expect, it } from "vitest";

import {
  detectSecretMarkers,
  forbiddenSnapshotPath,
  validateDefiGuardianSnapshotV1,
} from "../../seller-api/src/domain/defiGuardianSnapshotV1";

function validSnapshot() {
  return {
    snapshotVersion: "defi-guardian-snapshot-v1",
    generatedAt: "2026-05-30T00:00:00.000Z",
    source: "defi-guardian-local-sanitized-export",
    chainId: 56,
    positions: [
      {
        protocol: "pancakeswap-v3",
        tokenId: "demo-real-file-001",
        chain: "bsc",
        pair: "CAKE/WBNB",
        walletAlias: "DEMO-WALLET",
        inRange: true,
        rangeStatus: "in_range",
        positionValueUsd: 420.5,
        poolLiquidityUsd: 10000,
        estimatedCollectibleLpFeesUsd: 3.42,
        impermanentLossEstimatePct: 1.2,
        rangeRiskLevel: "LOW",
        recommendedAction: "HOLD",
        healthFlags: [],
      },
    ],
  };
}

describe("DeFi Guardian snapshot v1", () => {
  it("parses a valid fixture", () => {
    const result = validateDefiGuardianSnapshotV1(validSnapshot());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokenIds).toEqual(["demo-real-file-001"]);
  });

  it("rejects wrong snapshotVersion", () => {
    const snapshot = validSnapshot();
    snapshot.snapshotVersion = "wrong";
    expect(validateDefiGuardianSnapshotV1(snapshot).ok).toBe(false);
  });

  it("rejects chainId other than 56", () => {
    const snapshot = validSnapshot();
    snapshot.chainId = 1;
    expect(validateDefiGuardianSnapshotV1(snapshot).ok).toBe(false);
  });

  it("rejects missing tokenId", () => {
    const snapshot = validSnapshot();
    delete (snapshot.positions[0] as Record<string, unknown>).tokenId;
    expect(validateDefiGuardianSnapshotV1(snapshot).ok).toBe(false);
  });

  it("rejects invalid rangeStatus", () => {
    const snapshot = validSnapshot();
    snapshot.positions[0].rangeStatus = "invalid";
    expect(validateDefiGuardianSnapshotV1(snapshot).ok).toBe(false);
  });

  it("rejects negative positionValueUsd", () => {
    const snapshot = validSnapshot();
    snapshot.positions[0].positionValueUsd = -1;
    expect(validateDefiGuardianSnapshotV1(snapshot).ok).toBe(false);
  });

  it("rejects forbidden snapshot paths", () => {
    expect(forbiddenSnapshotPath(".env")).not.toBeNull();
    expect(forbiddenSnapshotPath("secrets/cdp.env")).not.toBeNull();
    expect(forbiddenSnapshotPath("fixtures/private-snapshot.json")).not.toBeNull();
    expect(forbiddenSnapshotPath("fixtures/secret-snapshot.json")).not.toBeNull();
  });

  it("detects secret markers in nested objects and arrays", () => {
    expect(detectSecretMarkers({ nested: { BUYER_PRIVATE_KEY: "x" } })).toBe(true);
    expect(detectSecretMarkers(["safe", "authorization header"])).toBe(true);
  });
});
