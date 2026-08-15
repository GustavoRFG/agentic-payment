/**
 * authority-signature-verify — verify TEST HMAC authority signatures (B.6.3).
 * Verification only. No minting / signing API.
 */

import { createHmac } from "node:crypto";

import type { AutonomyAuthorityV1 } from "./autonomy-authority-v1";
import { B63_TEST_ISSUER_KEY_ID } from "./authority-test-issuer-constants";

/** Fixed test secret — not a real wallet key. */
export const B63_TEST_HMAC_SECRET =
  "TRUSTFORGE_B63_TEST_AUTHORITY_HMAC_SECRET_NOT_FOR_PROD";

export function computeTestAuthoritySignature(authorityHash: string): string {
  const sig = createHmac("sha256", B63_TEST_HMAC_SECRET)
    .update(authorityHash)
    .digest("hex");
  return `hmac-sha256:${sig}`;
}

export function verifyAutonomyAuthorityTestSignature(
  authority: AutonomyAuthorityV1,
): boolean {
  if (!authority.issuerSignature) return false;
  if (authority.issuerKeyId !== B63_TEST_ISSUER_KEY_ID) return false;
  return (
    authority.issuerSignature ===
    computeTestAuthoritySignature(authority.authorityHash)
  );
}
