/**
 * run-trustforge-sepolia-bootstrap — synthesize target_selection, selected_candidate, DRAFT, freshness.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adaptDiscoveredPrimaryToSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { runPaidQuoteFreshnessPreflight } from "./trustforge/paid-quote-freshness-preflight";
import {
  buildSepoliaTargetSelectionFromHandshake,
  probeSepoliaLocalSeller,
} from "./trustforge/sepolia-seller-handshake";
import { assertMainnetBuyerKeyAbsent } from "./trustforge/sepolia-settlement-guards";
import { writeHumanPaymentAuthorizationDraft } from "./run-trustforge-emit-paid-authorization-draft";

const WORKSPACE = "D:\\trustforge";

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
  assertMainnetBuyerKeyAbsent();
  const runArg = process.argv.findIndex((arg) => arg === "--run-dir");
  const runDir =
    runArg >= 0 && process.argv[runArg + 1]
      ? process.argv[runArg + 1].replace(/\\/g, "/")
      : join(WORKSPACE, "artifacts", "runs", "sepolia-settlement-proof", `run_${timestampDir()}`);
  await mkdir(runDir, { recursive: true });

  const sellerArg = process.argv.indexOf("--seller-base-url");
  const sellerBaseUrl = sellerArg >= 0 ? process.argv[sellerArg + 1] : "http://localhost:4021";

  const handshake = await probeSepoliaLocalSeller({ sellerBaseUrl });
  const targetSelection = buildSepoliaTargetSelectionFromHandshake(handshake);
  await writeFile(
    join(runDir, "target_selection.json"),
    `${JSON.stringify(targetSelection, null, 2)}\n`,
    "utf8",
  );

  const adapted = adaptDiscoveredPrimaryToSelectedCandidate(targetSelection);
  if (!adapted.ok) {
    throw new Error(adapted.reason);
  }
  await writeFile(
    join(runDir, "selected_candidate.json"),
    `${JSON.stringify(adapted.candidate, null, 2)}\n`,
    "utf8",
  );

  await writeHumanPaymentAuthorizationDraft({
    candidate: adapted.candidate,
    outputPath: join(runDir, "human_payment_authorization.DRAFT.json"),
  });

  const preflight = await runPaidQuoteFreshnessPreflight({
    authorized: {
      endpoint: adapted.candidate.endpoint,
      quote_amount_usdc: adapted.candidate.quote_amount_usdc,
      quote_atomic: adapted.candidate.quote_atomic,
      authorized_max_usdc: adapted.candidate.recommended_max_usdc,
      pay_to: adapted.candidate.authorized_pay_to,
      network: adapted.candidate.network,
      asset: adapted.candidate.asset,
    },
  });
  await writeFile(
    join(runDir, "00_pay_time_freshness_preflight.json"),
    `${JSON.stringify(preflight, null, 2)}\n`,
    "utf8",
  );

  const lines = [
    "RESULT",
    `sepolia_bootstrap_status: ${preflight.go ? "READY_FOR_HUMAN_AUTH" : "BLOCKED_FRESHNESS"}`,
    `run_dir: ${runDir}`,
    `network: ${adapted.candidate.network}`,
    `endpoint: ${adapted.candidate.endpoint}`,
    `quote_usdc: ${adapted.candidate.quote_amount_usdc}`,
    `pay_to: ${adapted.candidate.authorized_pay_to}`,
    `freshness_go: ${preflight.go ? "yes" : "no"}`,
    "agent_signed: no",
    "NEXT",
    preflight.go
      ? "Human: rename DRAFT → human_payment_authorization.json, authorize, commit, then run trustforge:sepolia:settle"
      : `Fix freshness blockers: ${preflight.reasons.join("; ")}`,
  ];
  await writeFile(join(runDir, "RESULT.txt"), `${lines.join("\n")}\n`, "utf8");
  console.log(lines.join("\n"));
  return preflight.go ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
