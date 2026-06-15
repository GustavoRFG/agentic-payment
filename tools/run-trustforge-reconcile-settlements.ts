/**
 * run-trustforge-reconcile-settlements — CLI for read-only USDC settlement reconciliation.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseReconcileCliArgs,
  reconcileUsdcSettlements,
} from "./trustforge/reconcile-usdc-settlements";

async function main(): Promise<number> {
  const args = parseReconcileCliArgs(process.argv.slice(2));
  const fromBlock = args.fromBlock ?? 47_310_000;
  const reconciliation = await reconcileUsdcSettlements({
    wallet: args.wallet,
    fromBlock,
    toBlock: args.toBlock,
  });
  const out =
    args.out ??
    join(
      "D:\\trustforge",
      "artifacts",
      "runs",
      "rich-tx-explainer-phase3b-reconciliation",
      "reconcile_cli_output.json",
    );
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(reconciliation, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({
      settlement_reconciliation_status: reconciliation.settlement_reconciliation_status,
      zapper_candidate_count: reconciliation.zapper_candidate_count,
      reconciled_total_usdc: reconciliation.reconciled_total_usdc,
      out,
    }),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main as reconcileSettlementsMain };
