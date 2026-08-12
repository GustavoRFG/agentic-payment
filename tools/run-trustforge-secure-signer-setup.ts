/**
 * run-trustforge-secure-signer-setup — one-time DPAPI vault setup for expected buyer.
 *
 * Expected wallet defaults to FIRST_REAL_MAINNET_PAYMENT_V1 buyer (0x4cf3…).
 * Does not execute payment.
 */

import { pathToFileURL } from "node:url";

import { FIRST_REAL_MAINNET_PAYMENT_V1 } from "./trustforge/first-mainnet-payment-golden-trace";
import { runSecureSignerSetup } from "./trustforge/buyer-secure-signer-setup";
import { createWinFormsMaskedSecretDialog } from "./trustforge/buyer-windows-masked-secret-dialog";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<number> {
  const expected =
    readArg("--expected-wallet") ?? FIRST_REAL_MAINNET_PAYMENT_V1.buyer;

  console.log("TRUSTFORGE secure signer setup (one-time)");
  console.log(`expected_wallet: ${expected}`);
  console.log("Enter private key in the masked dialog. Nothing is printed or stored in plaintext.");

  const result = await runSecureSignerSetup({
    expectedWallet: expected,
    dialog: createWinFormsMaskedSecretDialog(),
  });

  console.log(`provider_id: ${result.provider_id}`);
  console.log(`derived_signer_match: ${result.derived_signer_match}`);
  console.log(`plaintext_persisted: ${result.plaintext_persisted}`);
  console.log(`vault_ready: ${result.vault_ready}`);
  console.log(`vault_path: ${result.vault_path}`);
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
