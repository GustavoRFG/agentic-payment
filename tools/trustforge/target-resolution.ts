/**
 * target-resolution - dry-run Bazaar discovery -> liveness -> ranking stage.
 */

import { writeFile } from "node:fs/promises";
import { BazaarClient, type BazaarDiscoveryResult, type BazaarResource } from "./bazaar-client";
import {
  filterTargetCandidates,
  resolveMaxTargetPriceAtomic,
  type RejectedTargetCandidate,
  type TargetCandidate,
} from "./target-candidates";
import {
  probeTargetLiveness,
  type TargetHandshakeOutcome,
} from "./target-liveness";
import {
  enrichTargetReliability,
  type ReliabilityEnrichmentResult,
} from "./target-reliability-enrichment";
import {
  selectTargets,
  type TargetReliabilityMetric,
  type TargetSelectionReport,
} from "./target-selection";

const TARGET_RESOLUTION_PAYMENT_FLAGS = [
  "BUYER_PRIVATE_KEY",
  "TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER",
  "TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID",
  "TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED",
] as const;

export interface TargetResolutionSafety {
  readonly strictNoPayment: true;
  readonly walletLoaded: false;
  readonly paymentHeaderSent: false;
  readonly settlementAttempted: false;
  readonly paymentBearingHttpRequestCount: 0;
  readonly armedPaymentEnvFlags: readonly string[];
}

export interface TargetResolutionReport {
  readonly schema_version: "trustforge_target_resolution.v1";
  readonly stage: "TARGET RESOLUTION";
  readonly mode: "dry_run_no_payment";
  readonly discovery: {
    readonly facilitatorUrl: string;
    readonly ok: boolean;
    readonly rawCount: number;
    readonly resourcesDiscovered: number;
    readonly error: string | null;
  };
  readonly filter: {
    readonly maxTargetPriceAtomic: string;
    readonly acceptedCount: number;
    readonly rejected: readonly RejectedTargetCandidate[];
  };
  readonly reliability: {
    readonly enabled: boolean;
    readonly skipped: boolean;
    readonly skipReason: string | null;
    readonly cacheHit: boolean;
    readonly source: ReliabilityEnrichmentResult["source"];
    readonly logLines: readonly string[];
  };
  readonly candidates: readonly {
    readonly candidateId: string;
    readonly resourceUrl: string;
    readonly method: TargetCandidate["method"];
    readonly freshnessSortKey: string;
  }[];
  readonly handshakeOutcomes: readonly TargetHandshakeOutcome[];
  readonly selection: TargetSelectionReport;
  readonly chosenTarget: TargetSelectionReport["primary"];
  readonly orderedFallbacks: TargetSelectionReport["fallbacks"];
  readonly safety: TargetResolutionSafety;
}

export interface TargetResolutionOptions {
  readonly bazaarClient?: Pick<BazaarClient, "listHttpResources">;
  readonly bazaarResources?: readonly BazaarResource[];
  readonly probeTarget?: (candidate: TargetCandidate) => Promise<TargetHandshakeOutcome>;
  readonly fetchImpl?: typeof fetch;
  readonly maxTargetPriceAtomic?: string;
  readonly enrichReliability?: boolean;
  readonly indexerUrl?: string | null;
  readonly reliabilityCachePath?: string | null;
  readonly reliabilityMetrics?: readonly TargetReliabilityMetric[];
  readonly env?: Record<string, string | undefined>;
  readonly outputPath?: string | null;
}

function paymentFlags(env: Record<string, string | undefined>): string[] {
  return TARGET_RESOLUTION_PAYMENT_FLAGS.filter((key) => Boolean(env[key]?.trim()));
}

export function checkTargetResolutionNoPaymentEnv(
  env: Record<string, string | undefined> = process.env,
): TargetResolutionSafety {
  const armedPaymentEnvFlags = paymentFlags(env);
  return {
    strictNoPayment: true,
    walletLoaded: false,
    paymentHeaderSent: false,
    settlementAttempted: false,
    paymentBearingHttpRequestCount: 0,
    armedPaymentEnvFlags,
  };
}

function blockedIfUnsafe(safety: TargetResolutionSafety): void {
  if (safety.armedPaymentEnvFlags.length === 0) return;
  throw new Error(
    `BLOCKED_TARGET_RESOLUTION_PAYMENT_ENV: ${safety.armedPaymentEnvFlags.join(",")}`,
  );
}

async function resolveDiscovery(
  options: TargetResolutionOptions,
): Promise<BazaarDiscoveryResult> {
  if (options.bazaarResources) {
    return {
      ok: true,
      facilitatorUrl: "injected",
      resources: options.bazaarResources,
      rawCount: options.bazaarResources.length,
    };
  }
  const client = options.bazaarClient ?? new BazaarClient();
  return client.listHttpResources();
}

function reliabilitySummary(result: ReliabilityEnrichmentResult): TargetResolutionReport["reliability"] {
  return {
    enabled: result.enabled,
    skipped: result.skipped,
    skipReason: result.skipReason,
    cacheHit: result.cacheHit,
    source: result.source,
    logLines: result.logLines,
  };
}

export function stableStringifyTargetResolution(report: TargetResolutionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function runTargetResolution(
  options: TargetResolutionOptions = {},
): Promise<TargetResolutionReport> {
  const env = options.env ?? process.env;
  const safety = checkTargetResolutionNoPaymentEnv(env);
  blockedIfUnsafe(safety);

  const maxTargetPriceAtomic =
    options.maxTargetPriceAtomic ?? resolveMaxTargetPriceAtomic(env);
  const discovery = await resolveDiscovery(options);
  const filter = filterTargetCandidates(discovery.resources, { maxTargetPriceAtomic });

  const probe =
    options.probeTarget ??
    ((candidate: TargetCandidate) =>
      probeTargetLiveness(candidate, {
        fetchImpl: options.fetchImpl,
        maxTargetPriceAtomic,
      }));

  const handshakeOutcomes: TargetHandshakeOutcome[] = [];
  for (const candidate of filter.accepted) {
    handshakeOutcomes.push(await probe(candidate));
  }

  const reliability = options.reliabilityMetrics
    ? {
        enabled: Boolean(options.enrichReliability),
        skipped: false,
        skipReason: null,
        cacheHit: false,
        source: "live_indexer" as const,
        metrics: options.reliabilityMetrics,
        logLines: ["reliability metrics injected"],
      }
    : await enrichTargetReliability(filter.accepted, {
        enabled: options.enrichReliability ?? false,
        indexerUrl: options.indexerUrl,
        fetchImpl: options.fetchImpl,
        cachePath: options.reliabilityCachePath,
      });

  const selection = selectTargets({
    candidates: filter.accepted,
    outcomes: handshakeOutcomes,
    reliabilityMetrics: reliability.metrics,
  });

  const report: TargetResolutionReport = {
    schema_version: "trustforge_target_resolution.v1",
    stage: "TARGET RESOLUTION",
    mode: "dry_run_no_payment",
    discovery: {
      facilitatorUrl: discovery.facilitatorUrl,
      ok: discovery.ok,
      rawCount: discovery.rawCount,
      resourcesDiscovered: discovery.resources.length,
      error: discovery.ok ? null : discovery.error,
    },
    filter: {
      maxTargetPriceAtomic,
      acceptedCount: filter.accepted.length,
      rejected: filter.rejected,
    },
    reliability: reliabilitySummary(reliability),
    candidates: filter.accepted.map((candidate) => ({
      candidateId: candidate.candidateId,
      resourceUrl: candidate.resourceUrl,
      method: candidate.method,
      freshnessSortKey: candidate.freshness.sortKey,
    })),
    handshakeOutcomes,
    selection,
    chosenTarget: selection.primary,
    orderedFallbacks: selection.fallbacks,
    safety,
  };

  if (options.outputPath) {
    await writeFile(options.outputPath, stableStringifyTargetResolution(report), "utf8");
  }

  return report;
}
