/**
 * run-trustforge-targets-discover - payment-free Bazaar target discovery CLI.
 */

import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BazaarClient } from "./trustforge/bazaar-client";
import {
  runTargetResolution,
  type TargetResolutionOptions,
  type TargetResolutionReport,
} from "./trustforge/target-resolution";

const WORKSPACE = "D:\\trustforge";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface ParsedTargetsDiscoverArgs {
  readonly runDir?: string;
  readonly outputPath?: string;
  readonly maxTargetPriceAtomic?: string;
  readonly facilitatorUrl?: string;
  readonly withIndexer: boolean;
  readonly indexerUrl?: string;
  readonly reliabilityCachePath?: string;
  readonly help: boolean;
}

export interface TrustForgeTargetsDiscoverResult {
  readonly status: "TARGET_RESOLUTION_READY" | "TARGET_RESOLUTION_NO_LIVE_TARGET";
  readonly runDir: string;
  readonly outputPath: string;
  readonly report: TargetResolutionReport;
  readonly resultLines: readonly string[];
}

export interface TrustForgeTargetsDiscoverOptions extends TargetResolutionOptions {
  readonly argv?: readonly string[];
  readonly now?: Date;
  readonly log?: (line: string) => void;
  readonly runDir?: string;
  readonly outputPath?: string;
}

function timestampDir(date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "_",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function gitHash(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function gitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function usage(): string {
  return [
    "Usage: npm run trustforge:targets:discover -- [options]",
    "",
    "Options:",
    "  --run-dir <path>                  Artifact run directory",
    "  --output <path>                   target_selection.json path",
    "  --max-target-price-atomic <int>   Max atomic USDC quote, default 10000",
    "  --facilitator-url <url>           Bazaar facilitator URL",
    "  --with-indexer                    Enable optional reliability enrichment",
    "  --indexer-url <url>               Reliability indexer URL",
    "  --reliability-cache <path>        Optional reliability cache JSON",
    "  --help                            Show this help",
  ].join("\n");
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseTargetsDiscoverArgs(
  argv: readonly string[],
): ParsedTargetsDiscoverArgs {
  let runDir: string | undefined;
  let outputPath: string | undefined;
  let maxTargetPriceAtomic: string | undefined;
  let facilitatorUrl: string | undefined;
  let indexerUrl: string | undefined;
  let reliabilityCachePath: string | undefined;
  let withIndexer = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run-dir") {
      runDir = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--output") {
      outputPath = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--max-target-price-atomic") {
      maxTargetPriceAtomic = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--facilitator-url") {
      facilitatorUrl = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--with-indexer") {
      withIndexer = true;
    } else if (arg === "--indexer-url") {
      indexerUrl = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--reliability-cache") {
      reliabilityCachePath = takeValue(argv, i, arg);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    runDir,
    outputPath,
    maxTargetPriceAtomic,
    facilitatorUrl,
    withIndexer,
    indexerUrl,
    reliabilityCachePath,
    help,
  };
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function defaultRunDir(now: Date): string {
  return join(
    WORKSPACE,
    "artifacts",
    "runs",
    "bazaar-target-discovery",
    `run_${timestampDir(now)}`,
  );
}

function resultLines(input: {
  readonly report: TargetResolutionReport;
  readonly runDir: string;
  readonly outputPath: string;
}): readonly string[] {
  const { report, runDir, outputPath } = input;
  const primary = report.selection.primary;
  const liveCount = report.handshakeOutcomes.filter(
    (outcome) => outcome.status === "live_402_ok",
  ).length;
  const status = primary
    ? "TARGET_RESOLUTION_READY"
    : "TARGET_RESOLUTION_NO_LIVE_TARGET";
  return [
    "RESULT",
    `trustforge_targets_discover_status: ${status}`,
    "strict_no_payment: yes",
    `wallet_loaded: ${report.safety.walletLoaded ? "yes" : "no"}`,
    `payment_header_sent: ${report.safety.paymentHeaderSent ? "yes" : "no"}`,
    `payment_attempted_live: ${report.safety.settlementAttempted ? "yes" : "no"}`,
    `payment_bearing_http_request_count: ${report.safety.paymentBearingHttpRequestCount}`,
    `repo: D:\\agentic-payments-lab`,
    `branch: ${gitBranch()}`,
    `commit: ${gitHash()}`,
    `facilitator_url: ${report.discovery.facilitatorUrl}`,
    `resources_discovered: ${report.discovery.resourcesDiscovered}`,
    `candidates_accepted: ${report.filter.acceptedCount}`,
    `candidates_rejected: ${report.filter.rejected.length}`,
    `handshake_live_402_ok: ${liveCount}`,
    `selected_resource_url: ${primary?.resourceUrl ?? "null"}`,
    `fallback_count: ${report.selection.fallbacks.length}`,
    `target_selection_json: ${outputPath}`,
    `run_dir: ${runDir}`,
  ];
}

export async function runTrustForgeTargetsDiscover(
  options: TrustForgeTargetsDiscoverOptions = {},
): Promise<TrustForgeTargetsDiscoverResult> {
  const argv = options.argv ?? process.argv.slice(2);
  const parsed = parseTargetsDiscoverArgs(argv);
  if (parsed.help) {
    const lines = usage().split("\n");
    options.log?.(lines.join("\n"));
    throw new Error("HELP_REQUESTED");
  }

  const now = options.now ?? new Date();
  const runDir = absolutePath(options.runDir ?? parsed.runDir ?? defaultRunDir(now));
  const outputPath = absolutePath(
    options.outputPath ?? parsed.outputPath ?? join(runDir, "target_selection.json"),
  );
  await mkdir(runDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  const facilitatorUrl = parsed.facilitatorUrl?.trim();
  const bazaarClient =
    options.bazaarClient ??
    (facilitatorUrl ? new BazaarClient({ facilitatorUrl }) : undefined);

  const report = await runTargetResolution({
    bazaarClient,
    bazaarResources: options.bazaarResources,
    probeTarget: options.probeTarget,
    fetchImpl: options.fetchImpl,
    maxTargetPriceAtomic:
      options.maxTargetPriceAtomic ?? parsed.maxTargetPriceAtomic,
    enrichReliability: options.enrichReliability ?? parsed.withIndexer,
    indexerUrl: options.indexerUrl ?? parsed.indexerUrl,
    reliabilityCachePath:
      options.reliabilityCachePath ?? parsed.reliabilityCachePath,
    reliabilityMetrics: options.reliabilityMetrics,
    env: options.env,
    outputPath,
  });

  const lines = resultLines({ report, runDir, outputPath });
  await writeFile(join(runDir, "RESULT.txt"), `${lines.join("\n")}\n`, "utf8");
  options.log?.(lines.join("\n"));

  return {
    status: report.selection.primary
      ? "TARGET_RESOLUTION_READY"
      : "TARGET_RESOLUTION_NO_LIVE_TARGET",
    runDir,
    outputPath,
    report,
    resultLines: lines,
  };
}

async function main(): Promise<number> {
  try {
    await runTrustForgeTargetsDiscover({
      log: (line) => console.log(line),
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "HELP_REQUESTED") return 0;
    console.error(message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
