import { defaultSamplePosition } from "../fixtures/samplePositions";
import { getDefiGuardianAdapterConfig } from "./defiGuardianAdapterMode";
import { analyzePositionFromRealFile } from "./defiGuardianRealAdapter";
import {
  recommendationForRiskLevel,
  scorePosition,
} from "./riskScoring";
import type {
  CheckStatus,
  DefiGuardianReportMode,
  NormalizedPosition,
  NormalizedRiskReportRequest,
  RangeStatus,
  RiskReport,
  RiskReportRequest,
  Severity,
} from "./reportTypes";

export function validateRiskReportPayload(
  body: RiskReportRequest,
): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (
    body.wallet === undefined ||
    typeof body.wallet !== "string" ||
    body.wallet.length === 0
  ) {
    missing.push("wallet");
  }
  if (!body.position || typeof body.position !== "object") {
    missing.push("position");
    return { ok: false, missing };
  }
  if (
    body.position.protocol === undefined ||
    typeof body.position.protocol !== "string" ||
    body.position.protocol.length === 0
  ) {
    missing.push("position.protocol");
  }
  if (
    body.position.chain === undefined ||
    typeof body.position.chain !== "string" ||
    body.position.chain.length === 0
  ) {
    missing.push("position.chain");
  }
  if (
    body.position.tokenId === undefined ||
    typeof body.position.tokenId !== "string" ||
    body.position.tokenId.length === 0
  ) {
    missing.push("position.tokenId");
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRangeStatus(value: unknown): RangeStatus {
  if (value === "near_edge" || value === "out_of_range") return value;
  return "in_range";
}

function normalizeHealthFlags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeRequest(
  body: RiskReportRequest,
): NormalizedRiskReportRequest {
  const position = body.position ?? {};
  return {
    wallet: normalizeString(body.wallet, ""),
    position: {
      protocol: normalizeString(
        position.protocol,
        defaultSamplePosition.protocol,
      ),
      chain: normalizeString(position.chain, defaultSamplePosition.chain),
      tokenId: normalizeString(
        position.tokenId,
        defaultSamplePosition.tokenId,
      ),
      pair: normalizeString(position.pair, defaultSamplePosition.pair),
      rangeStatus: normalizeRangeStatus(position.rangeStatus),
      liquidityUsd: normalizeNumber(
        position.liquidityUsd,
        defaultSamplePosition.liquidityUsd ?? 0,
      ),
      feesUsd: normalizeNumber(position.feesUsd, defaultSamplePosition.feesUsd),
      impermanentLossEstimatePct: normalizeOptionalNumber(
        position.impermanentLossEstimatePct,
      ),
      healthFlags: normalizeHealthFlags(position.healthFlags),
    },
  };
}

function rangeSeverity(status: RangeStatus): Severity {
  if (status === "in_range") return "low";
  if (status === "near_edge") return "medium";
  return "high";
}

function rangeExplanation(status: RangeStatus): string {
  if (status === "in_range") {
    return "The mock adapter considers the position currently active.";
  }
  if (status === "near_edge") {
    return "The mock adapter considers the position close to a range boundary.";
  }
  return "The mock adapter considers the position outside its active range.";
}

function liquiditySeverity(position: NormalizedPosition): Severity {
  if (position.healthFlags.includes("zero-liquidity")) return "critical";
  if (position.liquidityUsd === undefined) return "medium";
  if (position.liquidityUsd < 500) return "high";
  return "medium";
}

function recommendationRationale(action: string): string {
  if (action === "hold") {
    return (
      "Position appears stable in mock mode, but should be monitored until " +
      "real pool data is connected."
    );
  }
  if (action === "monitor") {
    return (
      "Position is acceptable for a demo flow, but mock risk signals should " +
      "be monitored before real integration."
    );
  }
  if (action === "rebalance-review") {
    return (
      "Mock risk signals are elevated and should be reviewed before taking " +
      "any real portfolio action."
    );
  }
  return (
    "Mock risk signals are critical; this result should trigger urgent human " +
    "review in a real integration."
  );
}

function confidenceForScore(score: number): "low" | "medium" | "high" {
  if (score >= 85) return "high";
  if (score >= 60) return "medium";
  return "medium";
}

function rangeCheck(status: RangeStatus): { status: CheckStatus; detail: string } {
  if (status === "in_range") {
    return {
      status: "pass",
      detail: "Position is currently marked as in range.",
    };
  }
  if (status === "near_edge") {
    return {
      status: "warn",
      detail: "Position is marked near the configured range edge.",
    };
  }
  return {
    status: "fail",
    detail: "Position is marked out of range.",
  };
}

function liquidityCheck(
  position: NormalizedPosition,
): { status: CheckStatus; detail: string } {
  if (position.healthFlags.includes("zero-liquidity")) {
    return {
      status: "fail",
      detail: "Position includes a zero-liquidity flag in mock data.",
    };
  }
  if (position.liquidityUsd === undefined) {
    return {
      status: "warn",
      detail: "Pool liquidity is unknown.",
    };
  }
  if (position.liquidityUsd < 500) {
    return {
      status: "warn",
      detail: "Mocked liquidity is below the demo threshold.",
    };
  }
  return {
    status: "warn",
    detail: "Liquidity depth is mocked; real pool data is not connected yet.",
  };
}

function createMockRiskReport(body: RiskReportRequest): RiskReport {
  const normalized = normalizeRequest(body);
  const risk = scorePosition(normalized.position);
  const action = recommendationForRiskLevel(risk.level);
  const range = rangeCheck(normalized.position.rangeStatus);
  const liquidity = liquidityCheck(normalized.position);

  return {
    reportId: "mock-report-001",
    mode: "adapter-mock",
    adapter: {
      requestedMode: "adapter-mock",
      resolvedMode: "adapter-mock",
      fallbackUsed: false,
    },
    generatedAt: new Date().toISOString(),
    wallet: normalized.wallet,
    position: {
      protocol: normalized.position.protocol,
      chain: normalized.position.chain,
      tokenId: normalized.position.tokenId,
      pair: normalized.position.pair,
    },
    risk,
    range: {
      status: normalized.position.rangeStatus,
      severity: rangeSeverity(normalized.position.rangeStatus),
      explanation: rangeExplanation(normalized.position.rangeStatus),
    },
    liquidity: {
      estimatedUsd: normalized.position.liquidityUsd ?? null,
      severity: liquiditySeverity(normalized.position),
      explanation:
        "Liquidity is sufficient for a demo position, but real pool depth " +
        "is not connected yet.",
    },
    fees: {
      estimatedUsd: normalized.position.feesUsd,
      comment: "Fee data is mocked until DeFi Guardian real integration.",
    },
    recommendation: {
      action,
      confidence: confidenceForScore(risk.score),
      rationale: recommendationRationale(action),
    },
    warnings: [
      "This is a mock adapter report, not financial advice.",
      "No real on-chain position data was queried.",
    ],
    checks: [
      {
        name: "range",
        status: range.status,
        detail: range.detail,
      },
      {
        name: "liquidity",
        status: liquidity.status,
        detail: liquidity.detail,
      },
    ],
  };
}

function fallbackReport(
  body: RiskReportRequest,
  requestedMode: DefiGuardianReportMode,
  warnings: string[],
): RiskReport {
  const report = createMockRiskReport(body);
  const fallbackWarnings = [
    "Real DeFi Guardian snapshot could not be loaded.",
    ...warnings,
    "Falling back to adapter-mock.",
  ];
  return {
    ...report,
    reportId: `${requestedMode}-fallback-001`,
    mode: "adapter-mock",
    adapter: {
      requestedMode,
      resolvedMode: "adapter-mock",
      fallbackUsed: true,
    },
    warnings: [...fallbackWarnings, ...report.warnings],
    checks: [
      {
        name: "defi_guardian_adapter",
        status: "warn",
        detail: fallbackWarnings.join(" "),
      },
      ...report.checks,
    ],
  };
}

export const defiGuardianAdapter = {
  analyzePosition(body: RiskReportRequest): RiskReport {
    const config = getDefiGuardianAdapterConfig();
    if (config.mode === "adapter-mock") {
      const report = createMockRiskReport(body);
      if (config.warnings.length === 0) return report;
      return {
        ...report,
        warnings: [...config.warnings, ...report.warnings],
      };
    }

    if (config.mode === "adapter-real-file") {
      const result = analyzePositionFromRealFile(body, config);
      if (result.ok) return result.report;
      return fallbackReport(body, config.mode, result.warnings);
    }

    return fallbackReport(body, config.mode, [
      ...config.warnings,
      "adapter-real-cli is reserved for a future read-only CLI integration.",
      "No DeFi Guardian CLI command was executed.",
      "Falling back to adapter-mock.",
    ]);
  },
};
