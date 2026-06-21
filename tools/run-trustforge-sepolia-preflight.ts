/**
 * run-trustforge-sepolia-preflight — read-only Sepolia infra verification.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSepoliaSettlementPreflight } from "./trustforge/sepolia-settlement-preflight";
import { readJsonFile } from "./trustforge/bom-safe-json";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";

const WORKSPACE = "D:\\trustforge";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

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

async function main(): Promise<number> {
  const runArg = process.argv.findIndex((arg) => arg === "--run-dir");
  const runDir =
    runArg >= 0 && process.argv[runArg + 1]
      ? process.argv[runArg + 1].replace(/\\/g, "/")
      : join(WORKSPACE, "artifacts", "runs", "sepolia-settlement-proof", `run_${timestampDir()}`);
  await mkdir(runDir, { recursive: true });

  const sellerArg = process.argv.indexOf("--seller-base-url");
  const sellerBaseUrl = sellerArg >= 0 ? process.argv[sellerArg + 1] : undefined;

  let requiredUsdc: string | undefined;
  const selectedPath = join(runDir, "selected_candidate.json");
  if (existsSync(selectedPath)) {
    const selected = await readJsonFile<DiscoveredSelectedCandidate>(selectedPath);
    requiredUsdc = selected.quote_amount_usdc;
  }

  const result = await runSepoliaSettlementPreflight({ sellerBaseUrl, requiredUsdc });
  await writeFile(
    join(runDir, "00_sepolia_preflight.json"),
    `${JSON.stringify(result, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
    "utf8",
  );

  const lines = [
    "RESULT",
    `sepolia_preflight_status: ${result.ok ? "PASS" : result.blocker ?? "FAIL"}`,
    `run_dir: ${runDir}`,
    `rpc_chain_id: ${result.rpc.chainId ?? "null"}`,
    `rpc_latest_block: ${result.rpc.latestBlock?.toString() ?? "null"}`,
    `wallet_eth: ${result.balances?.ethBalance ?? "null"}`,
    `wallet_usdc: ${result.balances?.usdcBalance ?? "null"}`,
    `seller_handshake: ${result.seller?.outcome.status ?? "null"}`,
    `seller_pay_to: ${result.seller?.accept?.payTo ?? "null"}`,
    "BUYER_PRIVATE_KEY_checked: absent",
    "strict_no_mainnet: yes",
    `detail: ${result.detail}`,
    "NEXT",
    result.ok
      ? "Run trustforge:sepolia:bootstrap to synthesize target_selection and authorization DRAFT."
      : "Resolve blocker and re-run preflight.",
  ];
  await writeFile(join(runDir, "RESULT.txt"), `${lines.join("\n")}\n`, "utf8");
  console.log(lines.join("\n"));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
