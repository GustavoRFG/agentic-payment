/**
 * run-trustforge-sepolia-settlement-probe — HUMAN executes single Base Sepolia settlement.
 *
 * Requires SEPOLIA_BUYER_PRIVATE_KEY. BUYER_PRIVATE_KEY (mainnet) must be absent.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { executeSepoliaSingleSettlement } from "./trustforge/sepolia-settlement-executor";
import { assertMainnetBuyerKeyAbsent } from "./trustforge/sepolia-settlement-guards";
import type { HumanPaymentAuthorization } from "./trustforge/validate-human-payment-authorization";
import {
  hashAuthorizationContent,
  parseJsonText,
  readJsonFile,
} from "./trustforge/bom-safe-json";

const WORKSPACE = "D:\\trustforge";

async function main(): Promise<number> {
  assertMainnetBuyerKeyAbsent();
  const runArg = process.argv.indexOf("--run-dir");
  if (runArg < 0) {
    console.error("Usage: tsx tools/run-trustforge-sepolia-settlement-probe.ts --run-dir <path>");
    return 1;
  }
  const runDir = process.argv[runArg + 1];
  const authPath = join(runDir, "human_payment_authorization.json");
  const selectedPath = join(runDir, "selected_candidate.json");
  if (!existsSync(authPath)) {
    console.error("WAITING_FOR_HUMAN_PAYMENT_DECISION: human_payment_authorization.json missing");
    return 1;
  }

  const authRaw = await readFile(authPath, "utf8");
  const authorizationHash = hashAuthorizationContent(authRaw);
  const auth = parseJsonText<HumanPaymentAuthorization>(authRaw);
  const selected = await readJsonFile<DiscoveredSelectedCandidate>(selectedPath);
  await mkdir(join(runDir, "settlement_probe"), { recursive: true });

  const balancesPath = join(runDir, "00_sepolia_preflight.json");
  let balanceBeforeUsdc: string | undefined;
  if (existsSync(balancesPath)) {
    const preflight = await readJsonFile<{
      balances?: { usdcBalance?: string };
    }>(balancesPath);
    balanceBeforeUsdc = preflight.balances?.usdcBalance;
  }

  const result = await executeSepoliaSingleSettlement({
    runDir,
    auth,
    selected,
    authorizationHash,
  });

  const record = {
    ...result,
    balanceBeforeUsdc,
    authorizationHash,
    executed_at_utc: new Date().toISOString(),
  };
  await writeFile(
    join(runDir, "settlement_probe", "01_execution.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );

  const lines = [
    "RESULT",
    `sepolia_settlement_execution_status: ${result.ok ? "HTTP_OK" : result.status}`,
    `run_dir: ${runDir}`,
    `network: ${result.network}`,
    `buyer_address: ${result.buyerAddress}`,
    `payment_attempted: ${result.paymentAttempted ? "yes" : "no"}`,
    `payment_bearing_http_request_count: ${result.paymentBearingHttpRequestCount}`,
    `http_status: ${result.httpStatus ?? "null"}`,
    `authorization_hash: ${authorizationHash}`,
    "BUYER_PRIVATE_KEY: absent",
    "SEPOLIA_BUYER_PRIVATE_KEY: loaded_by_human_only",
    "single_shot: yes",
    "NEXT",
    "Run: npm run trustforge:sepolia:classify -- --run-dir <path>",
  ];
  await writeFile(join(runDir, "settlement_probe", "RESULT.txt"), `${lines.join("\n")}\n`, "utf8");
  console.log(lines.join("\n"));
  return result.ok && result.paymentAttempted ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
