/**
 * x402-paid-settlement-runner — shared run-dir settlement probe logic (human-executed).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import { executeThinX402Settlement } from "./x402-thin-settlement-executor";
import type { X402SettlementProfile } from "./x402-settlement-profile";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";
import { hashAuthorizationContent, parseJsonText, readJsonFile } from "./bom-safe-json";

export async function runX402PaidSettlement(input: {
  readonly runDir: string;
  readonly profile: X402SettlementProfile;
}): Promise<{ readonly exitCode: number; readonly lines: string[] }> {
  const { runDir, profile } = input;
  const authPath = join(runDir, "human_payment_authorization.json");
  const selectedPath = join(runDir, "selected_candidate.json");
  if (!existsSync(authPath)) {
    throw new Error("WAITING_FOR_HUMAN_PAYMENT_DECISION: human_payment_authorization.json missing");
  }

  const authRaw = await readFile(authPath, "utf8");
  const authorizationHash = hashAuthorizationContent(authRaw);
  const auth = parseJsonText<HumanPaymentAuthorization>(authRaw);
  const selected = await readJsonFile<DiscoveredSelectedCandidate>(selectedPath);
  await mkdir(join(runDir, "settlement_probe"), { recursive: true });

  const preflightNames = [
    join(runDir, "00_sepolia_preflight.json"),
    join(runDir, "00_mainnet_preflight.json"),
    join(runDir, "00_pay_time_freshness_preflight.json"),
  ];
  let balanceBeforeUsdc: string | undefined;
  for (const path of preflightNames) {
    if (!existsSync(path)) continue;
    const preflight = await readJsonFile<{ balances?: { usdcBalance?: string } }>(path);
    balanceBeforeUsdc = preflight.balances?.usdcBalance ?? balanceBeforeUsdc;
  }

  const result = await executeThinX402Settlement({
    profile,
    runDir,
    auth,
    selected,
    authorizationHash,
  });

  const record = {
    ...result,
    balanceBeforeUsdc,
    authorizationHash,
    attemptId: result.attemptId,
    intentPath: result.intentPath,
    facilitatorReceiptPath: result.facilitatorReceiptPath,
    facilitatorReceiptParseStatus: result.facilitatorReceiptParseStatus,
    executed_at_utc: new Date().toISOString(),
    request_completed_at_utc: new Date().toISOString(),
  };
  await writeFile(
    join(runDir, "settlement_probe", "01_execution.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );

  const oppositeKeyLabel =
    profile.id === "sepolia" ? "BUYER_PRIVATE_KEY: absent" : "SEPOLIA_BUYER_PRIVATE_KEY: absent";
  const loadedKeyLabel =
    profile.id === "sepolia"
      ? "SEPOLIA_BUYER_PRIVATE_KEY: loaded_by_human_only"
      : "BUYER_PRIVATE_KEY: loaded_by_human_only";

  const lines = [
    "RESULT",
    `x402_settlement_execution_status: ${result.ok ? "HTTP_OK" : result.status}`,
    `network_profile: ${profile.id}`,
    `run_dir: ${runDir}`,
    `network: ${result.network}`,
    `endpoint: ${selected.endpoint}`,
    `buyer_address: ${result.buyerAddress}`,
    `payment_attempted: ${result.paymentAttempted ? "yes" : "no"}`,
    `payment_bearing_http_request_count: ${result.paymentBearingHttpRequestCount}`,
    `http_status: ${result.httpStatus ?? "null"}`,
    `facilitator_receipt_parse_status: ${result.facilitatorReceiptParseStatus ?? "null"}`,
    `authorization_hash: ${authorizationHash}`,
    oppositeKeyLabel,
    loadedKeyLabel,
    "single_shot: yes",
    "NEXT",
    `Run: node .\\seller-api\\node_modules\\tsx\\dist\\cli.mjs .\\tools\\run-trustforge-x402-classify.ts --run-dir "${runDir}"`,
  ];
  await writeFile(join(runDir, "settlement_probe", "RESULT.txt"), `${lines.join("\n")}\n`, "utf8");
  return { exitCode: 0, lines };
}
