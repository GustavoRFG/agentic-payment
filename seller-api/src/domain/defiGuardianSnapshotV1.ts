import { basename } from "node:path";

export const DEFI_GUARDIAN_SNAPSHOT_V1 =
  "defi-guardian-snapshot-v1" as const;
export const DEFI_GUARDIAN_SNAPSHOT_SOURCE =
  "defi-guardian-local-sanitized-export" as const;

export interface DefiGuardianSnapshotV1 {
  snapshotVersion: typeof DEFI_GUARDIAN_SNAPSHOT_V1;
  generatedAt: string;
  source: typeof DEFI_GUARDIAN_SNAPSHOT_SOURCE;
  chainId: 56;
  positions: DefiGuardianSnapshotPositionV1[];
}

export interface DefiGuardianSnapshotPositionV1 {
  protocol: "pancakeswap-v3" | "pancakeswap-infinity-cl" | string;
  tokenId: string;
  chain: "bsc";
  pair: string;
  walletAlias?: string;
  inRange: boolean;
  rangeStatus: "in_range" | "near_edge" | "out_of_range";
  positionValueUsd: number;
  estimatedCollectibleLpFeesUsd: number;
  impermanentLossEstimatePct?: number | null;
  rangeRiskLevel?: "LOW" | "MODERATE" | "HIGH" | "UNKNOWN";
  recommendedAction?: string;
  healthFlags?: string[];
}

export type SnapshotValidationResult =
  | { ok: true; snapshot: DefiGuardianSnapshotV1; tokenIds: string[] }
  | { ok: false; errors: string[]; secretsDetected: boolean };

const RANGE_STATUSES = new Set(["in_range", "near_edge", "out_of_range"]);
const RANGE_RISK_LEVELS = new Set(["LOW", "MODERATE", "HIGH", "UNKNOWN"]);

const SECRET_PATTERNS = [
  /CDP_API/i,
  /CDP_WALLET/i,
  /BUYER_PRIVATE_KEY/i,
  /PRIVATE_KEY/i,
  /MNEMONIC/i,
  /SEED_PHRASE/i,
  /wallet_secret/i,
  /authorization/i,
  /cookie/i,
  /paymentHeader/i,
  /signature/i,
];

export function forbiddenSnapshotPath(snapshotPath: string): string | null {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasSecretMarkerText(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function detectSecretMarkers(value: unknown): boolean {
  if (typeof value === "string") return hasSecretMarkerText(value);
  if (Array.isArray(value)) return value.some((entry) => detectSecretMarkers(entry));
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (hasSecretMarkerText(key) || detectSecretMarkers(nested)) return true;
  }
  return false;
}

function validateGeneratedAt(value: unknown, errors: string[]): void {
  if (!isNonEmptyString(value)) {
    errors.push("generatedAt must be a non-empty ISO timestamp string.");
    return;
  }
  if (Number.isNaN(Date.parse(value))) {
    errors.push("generatedAt must be parseable as an ISO timestamp.");
  }
}

function validatePosition(
  value: unknown,
  index: number,
  errors: string[],
): DefiGuardianSnapshotPositionV1 | null {
  if (!isRecord(value)) {
    errors.push(`positions[${index}] must be an object.`);
    return null;
  }

  const prefix = `positions[${index}]`;
  const protocol = value.protocol;
  const tokenId = value.tokenId;
  const chain = value.chain;
  const pair = value.pair;
  const inRange = value.inRange;
  const rangeStatus = value.rangeStatus;
  const positionValueUsd = value.positionValueUsd;
  const estimatedCollectibleLpFeesUsd = value.estimatedCollectibleLpFeesUsd;
  const impermanentLossEstimatePct = value.impermanentLossEstimatePct;
  const rangeRiskLevel = value.rangeRiskLevel;
  const recommendedAction = value.recommendedAction;
  const walletAlias = value.walletAlias;
  const healthFlags = value.healthFlags;

  if (!isNonEmptyString(protocol)) errors.push(`${prefix}.protocol is required.`);
  if (!isNonEmptyString(tokenId)) errors.push(`${prefix}.tokenId is required.`);
  if (chain !== "bsc") errors.push(`${prefix}.chain must be "bsc".`);
  if (!isNonEmptyString(pair)) errors.push(`${prefix}.pair is required.`);
  if (typeof inRange !== "boolean") {
    errors.push(`${prefix}.inRange must be boolean.`);
  }
  if (typeof rangeStatus !== "string" || !RANGE_STATUSES.has(rangeStatus)) {
    errors.push(`${prefix}.rangeStatus is unsupported.`);
  }
  if (!isFiniteNumber(positionValueUsd) || positionValueUsd < 0) {
    errors.push(`${prefix}.positionValueUsd must be a non-negative number.`);
  }
  if (
    !isFiniteNumber(estimatedCollectibleLpFeesUsd) ||
    estimatedCollectibleLpFeesUsd < 0
  ) {
    errors.push(
      `${prefix}.estimatedCollectibleLpFeesUsd must be a non-negative number.`,
    );
  }
  if (
    impermanentLossEstimatePct !== undefined &&
    impermanentLossEstimatePct !== null &&
    !isFiniteNumber(impermanentLossEstimatePct)
  ) {
    errors.push(`${prefix}.impermanentLossEstimatePct must be a number or null.`);
  }
  if (
    rangeRiskLevel !== undefined &&
    (typeof rangeRiskLevel !== "string" || !RANGE_RISK_LEVELS.has(rangeRiskLevel))
  ) {
    errors.push(`${prefix}.rangeRiskLevel is unsupported.`);
  }
  if (recommendedAction !== undefined && typeof recommendedAction !== "string") {
    errors.push(`${prefix}.recommendedAction must be a string when present.`);
  }
  if (walletAlias !== undefined && typeof walletAlias !== "string") {
    errors.push(`${prefix}.walletAlias must be a string when present.`);
  }
  if (
    healthFlags !== undefined &&
    (!Array.isArray(healthFlags) ||
      !healthFlags.every((entry) => typeof entry === "string"))
  ) {
    errors.push(`${prefix}.healthFlags must be an array of strings when present.`);
  }

  if (
    !isNonEmptyString(protocol) ||
    !isNonEmptyString(tokenId) ||
    chain !== "bsc" ||
    !isNonEmptyString(pair) ||
    typeof inRange !== "boolean" ||
    typeof rangeStatus !== "string" ||
    !RANGE_STATUSES.has(rangeStatus) ||
    !isFiniteNumber(positionValueUsd) ||
    positionValueUsd < 0 ||
    !isFiniteNumber(estimatedCollectibleLpFeesUsd) ||
    estimatedCollectibleLpFeesUsd < 0
  ) {
    return null;
  }

  return {
    protocol,
    tokenId,
    chain,
    pair,
    ...(typeof walletAlias === "string" ? { walletAlias } : {}),
    inRange,
    rangeStatus: rangeStatus as DefiGuardianSnapshotPositionV1["rangeStatus"],
    positionValueUsd,
    estimatedCollectibleLpFeesUsd,
    ...(impermanentLossEstimatePct === undefined
      ? {}
      : { impermanentLossEstimatePct: impermanentLossEstimatePct as number | null }),
    ...(typeof rangeRiskLevel === "string"
      ? {
          rangeRiskLevel:
            rangeRiskLevel as DefiGuardianSnapshotPositionV1["rangeRiskLevel"],
        }
      : {}),
    ...(typeof recommendedAction === "string" ? { recommendedAction } : {}),
    ...(Array.isArray(healthFlags) ? { healthFlags: healthFlags as string[] } : {}),
  };
}

export function validateDefiGuardianSnapshotV1(
  value: unknown,
): SnapshotValidationResult {
  const errors: string[] = [];
  const secretsDetected = detectSecretMarkers(value);

  if (!isRecord(value)) {
    return {
      ok: false,
      errors: ["Snapshot payload must be a JSON object."],
      secretsDetected,
    };
  }

  if (value.snapshotVersion !== DEFI_GUARDIAN_SNAPSHOT_V1) {
    errors.push("snapshotVersion is missing or unsupported.");
  }
  validateGeneratedAt(value.generatedAt, errors);
  if (value.source !== DEFI_GUARDIAN_SNAPSHOT_SOURCE) {
    errors.push("source is missing or unsupported.");
  }
  if (value.chainId !== 56) {
    errors.push("chainId must be 56.");
  }
  if (!Array.isArray(value.positions)) {
    errors.push("positions must be an array.");
  }

  const positions: DefiGuardianSnapshotPositionV1[] = [];
  if (Array.isArray(value.positions)) {
    value.positions.forEach((position, index) => {
      const parsed = validatePosition(position, index, errors);
      if (parsed !== null) positions.push(parsed);
    });
  }

  if (secretsDetected) {
    errors.push("Snapshot contains keys or values that look secret-bearing.");
  }

  if (errors.length > 0) {
    return { ok: false, errors, secretsDetected };
  }

  return {
    ok: true,
    snapshot: {
      snapshotVersion: DEFI_GUARDIAN_SNAPSHOT_V1,
      generatedAt: value.generatedAt as string,
      source: DEFI_GUARDIAN_SNAPSHOT_SOURCE,
      chainId: 56,
      positions,
    },
    tokenIds: positions.map((position) => position.tokenId),
  };
}

export function parseDefiGuardianSnapshotV1Json(
  raw: string,
): SnapshotValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      errors: ["Snapshot file is not valid JSON."],
      secretsDetected: detectSecretMarkers(raw),
    };
  }
  return validateDefiGuardianSnapshotV1(parsed);
}
