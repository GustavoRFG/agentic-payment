/**
 * run-trustforge-sepolia-settlement-probe — delegates to network-parameterized thin runner.
 */

import { pathToFileURL } from "node:url";
import { SEPOLIA_X402_SETTLEMENT_PROFILE } from "./trustforge/x402-settlement-profile";
import { assertMainnetBuyerKeyAbsent } from "./trustforge/sepolia-settlement-guards";
import { runX402PaidSettlement } from "./trustforge/x402-paid-settlement-runner";

async function main(): Promise<number> {
  assertMainnetBuyerKeyAbsent();
  const runArg = process.argv.indexOf("--run-dir");
  if (runArg < 0) {
    console.error("Usage: tsx tools/run-trustforge-sepolia-settlement-probe.ts --run-dir <path>");
    return 1;
  }
  const runDir = process.argv[runArg + 1];
  const { exitCode, lines } = await runX402PaidSettlement({
    runDir,
    profile: SEPOLIA_X402_SETTLEMENT_PROFILE,
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
