import { describe, expect, it } from "vitest";

import { scorePosition } from "../../seller-api/src/domain/riskScoring";
import type { NormalizedPosition } from "../../seller-api/src/domain/reportTypes";

function position(overrides: Partial<NormalizedPosition> = {}): NormalizedPosition {
  return {
    protocol: "pancakeswap-v3",
    chain: "bsc",
    tokenId: "demo",
    pair: "CAKE/WBNB",
    rangeStatus: "in_range",
    feesUsd: 1,
    impermanentLossEstimatePct: null,
    healthFlags: [],
    ...overrides,
  };
}

describe("risk scoring", () => {
  it("does not penalize healthy in-range positions as low-liquidity when pool liquidity is unknown", () => {
    const risk = scorePosition(position());
    const knownLowLiquidity = scorePosition(position({ liquidityUsd: 100 }));

    expect(risk.score).toBeLessThan(knownLowLiquidity.score);
    expect(risk.drivers).toContain("Pool liquidity unknown.");
    expect(risk.drivers).not.toContain("Mocked liquidity is below the low-liquidity threshold.");
  });

  it("out-of-range position increases risk", () => {
    const inRange = scorePosition(position({ rangeStatus: "in_range" })).score;
    const outOfRange = scorePosition(position({ rangeStatus: "out_of_range" })).score;
    expect(outOfRange).toBeGreaterThan(inRange);
  });

  it("zero-liquidity flag increases risk strongly", () => {
    const healthy = scorePosition(position()).score;
    const zeroLiquidity = scorePosition(position({ healthFlags: ["zero-liquidity"] })).score;
    expect(zeroLiquidity - healthy).toBeGreaterThanOrEqual(30);
  });

  it("critical flags remain critical", () => {
    const risk = scorePosition(
      position({
        rangeStatus: "out_of_range",
        impermanentLossEstimatePct: 9,
        healthFlags: ["zero-liquidity", "out-of-range", "manual-review"],
      }),
    );
    expect(risk.level).toBe("critical");
  });
});
