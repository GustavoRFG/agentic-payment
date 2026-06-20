/**
 * target-reliability-enrichment - optional, advisory indexer metrics.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TargetCandidate } from "./target-candidates";
import type { TargetReliabilityMetric } from "./target-selection";

export const TRUSTFORGE_TARGET_ENRICH_RELIABILITY_ENV =
  "TRUSTFORGE_TARGET_ENRICH_RELIABILITY" as const;
export const TRUSTFORGE_TARGET_INDEXER_URL_ENV =
  "TRUSTFORGE_TARGET_INDEXER_URL" as const;

export interface ReliabilityEnrichmentOptions {
  readonly enabled?: boolean;
  readonly indexerUrl?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly cachePath?: string | null;
}

export interface ReliabilityEnrichmentResult {
  readonly enabled: boolean;
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly cacheHit: boolean;
  readonly source: "disabled" | "live_indexer" | "cache" | "none";
  readonly metrics: readonly TargetReliabilityMetric[];
  readonly logLines: readonly string[];
}

function enabledFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env[TRUSTFORGE_TARGET_ENRICH_RELIABILITY_ENV]?.trim() === "true";
}

function indexerUrlFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  return env[TRUSTFORGE_TARGET_INDEXER_URL_ENV]?.trim() || null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function scoreFrom(record: Record<string, unknown>): number {
  const explicit = num(record.reliabilityScore ?? record.reliability_score);
  if (explicit !== null) return explicit;
  const totalCalls = num(record.totalCalls ?? record.total_calls) ?? 0;
  const uniquePayers = num(record.uniquePayers ?? record.unique_payers) ?? 0;
  const successSignals = num(record.successSignals ?? record.success_signals) ?? 0;
  return totalCalls + uniquePayers * 2 + successSignals * 3;
}

function normalizeMetrics(value: unknown): TargetReliabilityMetric[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? ((value as { resources?: unknown[]; items?: unknown[]; metrics?: unknown[] }).resources ??
        (value as { items?: unknown[] }).items ??
        (value as { metrics?: unknown[] }).metrics ??
        [])
      : [];
  const out: TargetReliabilityMetric[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const resourceUrl = record.resourceUrl ?? record.resource_url ?? record.url;
    if (typeof resourceUrl !== "string" || !resourceUrl) continue;
    out.push({
      resourceUrl,
      reliabilityScore: scoreFrom(record),
      totalCalls: num(record.totalCalls ?? record.total_calls),
      uniquePayers: num(record.uniquePayers ?? record.unique_payers),
      successSignals: num(record.successSignals ?? record.success_signals),
    });
  }
  return out;
}

async function readCache(path: string | null | undefined): Promise<TargetReliabilityMetric[]> {
  if (!path || !existsSync(path)) return [];
  try {
    return normalizeMetrics(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return [];
  }
}

async function writeCache(
  path: string | null | undefined,
  metrics: readonly TargetReliabilityMetric[],
): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ metrics }, null, 2)}\n`, "utf8");
}

function buildIndexerUrl(indexerUrl: string, candidates: readonly TargetCandidate[]): string {
  const url = new URL(indexerUrl);
  url.searchParams.set("resources", candidates.map((c) => c.resourceUrl).join(","));
  return url.toString();
}

export async function enrichTargetReliability(
  candidates: readonly TargetCandidate[],
  options: ReliabilityEnrichmentOptions = {},
): Promise<ReliabilityEnrichmentResult> {
  const enabled = options.enabled ?? enabledFromEnv();
  const indexerUrl = options.indexerUrl ?? indexerUrlFromEnv();
  const logLines: string[] = [];

  if (!enabled) {
    return {
      enabled: false,
      skipped: true,
      skipReason: "disabled",
      cacheHit: false,
      source: "disabled",
      metrics: [],
      logLines: ["reliability enrichment disabled"],
    };
  }

  if (!indexerUrl) {
    return {
      enabled: true,
      skipped: true,
      skipReason: "indexer_url_missing",
      cacheHit: false,
      source: "none",
      metrics: [],
      logLines: ["reliability enrichment skipped: indexer URL missing"],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(buildIndexerUrl(indexerUrl, candidates), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`indexer HTTP ${response.status}`);
    }
    const metrics = normalizeMetrics(await response.json());
    await writeCache(options.cachePath, metrics);
    return {
      enabled: true,
      skipped: false,
      skipReason: null,
      cacheHit: false,
      source: "live_indexer",
      metrics,
      logLines: [`reliability enrichment loaded ${metrics.length} live metrics`],
    };
  } catch (error) {
    const cached = await readCache(options.cachePath);
    const message = error instanceof Error ? error.message : String(error);
    if (cached.length > 0) {
      logLines.push(`reliability enrichment live fetch skipped: ${message}`);
      logLines.push(`reliability enrichment using ${cached.length} cached metrics`);
      return {
        enabled: true,
        skipped: true,
        skipReason: `live_indexer_failed:${message}`,
        cacheHit: true,
        source: "cache",
        metrics: cached,
        logLines,
      };
    }
    return {
      enabled: true,
      skipped: true,
      skipReason: `live_indexer_failed:${message}`,
      cacheHit: false,
      source: "none",
      metrics: [],
      logLines: [`reliability enrichment skipped: ${message}`],
    };
  }
}
