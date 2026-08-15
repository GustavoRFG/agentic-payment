/**
 * authority-view — read-only interface for AuthorityPolicyEvaluator (B.6.3).
 * No write / create / mutate methods.
 */

import type { AutonomyAuthorityV1 } from "./autonomy-authority-v1";
import type { AuthorityConsumptionLedger } from "./authority-consumption-ledger";
import type { AuthorityRevocationLedger } from "./authority-revocation-ledger";
import type { SellerExecutionHistoryV1 } from "./seller-execution-history-v1";

export interface AuthorityView {
  readonly getAuthority: () => AutonomyAuthorityV1 | null;
  readonly getRevocations: () => AuthorityRevocationLedger;
  readonly getConsumptionEvents: () => AuthorityConsumptionLedger;
  readonly getSellerExecutionHistory: (
    seller: string,
  ) => SellerExecutionHistoryV1 | null;
}

export function createReadonlyAuthorityView(input: {
  readonly authority: AutonomyAuthorityV1 | null;
  readonly revocations: AuthorityRevocationLedger;
  readonly consumption: AuthorityConsumptionLedger;
  readonly sellerHistories: ReadonlyMap<string, SellerExecutionHistoryV1>;
}): AuthorityView {
  return {
    getAuthority: () => input.authority,
    getRevocations: () => input.revocations,
    getConsumptionEvents: () => input.consumption,
    getSellerExecutionHistory: (seller: string) =>
      input.sellerHistories.get(seller.toLowerCase()) ?? null,
  };
}

/** Structural proof: view type has no mutation methods. */
export const AUTHORITY_VIEW_FORBIDDEN_METHODS = [
  "createAuthority",
  "extendAuthority",
  "renewAuthority",
  "increaseBudget",
  "changeSellerScope",
  "changeCapabilityScope",
  "changeNetworkScope",
  "changeAssetScope",
  "changeValidUntil",
  "signAuthority",
  "appendConsumption",
  "appendRevocation",
] as const;
