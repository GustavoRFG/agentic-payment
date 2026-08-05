/**
 * run-trustforge-x402-preflight — read-only, KEYLESS pre-settlement verification
 * for the thin x402 runner, parameterized by network profile (Sepolia | mainnet).
 *
 *   node ./seller-api/node_modules/tsx/dist/cli.mjs \
 *     tools/run-trustforge-x402-preflight.ts --run-dir "<run>" --network mainnet
 *
 * Default mode never loads a key, never authorizes, never signs and never sends a
 * payment-bearing request. The optional --verify-wallet-env mode is a human gate
 * that derives the address from BUYER_PRIVATE_KEY and compares it to the expected
 * wallet; it still never signs and never pays.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runX402SettlementPreflight, type X402PreflightResult } from "./trustforge/x402-settlement-preflight";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

function reportLines(result: X402PreflightResult): string[] {
  return [
    "RESULT",
    result.ok ? "MAINNET_THIN_PREFLIGHT_READY_FOR_HUMAN_GATE_CANDIDATE" : (result.blocker ?? "FAIL"),
    `preflight_status: ${result.ok ? "PASS" : result.blocker ?? "FAIL"}`,
    `mode: ${result.mode}`,
    `network_profile: ${result.network_profile}`,
    `caip2: ${result.caip2}`,
    `chain_id_expected: ${result.chain_id_expected}`,
    `chain_id_observed: ${result.chain_id_observed ?? "null"}`,
    `asset_expected: ${result.asset_expected}`,
    `asset_candidate: ${result.asset_candidate ?? "null"}`,
    `buyer_expected: ${result.buyer_expected}`,
    `buyer_derived: ${result.buyer_derived ?? "null"}`,
    `endpoint: ${result.endpoint ?? "null"}`,
    `authorized_pay_to: ${result.authorized_pay_to ?? "null"}`,
    `quote_atomic: ${result.quote_atomic ?? "null"}`,
    `quote_amount_usdc: ${result.quote_amount_usdc ?? "null"}`,
    `recommended_max_usdc: ${result.recommended_max_usdc ?? "null"}`,
    `wallet_eth: ${result.wallet_eth ?? "null"}`,
    `wallet_usdc: ${result.wallet_usdc ?? "null"}`,
    `candidate_belongs_to_run: ${result.candidate_belongs_to_run ? "yes" : "no"}`,
    `run_already_consumed: ${result.run_already_consumed ? "yes" : "no"}`,
    `fresh_402_go: ${result.fresh_402_go === null ? "null" : result.fresh_402_go ? "yes" : "no"}`,
    `selection_requirements_currently_expired: ${result.selection_requirements_currently_expired === null ? "null" : result.selection_requirements_currently_expired ? "yes" : "no"}`,
    `fresh_unsigned_402_required_before_signing: ${result.fresh_unsigned_402_required_before_signing ? "yes" : "no"}`,
    `paytime_requirements_observed_at: ${result.paytime_requirements_observed_at ?? "null"}`,
    `effective_signing_deadline: ${result.effective_signing_deadline ?? "null"}`,
    `rpc_request_timeout_seconds: ${result.rpc_request_timeout_seconds}`,
    `rpc_fallback_configured: ${result.rpc_fallback_configured ? "yes" : "no"}`,
    `rpc_silent_fallback: no`,
    `BUYER_PRIVATE_KEY_present: ${result.buyer_private_key_present ? "yes" : "no"}`,
    `SEPOLIA_BUYER_PRIVATE_KEY_present: ${result.sepolia_buyer_private_key_present ? "yes" : "no"}`,
    `payment_bearing_http_request_count: ${result.payment_bearing_http_request_count}`,
    `strict_no_payment: ${result.strict_no_payment}`,
    `wallet_loaded: ${result.wallet_loaded}`,
    `signed: ${result.signed ? "yes" : "no"}`,
    `detail: ${result.detail}`,
    "NEXT",
    result.ok
      ? result.mode === "verify-wallet-env"
        ? "Wallet matches. Human authorization + single-shot settle remain manual."
        : "Keyless preflight PASS. Human wallet gate (--verify-wallet-env) then authorization remain manual."
      : "Resolve the blocker and re-run a fresh discovery/adapt; do not authorize or pay.",
  ];
}

async function main(): Promise<number> {
  const runDir = argValue("--run-dir")?.replace(/\\/g, "/");
  if (!runDir) {
    console.error("BLOCKED_MISSING_RUN_DIR: pass --run-dir <run>");
    return 1;
  }
  const network = argValue("--network");
  const verifyWalletEnv = process.argv.includes("--verify-wallet-env");
  const timeoutArg = argValue("--rpc-request-timeout-seconds");
  const rpcRequestTimeoutSeconds = timeoutArg ? Number.parseInt(timeoutArg, 10) : undefined;

  const result = await runX402SettlementPreflight({
    runDir,
    network,
    verifyWalletEnv,
    rpcRequestTimeoutSeconds,
  });

  const lines = reportLines(result);
  if (existsSync(runDir)) {
    await mkdir(runDir, { recursive: true });
    const suffix = verifyWalletEnv ? "wallet_env" : "keyless";
    await writeFile(
      `${runDir}/00_x402_preflight_${suffix}.json`,
      `${JSON.stringify(result, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
      "utf8",
    );
    await writeFile(`${runDir}/00_x402_preflight_${suffix}.txt`, `${lines.join("\n")}\n`, "utf8");
  }
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
