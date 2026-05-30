import { existsSync, readFileSync, statSync } from "node:fs";
import {
  DEFI_GUARDIAN_SNAPSHOT_V1,
  forbiddenSnapshotPath,
  parseDefiGuardianSnapshotV1Json,
  type DefiGuardianSnapshotPositionV1,
  type DefiGuardianSnapshotV1,
} from "./defiGuardianSnapshotV1";
import { recommendationForRiskLevel, scorePosition } from "./riskScoring";
import type { DefiGuardianAdapterConfig } from "./defiGuardianAdapterMode";
import type {
  CheckStatus,
  NormalizedPosition,
  RangeStatus,
  RecommendationAction,
  RiskAssessment,
  RiskReport,
  RiskReportRequest,
  Severity,
} from "./reportTypes";

export type RealAdapterResult =
  | { ok: true; report: RiskReport }
  | { ok: false; warnings: string[] };

function requestPosition(body: RiskReportRequest): Record<string, unknown> {
  return typeof body.position === "object" && body.position !== null
    ? body.position
    : {};
}

function requestedTokenId(body: RiskReportRequest): string | null {
  const value = requestPosition(body).tokenId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSnapshotFile(snapshotPath: string): {
  ok: true;
  snapshot: DefiGuardianSnapshotV1;
} | { ok: false; warnings: string[] } {
  const forbidden = forbiddenSnapshotPath(snapshotPath);
  if (forbidden !== null) return { ok: false, warnings: [forbidden] };
  if (!existsSync(snapshotPath)) {
    return {
      ok: false,
      warnings: [`Snapshot path does not exist: ${snapshotPath}`],
    };
  }

  try {
    const stats = statSync(snapshotPath);
    if (!stats.isFile()) {
      return { ok: false, warnings: [`Snapshot path is not a file: ${snapshotPath}`] };
    }
    const raw = readFileSync(snapshotPath, "utf8");
    const parsed = parseDefiGuardianSnapshotV1Json(raw);
    if (!parsed.ok) {
      return { ok: false, warnings: parsed.errors };
    }
    return { ok: true, snapshot: parsed.snapshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, warnings: [`Unable to read snapshot file: ${message}`] };
  }
}

function selectPosition(
  snapshot: DefiGuardianSnapshotV1,
  body: RiskReportRequest,
): { ok: true; position: DefiGuardianSnapshotPositionV1 } | {
  ok: false;
  warnings: string[];
} {
  const tokenId = requestedTokenId(body);
  if (tokenId === null) {
    return { ok: false, warnings: ["Request position.tokenId was not provided."] };
  }
  const position = snapshot.positions.find((entry) => entry.tokenId === tokenId);
  if (!position) {
    return {
      ok: false,
      warnings: [`Snapshot does not contain requested tokenId "${tokenId}".`],
    };
  }
  return { ok: true, position };
}

function normalizedPosition(
  position: DefiGuardianSnapshotPositionV1,
): NormalizedPosition {
  return {
    protocol: position.protocol,
    chain: position.chain,
    tokenId: position.tokenId,
    pair: position.pair,
    rangeStatus: position.rangeStatus,
    liquidityUsd: position.positionValueUsd,
    feesUsd: position.estimatedCollectibleLpFeesUsd,
    impermanentLossEstimatePct: position.impermanentLossEstimatePct ?? null,
    healthFlags: position.healthFlags ?? [],
  };
}

function rangeSeverity(status: RangeStatus): Severity {
  if (status === "in_range") return "low";
  if (status === "near_edge") return "medium";
  return "high";
}

function liquiditySeverity(position: NormalizedPosition): Severity {
  if (position.healthFlags.includes("zero-liquidity")) return "critical";
  if (position.liquidityUsd < 500) return "high";
  return "medium";
}

function checkStatusForRange(status: RangeStatus): CheckStatus {
  if (status === "in_range") return "pass";
  if (status === "near_edge") return "warn";
  return "fail";
}

function recommendationFromSnapshot(
  position: DefiGuardianSnapshotPositionV1,
  risk: RiskAssessment,
): RecommendationAction {
  const raw = (position.recommendedAction ?? "").toUpperCase();
  if (raw.includes("URGENT") || raw.includes("NOW")) return "urgent-review";
  if (raw.includes("REVIEW") || raw.includes("RERANGE")) {
    return recommendationForRiskLevel("high");
  }
  if (raw.includes("WATCH") || raw.includes("MONITOR") || raw.includes("WAIT")) {
    return "monitor";
  }
  if (raw.includes("REMAIN") || raw.includes("HOLD")) return "hold";
  return recommendationForRiskLevel(risk.level);
}

function confidenceForRisk(risk: RiskAssessment): "low" | "medium" | "high" {
  if (risk.score >= 85) return "high";
  if (risk.score >= 60) return "medium";
  return "medium";
}

export function analyzePositionFromRealFile(
  body: RiskReportRequest,
  config: DefiGuardianAdapterConfig,
): RealAdapterResult {
  const warnings = [...config.warnings];
  if (config.snapshotPath === null) {
    return {
      ok: false,
      warnings: [...warnings, "DEFI_GUARDIAN_SNAPSHOT_PATH is not configured."],
    };
  }

  const snapshot = readSnapshotFile(config.snapshotPath);
  if (!snapshot.ok) {
    return { ok: false, warnings: [...warnings, ...snapshot.warnings] };
  }

  const selected = selectPosition(snapshot.snapshot, body);
  if (!selected.ok) {
    return { ok: false, warnings: [...warnings, ...selected.warnings] };
  }

  const normalized = normalizedPosition(selected.position);
  const risk = scorePosition(normalized);
  const recommendation = recommendationFromSnapshot(selected.position, risk);
  const liquidity = liquiditySeverity(normalized);

  return {
    ok: true,
    report: {
      reportId: `real-file-${selected.position.tokenId}`,
      mode: "adapter-real-file",
      adapter: {
        requestedMode: "adapter-real-file",
        resolvedMode: "adapter-real-file",
        fallbackUsed: false,
        snapshotVersion: DEFI_GUARDIAN_SNAPSHOT_V1,
        source: "local-sanitized-json",
      },
      generatedAt: snapshot.snapshot.generatedAt,
      wallet: typeof body.wallet === "string" ? body.wallet : "",
      position: {
        protocol: selected.position.protocol,
        chain: selected.position.chain,
        tokenId: selected.position.tokenId,
        pair: selected.position.pair,
      },
      risk,
      range: {
        status: selected.position.rangeStatus,
        severity: rangeSeverity(selected.position.rangeStatus),
        explanation:
          "Range status was mapped from a sanitized DeFi Guardian snapshot v1 file.",
      },
      liquidity: {
        estimatedUsd: selected.position.positionValueUsd,
        severity: liquidity,
        explanation:
          "Position value was mapped from sanitized DeFi Guardian snapshot v1 data.",
      },
      fees: {
        estimatedUsd: selected.position.estimatedCollectibleLpFeesUsd,
        comment:
          "Fee data was mapped from sanitized DeFi Guardian snapshot v1 data.",
      },
      recommendation: {
        action: recommendation,
        confidence: confidenceForRisk(risk),
        rationale:
          "Recommendation is derived from sanitized DeFi Guardian snapshot v1 fields.",
      },
      warnings: [
        "adapter-real-file uses a sanitized local JSON snapshot and never executes transactions.",
        "This report is not financial advice.",
      ],
      checks: [
        {
          name: "defi_guardian_snapshot_v1",
          status: "pass",
          detail: `Loaded ${DEFI_GUARDIAN_SNAPSHOT_V1} from configured path.`,
        },
        {
          name: "range",
          status: checkStatusForRange(selected.position.rangeStatus),
          detail: `Snapshot range status is ${selected.position.rangeStatus}.`,
        },
        {
          name: "liquidity",
          status: liquidity === "critical" ? "fail" : "warn",
          detail: `Snapshot position value is ${selected.position.positionValueUsd}.`,
        },
      ],
    },
  };
}
