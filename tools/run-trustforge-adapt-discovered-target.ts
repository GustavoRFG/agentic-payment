/**
 * run-trustforge-adapt-discovered-target — map target_selection.json primary to selected_candidate.json.
 *
 * After a live_402_ok handshake selection, runs a keyless settle-method probe (POST/GET,
 * no payment header), then a second 402 for quote stability. Method rejection,
 * quote extraction, instability, and non-positive quotes use distinct fail-closed
 * codes. Falls through to the next fallback. Executor untouched.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  adaptDiscoveredTargetWithPaidMethodProbe,
  type DiscoveredTargetSelectionInput,
} from "./trustforge/discovered-target-to-selected-candidate";

async function main(): Promise<number> {
  const inputArg = process.argv.indexOf("--target-selection");
  const outputArg = process.argv.indexOf("--output");
  const resourceUrlArg = process.argv.indexOf("--resource-url");
  const thin = process.argv.includes("--thin");
  const pinWithFallback = process.argv.includes("--pin-with-fallback");
  if (inputArg < 0 || outputArg < 0) {
    console.error(
      "Usage: tsx tools/run-trustforge-adapt-discovered-target.ts --target-selection <path> --output <path> [--thin] [--resource-url <url>] [--pin-with-fallback]",
    );
    return 1;
  }

  const inputPath = process.argv[inputArg + 1];
  const outputPath = process.argv[outputArg + 1];
  const resourceUrlValue = resourceUrlArg >= 0 ? process.argv[resourceUrlArg + 1]?.trim() : undefined;
  const resourceUrl = resourceUrlValue && !resourceUrlValue.startsWith("--") ? resourceUrlValue : undefined;
  if (resourceUrlArg >= 0 && !resourceUrl) {
    console.error("ADAPT_REJECTED: --resource-url requires a value");
    return 1;
  }
  const parsed = JSON.parse(await readFile(inputPath, "utf8")) as DiscoveredTargetSelectionInput;
  const adapted = await adaptDiscoveredTargetWithPaidMethodProbe(parsed, {
    thin,
    resourceUrl,
    pinWithFallback,
  });
  if (!adapted.ok) {
    console.error(`ADAPT_REJECTED: ${adapted.reason}`);
    for (const rejected of adapted.rejectedCandidates) {
      console.error(`  rejected: ${rejected.resourceUrl} — ${rejected.reason}`);
    }
    return 1;
  }

  await writeFile(outputPath, `${JSON.stringify(adapted.candidate, null, 2)}\n`, "utf8");
  console.log(`selected_candidate: ${outputPath}`);
  console.log(`provider: ${adapted.candidate.provider}`);
  console.log(`endpoint: ${adapted.candidate.endpoint}`);
  if (resourceUrl) console.log(`resource_url_selector: ${resourceUrl}`);
  if (adapted.paidMethodProbe) {
    console.log(
      `paid_method_probe: HTTP ${adapted.paidMethodProbe.httpStatus ?? "null"} ${adapted.paidMethodProbe.method}`,
    );
  }
  if (adapted.quoteStability) {
    const q = adapted.quoteStability.evidence;
    console.log(
      `quote_stability: first=${q.first_max_amount_required_atomic ?? "null"} second=${q.second_max_amount_required_atomic ?? "null"}`,
    );
  }
  for (const rejected of adapted.rejectedCandidates) {
    console.log(`fallback_skip: ${rejected.resourceUrl} — ${rejected.reason}`);
  }
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
