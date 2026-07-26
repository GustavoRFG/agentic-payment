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
  /** Injection seam for tests; defaults to the real (untouched) thin executor. */
  readonly executeImpl?: typeof executeThinX402Settlement;
}): Promise<{ readonly exitCode: number; readonly lines: string[] }> {
  const { runDir, profile } = input;
  const executeThin = input.executeImpl ?? executeThinX402Settlement;
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

  let result: Awaited<ReturnType<typeof executeThinX402Settlement>>;
  try {
    result = await executeThin({
      profile,
      runDir,
      auth,
      selected,
      authorizationHash,
    });
  } catch (error) {
    // The executor fails closed by throwing structured BLOCKED_* blockers (e.g.
    // BLOCKED_PAY_TIME_FRESHNESS). The runner — not the executor — captures those
    // and emits a structured RESULT, same pattern as classify, instead of letting
    // a raw stack trace escape. Non-BLOCKED errors are genuinely unexpected: re-throw.
    const message = error instanceof Error ? error.message : String(error);
    const match = /^(BLOCKED_[A-Z0-9_]+)\s*:?\s*(.*)$/s.exec(message);
    if (!match) throw error;
    const blocker = match[1]!;
    const detail = match[2]?.trim() || "no detail";
    const lines = [
      "RESULT",
      `x402_settlement_execution_status: ${blocker}`,
      `network_profile: ${profile.id}`,
      `run_dir: ${runDir}`,
      `endpoint: ${selected.endpoint}`,
      "payment_attempted: no",
      "payment_bearing_http_request_count: 0",
      `blocked_reason: ${blocker}`,
      `blocked_detail: ${detail}`,
      `authorization_hash: ${authorizationHash}`,
      "single_shot: yes",
      "NEXT",
      "Resolve the blocker (re-quote / re-authorize with a fresh pay-time window); do not retry payment without new authorization.",
    ];
    await writeFile(join(runDir, "settlement_probe", "RESULT.txt"), `${lines.join("\n")}\n`, "utf8");
    return { exitCode: 1, lines };
  }

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
