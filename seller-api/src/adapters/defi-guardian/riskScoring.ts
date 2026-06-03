import type {
  NormalizedPosition,
  RecommendationAction,
  RiskAssessment,
  RiskLevel,
} from "./reportTypes";

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function riskLevelForScore(score: number): RiskLevel {
  if (score <= 24) return "low";
  if (score <= 59) return "medium";
  if (score <= 84) return "high";
  return "critical";
}

export function recommendationForRiskLevel(
  level: RiskLevel,
): RecommendationAction {
  if (level === "low") return "hold";
  if (level === "medium") return "monitor";
  if (level === "high") return "rebalance-review";
  return "urgent-review";
}

export function scorePosition(position: NormalizedPosition): RiskAssessment {
  let score = 50;
  const drivers: string[] = [];

  if (position.rangeStatus === "in_range") {
    score -= 10;
    drivers.push("Position is in range.");
  } else if (position.rangeStatus === "near_edge") {
    score += 10;
    drivers.push("Position is near the edge of its configured range.");
  } else {
    score += 30;
    drivers.push("Position is out of range.");
  }

  if (position.liquidityUsd === undefined) {
    score += 3;
    drivers.push("Pool liquidity unknown.");
  } else if (position.liquidityUsd >= 1000) {
    score -= 5;
    drivers.push("Mocked liquidity is at or above the demo threshold.");
  } else if (position.liquidityUsd < 500) {
    score += 15;
    drivers.push("Mocked liquidity is below the low-liquidity threshold.");
  } else {
    drivers.push("Mocked liquidity is between demo thresholds.");
  }

  if (position.impermanentLossEstimatePct === null) {
    score += 5;
    drivers.push("Impermanent loss estimate was not provided.");
  } else if (position.impermanentLossEstimatePct <= 2) {
    score += 5;
    drivers.push("Impermanent loss estimate is low but still mocked.");
  } else if (position.impermanentLossEstimatePct <= 5) {
    score += 15;
    drivers.push("Impermanent loss estimate is moderate in mock data.");
  } else {
    score += 30;
    drivers.push("Impermanent loss estimate is elevated in mock data.");
  }

  if (position.healthFlags.includes("zero-liquidity")) {
    score += 35;
    drivers.push("Zero-liquidity flag present.");
  }
  if (position.healthFlags.includes("manual-review")) {
    score += 10;
    drivers.push("Manual review flag present.");
  }
  if (position.healthFlags.includes("out-of-range")) {
    score += 25;
    drivers.push("Out-of-range health flag present.");
  }

  drivers.push(
    position.liquidityUsd === undefined
      ? "Liquidity depth was not provided by the snapshot."
      : "Liquidity depth is mocked.",
  );

  const finalScore = clampScore(score);
  return {
    score: finalScore,
    level: riskLevelForScore(finalScore),
    drivers,
  };
}
