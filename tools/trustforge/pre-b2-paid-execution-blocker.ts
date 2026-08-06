/**
 * Absolute production gates for B.2. Prepare-only activation is controlled by
 * the versioned policy module; this file re-exports the granular blockers so
 * historical imports keep working without an environment escape hatch.
 */

export {
  BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED,
  BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING,
  BLOCKED_B2_PAYMENT_BEARING_SEND_NOT_AUTHORIZED,
  BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID,
  BLOCKED_B2_PREPARE_ACTIVATION_POLICY_MISSING,
  BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED,
  BLOCKED_B2_SETTLEMENT_NOT_AUTHORIZED,
  assertB2BuyerSignedAuthorizationPipelineImplemented,
  assertB2PaymentBearingSendNotAuthorized,
  assertB2RealSignerNotAuthorized,
  assertB2SettlementNotAuthorized,
} from "./b2-execution-gates";
