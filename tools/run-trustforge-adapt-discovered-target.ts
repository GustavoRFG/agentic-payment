/**
 * run-trustforge-adapt-discovered-target — map target_selection.json primary to selected_candidate.json.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  adaptDiscoveredPrimaryToSelectedCandidate,
  adaptDiscoveredPrimaryToThinSettlementCandidate,
  type DiscoveredTargetSelectionInput,
} from "./trustforge/discovered-target-to-selected-candidate";

async function main(): Promise<number> {
  const inputArg = process.argv.indexOf("--target-selection");
  const outputArg = process.argv.indexOf("--output");
  const thin = process.argv.includes("--thin");
  if (inputArg < 0 || outputArg < 0) {
    console.error(
      "Usage: tsx tools/run-trustforge-adapt-discovered-target.ts --target-selection <path> --output <path> [--thin]",
    );
    return 1;
  }

  const inputPath = process.argv[inputArg + 1];
  const outputPath = process.argv[outputArg + 1];
  const parsed = JSON.parse(await readFile(inputPath, "utf8")) as DiscoveredTargetSelectionInput;
  const adapted = thin
    ? adaptDiscoveredPrimaryToThinSettlementCandidate(parsed)
    : adaptDiscoveredPrimaryToSelectedCandidate(parsed);
  if (!adapted.ok) {
    console.error(`ADAPT_REJECTED: ${adapted.reason}`);
    return 1;
  }

  await writeFile(outputPath, `${JSON.stringify(adapted.candidate, null, 2)}\n`, "utf8");
  console.log(`selected_candidate: ${outputPath}`);
  console.log(`provider: ${adapted.candidate.provider}`);
  console.log(`endpoint: ${adapted.candidate.endpoint}`);
  console.log(`quote_amount_usdc: ${adapted.candidate.quote_amount_usdc}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { join, dirname, fileURLToPath };
