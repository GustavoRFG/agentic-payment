/**
 * Absolute production blocker until B.2 owns buyer nonce creation, unsigned and
 * signed payload persistence, signing, and the single payment-bearing send.
 *
 * This module deliberately has no environment-variable escape hatch.
 */

export const BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED =
  "BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED" as const;

export function assertB2BuyerSignedAuthorizationPipelineImplemented(): never {
  throw new Error(
    `${BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED}: buyer authorization preparation, persistence, signing, and controlled send are deferred to B.2`,
  );
}
