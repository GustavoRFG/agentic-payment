/**
 * run-trustforge-x402-classify — read-only reconcile + three-outcome classify (Sepolia or mainnet).
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonFile } from "./trustforge/bom-safe-json";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { runX402Classify } from "./trustforge/x402-classify-runner";
import { resolveX402SettlementProfileFromCli } from "./trustforge/x402-settlement-profile";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function readArg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

async function main(): Promise<number> {
  const runArg = process.argv.indexOf("--run-dir");
  if (runArg < 0) {
    console.error(
      "Usage: tsx tools/run-trustforge-x402-classify.ts --run-dir <path> [--network mainnet|sepolia] [--reuse-existing-ledger] [--fresh-reconcile] [--rpc-request-timeout-seconds N] [--rpc-max-retries N] [--max-total-runtime-seconds N]",
    );
    return 1;
  }
  const runDir = process.argv[runArg + 1];
  const selected = await readJsonFile<DiscoveredSelectedCandidate>(
    join(runDir, "selected_candidate.json"),
  );
  const profile = resolveX402SettlementProfileFromCli(readArg("--network"), selected.network);

  const { exitCode, lines } = await runX402Classify({
    runDir,
    profile,
    repoRoot: REPO,
    reuseExistingLedger: process.argv.includes("--reuse-existing-ledger"),
    freshReconcile: process.argv.includes("--fresh-reconcile"),
    rpcRequestTimeoutSeconds: Number.parseInt(readArg("--rpc-request-timeout-seconds", "20") ?? "20", 10),
    rpcMaxRetries: Number.parseInt(readArg("--rpc-max-retries", "2") ?? "2", 10),
    maxTotalRuntimeSeconds: Number.parseInt(readArg("--max-total-runtime-seconds", "180") ?? "180", 10),
  });
  console.log(lines.join("\n"));
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
