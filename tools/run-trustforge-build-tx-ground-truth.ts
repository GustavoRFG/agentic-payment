/**
 * npm run trustforge:tx:ground-truth -- --tx <hash> --chain base --out <path>
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildTxGroundTruth } from "./trustforge/build-tx-ground-truth";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<number> {
  const tx = arg("--tx");
  const chain = (arg("--chain") ?? "base") as "base" | "ethereum";
  const out = arg("--out");
  if (!tx) throw new Error("missing --tx");
  const groundTruth = await buildTxGroundTruth({ txHash: tx, chain });
  const json = `${JSON.stringify(groundTruth, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json, "utf8");
    console.log(`written: ${out}`);
  } else {
    console.log(json);
  }
  return 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
