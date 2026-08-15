/**
 * autonomy-authority-v1 — immutable externally-issued pre-existing authority (B.6.3).
 * Does NOT authorize payment by itself. AUTONOMY_ALLOWED != SEND.
 */

import { BLOCKED_B63_AUTHORITY_TAMPER } from "./b63-execution-gates";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const AUTONOMY_AUTHORITY_SCHEMA = "trustforge_autonomy_authority.v1" as const;

export interface SellerHistoryRequirements {
  readonly minimumSuccessfulSettlements: number;
  readonly minimumDistinctSuccessfulDays: number;
  readonly maximumRecentFailureCount: number;
  readonly maximumRecentAmbiguousSendCount: number;
  readonly maximumUnresolvedIdentityChanges: number;
  readonly requireDeliveredUtilityEvidence: boolean;
}

export interface AutonomyAuthorityHumanRequiredRules {
  readonly firstSellerExecution: boolean;
  readonly capabilityClasses: readonly string[];
  readonly amountAboveAtomic: string | null;
  readonly insufficientSellerHistory: boolean;
}

export interface AutonomyAuthorityV1 {
  readonly authorityId: string;
  readonly schemaVersion: typeof AUTONOMY_AUTHORITY_SCHEMA;
  readonly issuer: string;
  readonly issuerKeyId: string;
  readonly createdAt: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly allowedNeedAuthorityClasses: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly allowedProviders: readonly string[];
  readonly allowedSellers: readonly string[];
  readonly allowedNetworks: readonly string[];
  readonly allowedAssets: readonly string[];
  readonly maxPerTransaction: string;
  readonly maxAggregateSpend: string;
  readonly maxTransactionCount: number;
  readonly accountingWindowMs: number;
  readonly maxSpendPerWindow: string;
  readonly maxTransactionsPerWindow: number;
  readonly sellerHistoryRequirements: SellerHistoryRequirements;
  readonly humanRequired: AutonomyAuthorityHumanRequiredRules;
  readonly revocationRef: string;
  readonly authorityPolicyId: string;
  readonly authorityPolicyVersion: number;
  readonly authorityHash: string;
  readonly issuerSignature: string | null;
  readonly payment_authorized: false;
}

function authorityHashBody(
  a: Omit<AutonomyAuthorityV1, "authorityHash" | "issuerSignature">,
): Record<string, unknown> {
  return {
    authorityId: a.authorityId,
    schemaVersion: a.schemaVersion,
    issuer: a.issuer,
    issuerKeyId: a.issuerKeyId,
    createdAt: a.createdAt,
    validFrom: a.validFrom,
    validUntil: a.validUntil,
    allowedNeedAuthorityClasses: [...a.allowedNeedAuthorityClasses],
    allowedCapabilities: [...a.allowedCapabilities],
    allowedProviders: [...a.allowedProviders],
    allowedSellers: [...a.allowedSellers].map((s) => s.toLowerCase()),
    allowedNetworks: [...a.allowedNetworks],
    allowedAssets: [...a.allowedAssets],
    maxPerTransaction: a.maxPerTransaction,
    maxAggregateSpend: a.maxAggregateSpend,
    maxTransactionCount: a.maxTransactionCount,
    accountingWindowMs: a.accountingWindowMs,
    maxSpendPerWindow: a.maxSpendPerWindow,
    maxTransactionsPerWindow: a.maxTransactionsPerWindow,
    sellerHistoryRequirements: a.sellerHistoryRequirements,
    humanRequired: a.humanRequired,
    revocationRef: a.revocationRef,
    authorityPolicyId: a.authorityPolicyId,
    authorityPolicyVersion: a.authorityPolicyVersion,
    payment_authorized: false,
  };
}

export function autonomyAuthorityHash(
  a:
    | Omit<AutonomyAuthorityV1, "authorityHash" | "issuerSignature">
    | AutonomyAuthorityV1,
): string {
  const { authorityHash: _h, issuerSignature: _s, ...rest } = a as AutonomyAuthorityV1 & {
    authorityHash?: string;
    issuerSignature?: string | null;
  };
  void _h;
  void _s;
  return canonicalJsonSha256(
    authorityHashBody(
      rest as Omit<AutonomyAuthorityV1, "authorityHash" | "issuerSignature">,
    ),
  );
}

export function buildAutonomyAuthorityUnsigned(
  input: Omit<
    AutonomyAuthorityV1,
    "authorityHash" | "issuerSignature" | "schemaVersion" | "payment_authorized"
  >,
): Omit<AutonomyAuthorityV1, "issuerSignature"> & { readonly issuerSignature: null } {
  const partial = {
    ...input,
    schemaVersion: AUTONOMY_AUTHORITY_SCHEMA,
    payment_authorized: false as const,
  };
  const hash = autonomyAuthorityHash(partial);
  return {
    ...partial,
    authorityHash: hash,
    issuerSignature: null,
  };
}

export function assertAutonomyAuthorityIntegrity(
  authority: AutonomyAuthorityV1,
): { readonly ok: true } {
  if (authority.schemaVersion !== AUTONOMY_AUTHORITY_SCHEMA) {
    throw new Error(`${BLOCKED_B63_AUTHORITY_TAMPER}: schemaVersion`);
  }
  if (authority.payment_authorized !== false) {
    throw new Error(`${BLOCKED_B63_AUTHORITY_TAMPER}: payment_authorized`);
  }
  if (autonomyAuthorityHash(authority) !== authority.authorityHash) {
    throw new Error(`${BLOCKED_B63_AUTHORITY_TAMPER}: authorityHash mismatch`);
  }
  return { ok: true };
}
