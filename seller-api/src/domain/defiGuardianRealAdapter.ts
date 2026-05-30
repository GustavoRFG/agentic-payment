import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { recommendationForRiskLevel, riskLevelForScore } from "./riskScoring";
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

type JsonRecord = Record<string, unknown>;

export type RealAdapterResult =
  | { ok: true; report: RiskReport }
  | { ok: false; warnings: string[] };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value.replace(/[$,%\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function readString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function readNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function requestPosition(body: RiskReportRequest): JsonRecord {
  return isRecord(body.position) ? body.position : {};
}

function requestedTokenId(body: RiskReportRequest): string | null {
  return readString(requestPosition(body), ["tokenId", "token_id"]);
}

function chainFromSnapshot(record: JsonRecord, body: RiskReportRequest): string {
  const chain =
    readString(record, ["chain", "chainLabel", "network"]) ??
    readString(requestPosition(body), ["chain"]);
  if (chain) return chain;
  const chainId = readNumber(record, ["chainId", "chain_id"]);
  if (chainId === 56) return "bsc";
  return "unknown";
}

function pairFromSnapshot(record: JsonRecord, body: RiskReportRequest): string {
  const pair = readString(record, ["pair"]);
  if (pair) return pair;
  const token0 = readString(record, ["token0Symbol", "token0_symbol", "token0"]);
  const token1 = readString(record, ["token1Symbol", "token1_symbol", "token1"]);
  if (token0 && token1) return `${token0}/${token1}`;
  return readString(requestPosition(body), ["pair"]) ?? "unknown";
}

function rangeStatusFromSnapshot(record: JsonRecord): RangeStatus {
  const explicit = readString(record, ["rangeStatus", "range_status"]);
  if (explicit === "near_edge" || explicit === "out_of_range") return explicit;
  if (explicit === "in_range") return explicit;

  const state = (
    readString(record, [
      "state",
      "status",
      "currentState",
      "rangeBehavior",
      "rangeRisk",
      "rangeRiskLevel",
      "recommendation",
      "recommendedAction",
    ]) ?? ""
  ).toUpperCase();
  if (record.inRange === false || state.includes("OUT_OF_RANGE")) {
    return "out_of_range";
  }
  if (
    state.includes("HIGH") ||
    state.includes("REVIEW_RANGE") ||
    state.includes("WATCH_CLOSELY") ||
    state.includes("NEAR")
  ) {
    return "near_edge";
  }
  return "in_range";
}

function healthFlagsFromSnapshot(record: JsonRecord, rangeStatus: RangeStatus): string[] {
  const flags = new Set<string>();
  const state = (
    readString(record, ["state", "status", "currentState", "recommendation"]) ?? ""
  ).toUpperCase();
  if (state.includes("ZERO_LIQUIDITY")) flags.add("zero-liquidity");
  if (rangeStatus === "out_of_range") flags.add("out-of-range");
  if (state.includes("REVIEW") || state.includes("UNKNOWN")) {
    flags.add("manual-review");
  }
  return [...flags];
}

function normalizeSnapshotPosition(
  record: JsonRecord,
  body: RiskReportRequest,
  warnings: string[],
): NormalizedPosition {
  const request = requestPosition(body);
  const rangeStatus = rangeStatusFromSnapshot(record);
  const liquidityUsd = readNumber(record, [
    "liquidityUsd",
    "positionValueUsd",
    "currentPositionValueUsd",
    "estimatedTotalNavUsd",
    "totalWalletEconomicValueUsd",
    "lpPrincipalNavUsd",
  ]);
  const feesUsd = readNumber(record, [
    "feesUsd",
    "estimatedCollectibleLpFeesUsd",
    "lpFeesUsd",
    "pendingCakeUsd",
    "pendingFarmCakeUsd",
    "currentCollectibleLpFeesUsd",
  ]);

  if (liquidityUsd === null) {
    warnings.push(
      "Snapshot position did not include a known USD liquidity/value field.",
    );
  }
  if (feesUsd === null) {
    warnings.push("Snapshot position did not include a known fee USD field.");
  }

  return {
    protocol:
      readString(record, ["protocol"]) ??
      readString(request, ["protocol"]) ??
      "defi-guardian",
    chain: chainFromSnapshot(record, body),
    tokenId:
      readString(record, ["tokenId", "token_id", "id"]) ??
      readString(request, ["tokenId", "token_id"]) ??
      "unknown",
    pair: pairFromSnapshot(record, body),
    rangeStatus,
    liquidityUsd: liquidityUsd ?? 0,
    feesUsd: feesUsd ?? 0,
    impermanentLossEstimatePct: readNumber(record, [
      "impermanentLossEstimatePct",
      "netVsHoldPct",
      "netLpStrategyVsHoldPercent",
      "grossLpPrincipalVsHoldPercent",
    ]),
    healthFlags: healthFlagsFromSnapshot(record, rangeStatus),
  };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function riskFromSnapshot(
  position: NormalizedPosition,
  record: JsonRecord,
  warnings: string[],
): RiskAssessment {
  let score = 35;
  const drivers: string[] = [];

  if (position.rangeStatus === "in_range") {
    score -= 5;
    drivers.push("DeFi Guardian snapshot marks the position in range.");
  } else if (position.rangeStatus === "near_edge") {
    score += 20;
    drivers.push("DeFi Guardian snapshot marks the position near review range.");
  } else {
    score += 40;
    drivers.push("DeFi Guardian snapshot marks the position out of range.");
  }

  if (position.healthFlags.includes("zero-liquidity")) {
    score += 40;
    drivers.push("DeFi Guardian snapshot marks zero liquidity.");
  }
  if (position.healthFlags.includes("manual-review")) {
    score += 10;
    drivers.push("DeFi Guardian snapshot includes a manual review signal.");
  }
  if (position.liquidityUsd > 0 && position.liquidityUsd < 500) {
    score += 15;
    drivers.push("Snapshot USD value is below the low-liquidity threshold.");
  }

  const rangeRisk = (readString(record, ["rangeRiskLevel", "rangeRisk"]) ?? "")
    .toUpperCase();
  if (rangeRisk === "HIGH") {
    score += 20;
    drivers.push("Snapshot range risk is HIGH.");
  } else if (rangeRisk === "MODERATE" || rangeRisk === "MEDIUM") {
    score += 10;
    drivers.push("Snapshot range risk is moderate.");
  }

  if (warnings.length > 0) {
    score += 5;
    drivers.push("Some snapshot fields were missing or partially mapped.");
  }

  const finalScore = clampScore(score);
  return {
    score: finalScore,
    level: riskLevelForScore(finalScore),
    drivers,
  };
}

function rangeSeverity(status: RangeStatus): Severity {
  if (status === "in_range") return "low";
  if (status === "near_edge") return "medium";
  return "high";
}

function liquiditySeverity(position: NormalizedPosition): Severity {
  if (position.healthFlags.includes("zero-liquidity")) return "critical";
  if (position.liquidityUsd <= 0) return "high";
  if (position.liquidityUsd < 500) return "high";
  return "medium";
}

function checkStatusForRange(status: RangeStatus): CheckStatus {
  if (status === "in_range") return "pass";
  if (status === "near_edge") return "warn";
  return "fail";
}

function recommendationFromSnapshot(
  record: JsonRecord,
  risk: RiskAssessment,
): RecommendationAction {
  const raw = (
    readString(record, ["recommendation", "recommendedAction", "humanAction"]) ?? ""
  ).toUpperCase();
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

function gatherPositionRecords(value: unknown, depth = 0): JsonRecord[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) return [];

  const records: JsonRecord[] = [];
  if (
    readString(value, ["tokenId", "token_id", "id"]) !== null &&
    (readString(value, ["protocol"]) !== null ||
      readString(value, ["pair"]) !== null ||
      typeof value.inRange === "boolean")
  ) {
    records.push(value);
  }

  for (const key of [
    "positions",
    "outOfRange",
    "highRiskInRange",
    "latestPositions",
    "results",
    "data",
    "snapshot",
    "portfolio",
    "positionsResponse",
    "rangeActions",
    "rangeAdvisor",
  ]) {
    if (key in value) {
      records.push(...gatherPositionRecords(value[key], depth + 1));
    }
  }
  return records;
}

function selectPositionRecord(
  payload: unknown,
  body: RiskReportRequest,
): { ok: true; record: JsonRecord } | { ok: false; warnings: string[] } {
  const tokenId = requestedTokenId(body);
  const records = gatherPositionRecords(payload);
  if (records.length === 0) {
    return {
      ok: false,
      warnings: [
        "Snapshot did not contain a recognized positions array or position object.",
      ],
    };
  }
  if (tokenId === null) return { ok: true, record: records[0] as JsonRecord };

  const match = records.find(
    (record) => readString(record, ["tokenId", "token_id", "id"]) === tokenId,
  );
  if (match) return { ok: true, record: match };

  return {
    ok: false,
    warnings: [
      `Snapshot did not contain requested tokenId "${tokenId}".`,
    ],
  };
}

function forbiddenSnapshotPath(snapshotPath: string): string | null {
  const normalized = snapshotPath.toLowerCase();
  const fileName = basename(normalized);
  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return "Refusing to read an env file as a DeFi Guardian snapshot.";
  }
  if (
    normalized.includes("\\secrets\\") ||
    normalized.includes("/secrets/") ||
    fileName.includes("private") ||
    fileName.includes("secret")
  ) {
    return "Refusing to read a path that looks like it may contain secrets.";
  }
  return null;
}

function readSnapshotFile(snapshotPath: string): {
  ok: true;
  payload: unknown;
} | { ok: false; warnings: string[] } {
  const forbidden = forbiddenSnapshotPath(snapshotPath);
  if (forbidden !== null) return { ok: false, warnings: [forbidden] };
  if (!existsSync(snapshotPath)) {
    return {
      ok: false,
      warnings: [`Real DeFi Guardian snapshot path does not exist: ${snapshotPath}`],
    };
  }
  try {
    const stats = statSync(snapshotPath);
    if (!stats.isFile()) {
      return {
        ok: false,
        warnings: [`Real DeFi Guardian snapshot path is not a file: ${snapshotPath}`],
      };
    }
    const raw = readFileSync(snapshotPath, "utf8");
    return { ok: true, payload: JSON.parse(raw) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      warnings: [`Unable to read or parse DeFi Guardian snapshot JSON: ${message}`],
    };
  }
}

export function analyzePositionFromRealFile(
  body: RiskReportRequest,
  config: DefiGuardianAdapterConfig,
): RealAdapterResult {
  const warnings = [...config.warnings];
  if (config.snapshotPath === null) {
    return {
      ok: false,
      warnings: [
        ...warnings,
        "Real DeFi Guardian snapshot path is not configured.",
        "Falling back to adapter-mock.",
      ],
    };
  }

  const snapshot = readSnapshotFile(config.snapshotPath);
  if (!snapshot.ok) {
    return {
      ok: false,
      warnings: [...warnings, ...snapshot.warnings, "Falling back to adapter-mock."],
    };
  }

  const selected = selectPositionRecord(snapshot.payload, body);
  if (!selected.ok) {
    return {
      ok: false,
      warnings: [...warnings, ...selected.warnings, "Falling back to adapter-mock."],
    };
  }

  const position = normalizeSnapshotPosition(selected.record, body, warnings);
  const risk = riskFromSnapshot(position, selected.record, warnings);
  const recommendation = recommendationFromSnapshot(selected.record, risk);

  return {
    ok: true,
    report: {
      reportId: `real-file-${position.tokenId}`,
      mode: "adapter-real-file",
      generatedAt: new Date().toISOString(),
      wallet:
        readString(selected.record, ["wallet", "effectiveWallet", "effective_wallet"]) ??
        (typeof body.wallet === "string" ? body.wallet : ""),
      position: {
        protocol: position.protocol,
        chain: position.chain,
        tokenId: position.tokenId,
        pair: position.pair,
      },
      risk,
      range: {
        status: position.rangeStatus,
        severity: rangeSeverity(position.rangeStatus),
        explanation:
          "Range status was mapped from a local DeFi Guardian JSON snapshot.",
      },
      liquidity: {
        estimatedUsd: position.liquidityUsd,
        severity: liquiditySeverity(position),
        explanation:
          "Liquidity/value was mapped from a local DeFi Guardian JSON snapshot.",
      },
      fees: {
        estimatedUsd: position.feesUsd,
        comment:
          "Fee data was mapped from a local DeFi Guardian JSON snapshot when present.",
      },
      recommendation: {
        action: recommendation,
        confidence: warnings.length > 0 ? "medium" : "high",
        rationale:
          "Recommendation is derived from read-only DeFi Guardian snapshot fields.",
      },
      warnings: [
        "Real adapter file mode is read-only and never executes transactions.",
        "This report is not financial advice.",
        ...warnings,
      ],
      checks: [
        {
          name: "defi_guardian_snapshot",
          status: warnings.length > 0 ? "warn" : "pass",
          detail: `Loaded local snapshot file ${config.snapshotPath}.`,
        },
        {
          name: "range",
          status: checkStatusForRange(position.rangeStatus),
          detail: `Snapshot range status mapped to ${position.rangeStatus}.`,
        },
        {
          name: "liquidity",
          status: liquiditySeverity(position) === "critical" ? "fail" : "warn",
          detail: `Snapshot USD value mapped to ${position.liquidityUsd}.`,
        },
      ],
    },
  };
}
