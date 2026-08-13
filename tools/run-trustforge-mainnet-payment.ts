/**
 * run-trustforge-mainnet-payment — B.4 thin mainnet payment CLI.
 *
 * Uses Windows approve/reject dialog + DPAPI local signer when vault exists.
 * Does not invent payment authority; never retries send.
 *
 * Do not run without explicit human authorization for a real payment.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  B4_PROTECTED_SIGNER_PROVIDER_ID,
  BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE,
} from "./trustforge/b4-execution-gates";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { createWindowsApproveRejectDialogProvider } from "./trustforge/windows-approve-reject-dialog";
import { createWindowsDpapiLocalSignerProvider } from "./trustforge/windows-dpapi-local-signer";
import {
  defaultTrustForgeSignersDir,
  vaultPathForBuyer,
} from "./trustforge/buyer-protected-signer-vault";
import { runThinMainnetPayment } from "./trustforge/thin-mainnet-payment-runner";
import { FIRST_REAL_MAINNET_PAYMENT_V1 } from "./trustforge/first-mainnet-payment-golden-trace";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<number> {
  const runDir = readArg("--run-dir");
  const candidatePath =
    readArg("--candidate") ??
    (runDir ? join(runDir, "selected_candidate.json") : undefined);

  if (!runDir || !candidatePath) {
    console.error(
      "Usage: tsx tools/run-trustforge-mainnet-payment.ts --run-dir <path> [--candidate <selected_candidate.json>]",
    );
    console.error(
      "Requires Windows approve/reject dialog + DPAPI vault for expected buyer.",
    );
    return 1;
  }

  if (!existsSync(candidatePath)) {
    console.error(`selected candidate missing: ${candidatePath}`);
    return 1;
  }

  const selected = JSON.parse(
    readFileSync(candidatePath, "utf8"),
  ) as DiscoveredSelectedCandidate;

  const expectedBuyer =
    selected.buyer_wallet?.toLowerCase() ||
    FIRST_REAL_MAINNET_PAYMENT_V1.buyer.toLowerCase();
  const vaultPath = vaultPathForBuyer(expectedBuyer, defaultTrustForgeSignersDir());
  if (!existsSync(vaultPath)) {
    console.error(
      `${BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE}: vault missing for ${expectedBuyer}. Run trustforge:secure-signer-setup first.`,
    );
    return 1;
  }

  mkdirSync(runDir, { recursive: true });

  const credentialPolicyPath = join(runDir, "credential_provider_policy.operational.json");
  writeFileSync(
    credentialPolicyPath,
    JSON.stringify(
      {
        schema_version: "trustforge_buyer_credential_provider_policy.v2",
        credential_provider_configured: true,
        allowed_provider_ids: [
          "inactive_production",
          "explicit-runtime-key",
          "windows-dpapi-local-signer",
          "encrypted-local-keystore",
          "external-signer",
          "secure-signing-provider",
        ],
        selected_productive_provider_id: B4_PROTECTED_SIGNER_PROVIDER_ID,
        provider_id: B4_PROTECTED_SIGNER_PROVIDER_ID,
        credential_kind: "windows_dpapi_protected_private_key",
        adapter_installed: true,
        transport_adapter_installed: true,
        secret_entry_adapter_installed: true,
        expected_signer_address: expectedBuyer,
        credential_access_enabled: true,
        real_backend_activation: false,
        credential_caching_enabled: false,
        automatic_discovery_enabled: false,
        fallback_provider_enabled: false,
        real_signing_enabled: false,
        payment_bearing_send_enabled: false,
        settlement_enabled: false,
        retry_enabled: false,
        effect:
          "B.4 operational windows-dpapi-local-signer; payment send only via PSA/B371; no key prompt",
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`provider: ${B4_PROTECTED_SIGNER_PROVIDER_ID}`);
  console.log(`vault: present (path redacted)`);
  console.log(`buyer: ${expectedBuyer}`);
  console.log("Awaiting human approve/reject…");

  const result = await runThinMainnetPayment({
    directory: runDir,
    selected,
    decisionProvider: createWindowsApproveRejectDialogProvider(),
    credentialProvider: createWindowsDpapiLocalSignerProvider(),
    credentialPolicyPath,
  });

  console.log(`decision: ${result.decision}`);
  console.log(`state: ${result.state.state}`);
  console.log(`signatures: ${result.signatures}`);
  console.log(`payment_bearing_requests: ${result.payment_bearing_requests}`);
  console.log(`golden_compare_ok: ${result.golden_compare?.ok ?? "n/a"}`);
  if (result.http_status != null) console.log(`http_status: ${result.http_status}`);
  if (result.onchain_status) console.log(`onchain_status: ${result.onchain_status}`);
  if (result.facilitator_tx_hash) {
    console.log(`facilitator_tx_hash: ${result.facilitator_tx_hash}`);
  }
  // Never print nonce, signature, payment header, or private key material.
  return result.state.state === "CONFIRMED" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(async (code) => {
      // Yield so destroyed child stdio handles finish closing before hard exit
      // (mitigates Windows libuv UV_HANDLE_CLOSING abort after success).
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.exitCode = code;
      process.exit(code);
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : error);
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.exit(1);
    });
}
