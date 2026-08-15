/**
 * authority-test-issuer — TEST-ONLY autonomy authority signing fixture.
 *
 * MUST NOT be imported by productive AuthorityPolicyEvaluator.
 * Uses HMAC-SHA256 over authorityHash with an isolated test secret.
 * No wallet / DPAPI / operational credential.
 */

import {
  assertAutonomyAuthorityIntegrity,
  buildAutonomyAuthorityUnsigned,
  type AutonomyAuthorityV1,
} from "./autonomy-authority-v1";
import {
  B63_TEST_ISSUER,
  B63_TEST_ISSUER_KEY_ID,
} from "./authority-test-issuer-constants";
import { computeTestAuthoritySignature } from "./authority-signature-verify";

export { B63_TEST_ISSUER, B63_TEST_ISSUER_KEY_ID };

export function signAutonomyAuthorityForTest(
  unsigned: Omit<AutonomyAuthorityV1, "issuerSignature"> & {
    readonly issuerSignature: null;
  },
): AutonomyAuthorityV1 {
  assertAutonomyAuthorityIntegrity({
    ...unsigned,
    issuerSignature: null,
  });
  return {
    ...unsigned,
    issuerSignature: computeTestAuthoritySignature(unsigned.authorityHash),
  };
}

export function mintTestAutonomyAuthority(
  overrides: Partial<
    Omit<
      AutonomyAuthorityV1,
      "authorityHash" | "issuerSignature" | "schemaVersion" | "payment_authorized"
    >
  > & {
    readonly authorityId: string;
    readonly createdAt: string;
    readonly validFrom: string;
    readonly validUntil: string;
  },
): AutonomyAuthorityV1 {
  const unsigned = buildAutonomyAuthorityUnsigned({
    authorityId: overrides.authorityId,
    issuer: overrides.issuer ?? B63_TEST_ISSUER,
    issuerKeyId: overrides.issuerKeyId ?? B63_TEST_ISSUER_KEY_ID,
    createdAt: overrides.createdAt,
    validFrom: overrides.validFrom,
    validUntil: overrides.validUntil,
    allowedNeedAuthorityClasses: overrides.allowedNeedAuthorityClasses ?? [
      "EXPLICIT_HUMAN_NEED",
      "DERIVED_TASK_NEED",
      "WORKFLOW_BOUND_NEED",
    ],
    allowedCapabilities: overrides.allowedCapabilities ?? ["crypto_news"],
    allowedProviders: overrides.allowedProviders ?? ["bazaar_unpaid", "ottoai"],
    allowedSellers: overrides.allowedSellers ?? [
      "0x0e84ddedaae6a779c462c22a59f301ec31b6b808",
    ],
    allowedNetworks: overrides.allowedNetworks ?? ["eip155:8453"],
    allowedAssets: overrides.allowedAssets ?? [
      "USDC",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ],
    maxPerTransaction: overrides.maxPerTransaction ?? "1000",
    maxAggregateSpend: overrides.maxAggregateSpend ?? "10000",
    maxTransactionCount: overrides.maxTransactionCount ?? 10,
    accountingWindowMs: overrides.accountingWindowMs ?? 86_400_000,
    maxSpendPerWindow: overrides.maxSpendPerWindow ?? "5000",
    maxTransactionsPerWindow: overrides.maxTransactionsPerWindow ?? 3,
    sellerHistoryRequirements: overrides.sellerHistoryRequirements ?? {
      minimumSuccessfulSettlements: 3,
      minimumDistinctSuccessfulDays: 2,
      maximumRecentFailureCount: 0,
      maximumRecentAmbiguousSendCount: 0,
      maximumUnresolvedIdentityChanges: 0,
      requireDeliveredUtilityEvidence: true,
    },
    humanRequired: overrides.humanRequired ?? {
      firstSellerExecution: false,
      capabilityClasses: [],
      amountAboveAtomic: null,
      insufficientSellerHistory: false,
    },
    revocationRef: overrides.revocationRef ?? `revocation:${overrides.authorityId}`,
    authorityPolicyId: overrides.authorityPolicyId ?? "trustforge_b63_test_policy",
    authorityPolicyVersion: overrides.authorityPolicyVersion ?? 1,
  });
  return signAutonomyAuthorityForTest(unsigned);
}
