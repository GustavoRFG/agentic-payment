/**
 * run-trustforge-x402-paid-settlement — HUMAN executes single thin x402 settlement (Sepolia or mainnet).
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readJsonFile } from "./trustforge/bom-safe-json";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { runX402PaidSettlement } from "./trustforge/x402-paid-settlement-runner";
import {
  assertProfileEnvBeforeSettlement,
  resolveX402SettlementProfileFromCli,
} from "./trustforge/x402-settlement-profile";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<number> {
  const runArg = process.argv.indexOf("--run-dir");
  if (runArg < 0) {
    console.error(
      "Usage: tsx tools/run-trustforge-x402-paid-settlement.ts --run-dir <path> [--network mainnet|sepolia]",
    );
    return 1;
  }
  const runDir = process.argv[runArg + 1];
  const selected = await readJsonFile<DiscoveredSelectedCandidate>(
    join(runDir, "selected_candidate.json"),
  );
  const profile = resolveX402SettlementProfileFromCli(readArg("--network"), selected.network);
  assertProfileEnvBeforeSettlement(profile);

  const { exitCode, lines } = await runX402PaidSettlement({ runDir, profile });
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
