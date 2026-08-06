/**
 * b2-execution-gates — granular B.2 activation gates.
 *
 * Prepare-only production activation is allowed when the versioned policy says so.
 * Real signing, payment-bearing send, and settlement remain hard-blocked with
 * distinct codes. There is no environment-variable escape hatch.
 */

export const BLOCKED_B2_PREPARE_ACTIVATION_POLICY_MISSING =
  "BLOCKED_B2_PREPARE_ACTIVATION_POLICY_MISSING" as const;
export const BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID =
  "BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID" as const;
export const BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING =
  "BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING" as const;
export const BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED =
  "BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED" as const;
export const BLOCKED_B2_PAYMENT_BEARING_SEND_NOT_AUTHORIZED =
  "BLOCKED_B2_PAYMENT_BEARING_SEND_NOT_AUTHORIZED" as const;
export const BLOCKED_B2_SETTLEMENT_NOT_AUTHORIZED =
  "BLOCKED_B2_SETTLEMENT_NOT_AUTHORIZED" as const;

/**
 * Legacy search string retained for docs and historical RESULT lines. Productive
 * settlement/send entry points now throw the granular send gate below; prepare
 * uses the activation policy path instead of this symbol.
 */
export const BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED =
  "BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED" as const;

export function assertB2RealSignerNotAuthorized(): never {
  throw new Error(
    `${BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED}: prepare-only activation does not authorize a real wallet signer, private-key lookup, or live EIP-712 signature`,
  );
}

export function assertB2PaymentBearingSendNotAuthorized(): never {
  throw new Error(
    `${BLOCKED_B2_PAYMENT_BEARING_SEND_NOT_AUTHORIZED}: prepare-only activation does not authorize payment headers, paid fetch, or settlement send`,
  );
}

export function assertB2SettlementNotAuthorized(): never {
  throw new Error(
    `${BLOCKED_B2_SETTLEMENT_NOT_AUTHORIZED}: prepare-only activation does not authorize settlement`,
  );
}

/**
 * Historical absolute entry used by productive runners. Kept as a hard stop
 * before any payment-bearing path; prepare-only work must call the prepare API
 * explicitly rather than falling through this assertion into a send.
 */
export function assertB2BuyerSignedAuthorizationPipelineImplemented(): never {
  throw new Error(
    `${BLOCKED_B2_PAYMENT_BEARING_SEND_NOT_AUTHORIZED}: prepare-only activation is separate; payment-bearing send remains unauthorized (${BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED})`,
  );
}
