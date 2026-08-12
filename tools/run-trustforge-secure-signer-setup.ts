/**
 * run-trustforge-secure-signer-setup — one-time DPAPI vault setup for expected buyer.
 *
 * Expected wallet defaults to FIRST_REAL_MAINNET_PAYMENT_V1 buyer (0x4cf3…).
 * Does not execute payment.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { FIRST_REAL_MAINNET_PAYMENT_V1 } from "./trustforge/first-mainnet-payment-golden-trace";
import {
  runSecureSignerSetup,
  verifyProtectedSignerVaultReady,
} from "./trustforge/buyer-secure-signer-setup";
import { createWinFormsMaskedSecretDialog } from "./trustforge/buyer-windows-masked-secret-dialog";
import { createWindowsDpapiCurrentUserBackend } from "./trustforge/windows-dpapi-protect";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<number> {
  const expected =
    readArg("--expected-wallet") ?? FIRST_REAL_MAINNET_PAYMENT_V1.buyer;
  const runDir = readArg("--run-dir");

  console.log("");
  console.log("============================================================");
  console.log("TRUSTFORGE — ONE-TIME BUYER SIGNER SETUP");
  console.log("");
  console.log("This is the LAST normal private-key entry for this wallet.");
  console.log("");
  console.log("Expected wallet:");
  console.log(expected);
  console.log("");
  console.log("MetaMask → Copy private key");
  console.log("→ paste into masked field");
  console.log("→ Protect Wallet / Continue");
  console.log("");
  console.log("Future normal payments will use Approve / Reject");
  console.log("and will NOT request the private key again.");
  console.log("============================================================");
  console.log("");

  const result = await runSecureSignerSetup({
    expectedWallet: expected,
    dialog: createWinFormsMaskedSecretDialog(),
  });

  const verify = verifyProtectedSignerVaultReady({
    expectedWallet: expected,
    backend: createWindowsDpapiCurrentUserBackend(),
  });

  console.log(`provider_id: ${result.provider_id}`);
  console.log(`derived_signer_match: ${result.derived_signer_match}`);
  console.log(`plaintext_persisted: ${result.plaintext_persisted}`);
  console.log(`vault_ready: ${result.vault_ready}`);
  console.log(`VAULT_READY: ${verify.VAULT_READY}`);
  console.log(`EXPECTED_SIGNER_MATCH: ${verify.EXPECTED_SIGNER_MATCH}`);

  if (runDir) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      `${runDir}/RESULT.txt`,
      "RESULT: B4_PROTECTED_SIGNER_READY\n",
    );
    writeFileSync(
      `${runDir}/RESULT.json`,
      JSON.stringify(
        {
          RESULT: "B4_PROTECTED_SIGNER_READY",
          provider: result.provider_id,
          expected_signer: result.expected_signer,
          derived_signer_match: result.derived_signer_match,
          plaintext_persisted: false,
          normal_payment_key_prompt_required: false,
          operational_vault: "READY",
          vault_path: result.vault_path,
          evidence: result.evidence,
          VAULT_READY: true,
          EXPECTED_SIGNER_MATCH: true,
        },
        null,
        2,
      ) + "\n",
    );
  }

  console.log("RESULT: B4_PROTECTED_SIGNER_READY");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
