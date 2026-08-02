/**
 * target-selection - deterministic target ranking and fallback selection.
 */

import type { TargetCandidate } from "./target-candidates";
import type { TargetHandshakeOutcome } from "./target-liveness";
import type {
  CanonicalJsonValue,
  CanonicalQuery,
  RequestInputProvenance,
} from "./thin-settlement-request-binding";

export interface TargetReliabilityMetric {
  readonly resourceUrl: string;
  readonly reliabilityScore: number;
  readonly totalCalls?: number | null;
  readonly uniquePayers?: number | null;
  readonly successSignals?: number | null;
}

export interface TargetSelectionScore {
  readonly priceAtomic: string;
  readonly freshnessSortKey: string;
  readonly reliabilityScore: number | null;
  readonly tieBreakResourceUrl: string;
}

export interface TargetSelectionEntry {
  readonly rank: number;
  readonly candidateId: string;
  readonly resourceUrl: string;
  readonly method: TargetCandidate["method"];
  readonly requestEndpoint: string;
  readonly requestInputStatus: "known";
  readonly requestQuery: CanonicalQuery;
  readonly requestBody: CanonicalJsonValue | null;
  readonly requestInputProvenance: RequestInputProvenance;
  readonly requestBindingSha256: string;
  readonly handshakeStatus: "live_402_ok";
  readonly quoteAtomic: string;
  readonly quoteUsdc: string;
  readonly selectedPayTo: string | null;
  readonly challengeNoncePresent: boolean;
  readonly challengeExpiryPresent: boolean;
  readonly score: TargetSelectionScore;
  readonly scoringRationale: readonly string[];
}

export interface TargetSelectionReport {
  readonly schema_version: "trustforge_target_selection.v2";
  readonly selection_mode: "dry_run_no_payment";
  readonly primary: TargetSelectionEntry | null;
  readonly fallbacks: readonly TargetSelectionEntry[];
  readonly considered: readonly {
    readonly candidateId: string;
    readonly resourceUrl: string;
    readonly handshakeStatus: TargetHandshakeOutcome["status"];
    readonly selected: boolean;
    readonly exclusionReason: string | null;
  }[];
}

function parseAtomic(value: string): bigint {
  return BigInt(value);
}

function reliabilityFor(
  resourceUrl: string,
  metrics: readonly TargetReliabilityMetric[],
): number | null {
  const metric = metrics.find(
    (entry) => entry.resourceUrl.toLowerCase() === resourceUrl.toLowerCase(),
  );
  return typeof metric?.reliabilityScore === "number" ? metric.reliabilityScore : null;
}

function compareEntries(a: TargetSelectionEntry, b: TargetSelectionEntry): number {
  const priceDiff = parseAtomic(a.score.priceAtomic) - parseAtomic(b.score.priceAtomic);
  if (priceDiff < 0n) return -1;
  if (priceDiff > 0n) return 1;

  const freshness = b.score.freshnessSortKey.localeCompare(a.score.freshnessSortKey);
  if (freshness !== 0) return freshness;

  const relA = a.score.reliabilityScore ?? -1;
  const relB = b.score.reliabilityScore ?? -1;
  if (relB !== relA) return relB - relA;

  const url = a.score.tieBreakResourceUrl.localeCompare(b.score.tieBreakResourceUrl);
  if (url !== 0) return url;
  return a.candidateId.localeCompare(b.candidateId);
}

function entryFromOutcome(
  candidate: TargetCandidate,
  outcome: TargetHandshakeOutcome,
  reliabilityMetrics: readonly TargetReliabilityMetric[],
): TargetSelectionEntry | null {
  if (
    outcome.status !== "live_402_ok" ||
    !outcome.quoteAtomic ||
    !outcome.quoteUsdc ||
    !candidate.requestBinding ||
    !candidate.requestInputProvenance
  ) {
    return null;
  }
  const reliabilityScore = reliabilityFor(candidate.resourceUrl, reliabilityMetrics);
  return {
    rank: 0,
    candidateId: candidate.candidateId,
    resourceUrl: candidate.resourceUrl,
    method: candidate.method,
    requestEndpoint: candidate.requestBinding.endpoint,
    requestInputStatus: candidate.requestBinding.input_status,
    requestQuery: candidate.requestBinding.query,
    requestBody: candidate.requestBinding.body,
    requestInputProvenance: candidate.requestInputProvenance,
    requestBindingSha256: candidate.requestBinding.binding_sha256,
    handshakeStatus: "live_402_ok",
    quoteAtomic: outcome.quoteAtomic,
    quoteUsdc: outcome.quoteUsdc,
    selectedPayTo: outcome.selectedAccept?.payTo ?? null,
    challengeNoncePresent: Boolean(outcome.challenge.nonce),
    challengeExpiryPresent: Boolean(outcome.challenge.expiresAt),
    score: {
      priceAtomic: outcome.quoteAtomic,
      freshnessSortKey: candidate.freshness.sortKey,
      reliabilityScore,
      tieBreakResourceUrl: candidate.resourceUrl,
    },
    scoringRationale: [
      `price_atomic=${outcome.quoteAtomic}`,
      `freshness_sort_key=${candidate.freshness.sortKey || "none"}`,
      reliabilityScore === null
        ? "reliability_enrichment=not_used"
        : `reliability_score=${reliabilityScore}`,
      "tie_break=resource_url_then_candidate_id",
    ],
  };
}

export function selectTargets(input: {
  readonly candidates: readonly TargetCandidate[];
  readonly outcomes: readonly TargetHandshakeOutcome[];
  readonly reliabilityMetrics?: readonly TargetReliabilityMetric[];
}): TargetSelectionReport {
  const byCandidateId = new Map(input.candidates.map((c) => [c.candidateId, c]));
  const reliabilityMetrics = input.reliabilityMetrics ?? [];
  const selected: TargetSelectionEntry[] = [];

  for (const outcome of input.outcomes) {
    const candidate = byCandidateId.get(outcome.candidateId);
    if (!candidate) continue;
    const entry = entryFromOutcome(candidate, outcome, reliabilityMetrics);
    if (entry) selected.push(entry);
  }

  const ranked = selected.sort(compareEntries).map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));
  const selectedIds = new Set(ranked.map((entry) => entry.candidateId));

  return {
    schema_version: "trustforge_target_selection.v2",
    selection_mode: "dry_run_no_payment",
    primary: ranked[0] ?? null,
    fallbacks: ranked.slice(1),
    considered: input.outcomes
      .map((outcome) => ({
        candidateId: outcome.candidateId,
        resourceUrl: outcome.resourceUrl,
        handshakeStatus: outcome.status,
        selected: selectedIds.has(outcome.candidateId),
        exclusionReason:
          outcome.status === "live_402_ok" ? null : `handshake_status=${outcome.status}`,
      }))
      .sort((a, b) => {
        const url = a.resourceUrl.localeCompare(b.resourceUrl);
        if (url !== 0) return url;
        return a.candidateId.localeCompare(b.candidateId);
      }),
  };
}

export function stableStringifyTargetSelection(report: TargetSelectionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
