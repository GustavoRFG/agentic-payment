/**
 * buyer-conditional-payment-send-derivation — derive PaymentSendAuthorization
 * after signed artifact + post-sign JIT audit PASS. Synthetic E2E runner included.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BLOCKED_B37_SEND_TEMPORAL_WINDOW_CLOSED,
  GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
  POST_SIGN_JIT_AUDIT_PASS,
} from "./b37-execution-gates";
import {
  SIGNED_ARTIFACT,
  UNSIGNED_ARTIFACT,
  writeArtifactOnce,
  type SignedArtifact,
  type UnsignedArtifact,
} from "./buyer-authorization-artifacts";
import { buyerCredentialAccessAuthorizationSha256 } from "./buyer-credential-access-authorization";
import type { BuyerCredentialAccessAuthorization } from "./buyer-credential-access-authorization";
import {
  humanConditionalPaymentSendMandateSha256,
  validateHumanConditionalPaymentSendMandate,
  type HumanConditionalPaymentSendMandate,
} from "./buyer-conditional-payment-send-mandate";
import { verifyDerivedPaymentSendAuthorizationIsSubsetOfSendMandate } from "./buyer-conditional-payment-send-authority-subset";
import {
  humanConditionalCredentialSigningMandateSha256,
  type HumanConditionalCredentialSigningMandate,
} from "./buyer-conditional-credential-signing-mandate";
import { runPostSignJitAudit } from "./buyer-post-sign-jit-audit";
import {
  buildPaymentSendAuthorization,
  paymentSendAuthorizationSha256,
  validatePaymentSendAuthorization,
  type PaymentSendAuthorization,
} from "./buyer-payment-send-authorization";
import {
  BuyerPaymentSendLedger,
  SyntheticPaymentBearingTransport,
  persistPaymentSendLifecycle,
  type SyntheticPaymentTransportOutcome,
} from "./buyer-payment-send-lifecycle";
import {
  buyerSigningAuthorizationSha256,
  type BuyerSigningAuthorization,
} from "./buyer-signing-authorization";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const DERIVED_PAYMENT_SEND_AUTHORIZATION_ARTIFACT =
  "buyer_payment_send_authorization_derived.json" as const;

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function earliestIso(...candidates: string[]): string {
  let best = candidates[0]!;
  let bestMs = Date.parse(best);
  for (const c of candidates.slice(1)) {
    const ms = Date.parse(c);
    if (ms < bestMs) {
      best = c;
      bestMs = ms;
    }
  }
  return best;
}

export interface DerivePaymentSendAuthorizationResult {
  readonly derived_payment_send_authorization: PaymentSendAuthorization;
  readonly payment_send_authorization_sha256: string;
  readonly post_sign_jit_audit: typeof POST_SIGN_JIT_AUDIT_PASS;
  readonly recovered_signer: string;
  readonly subset_checked_fields: readonly string[];
}

export async function derivePaymentSendAuthorization(input: {
  readonly directory: string;
  readonly sendMandate: HumanConditionalPaymentSendMandate;
  readonly signingMandate: HumanConditionalCredentialSigningMandate;
  readonly signingAuthorization: BuyerSigningAuthorization;
  readonly credentialAccessAuthorization: BuyerCredentialAccessAuthorization;
  readonly now: Date;
  readonly recoveredSignerOverride?: string;
}): Promise<DerivePaymentSendAuthorizationResult> {
  validateHumanConditionalPaymentSendMandate({
    mandate: input.sendMandate,
    now: input.now,
  });

  if (input.signingAuthorization.payment_bearing_send_authorized !== false) {
    fail(
      GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
      "signing authorization must not authorize send",
    );
  }

  const unsignedPath = join(input.directory, UNSIGNED_ARTIFACT);
  const signedPath = join(input.directory, SIGNED_ARTIFACT);
  const unsigned = JSON.parse(readFileSync(unsignedPath, "utf8")) as UnsignedArtifact;
  const signed = JSON.parse(readFileSync(signedPath, "utf8")) as SignedArtifact;

  const validBeforeSec = Number(unsigned.message.validBefore);
  const effectiveDeadlineMs = Date.parse(unsigned.effective_signing_deadline);
  const mandateExpiryMs = Date.parse(input.sendMandate.mandate_expires_at);
  const nowMs = input.now.getTime();
  const nowSec = Math.floor(nowMs / 1000);

  if (!(nowSec < validBeforeSec) || !(nowMs < effectiveDeadlineMs) || !(nowMs < mandateExpiryMs)) {
    fail(
      BLOCKED_B37_SEND_TEMPORAL_WINDOW_CLOSED,
      "now must be before validBefore, effective deadline, and send mandate expiry",
    );
  }

  const audit = await runPostSignJitAudit({
    directory: input.directory,
    expectedBuyer: input.sendMandate.buyer_wallet,
    expectedAmountAtomic: input.sendMandate.amount_atomic,
    expectedAsset: input.sendMandate.asset,
    expectedPayTo: input.sendMandate.pay_to,
    expectedNetworkCaip2: input.sendMandate.canonical_network_caip2,
    expectedRequestBindingSha256: input.sendMandate.request_binding_sha256,
    expectedRequirementsSha256: input.sendMandate.canonical_requirements_sha256,
    expectedEnvelopeSha256: input.sendMandate.canonical_envelope_sha256,
    now: input.now,
    recoveredSignerOverride: input.recoveredSignerOverride,
  });

  const sendMandateSha256 = humanConditionalPaymentSendMandateSha256(input.sendMandate);
  const signingMandateSha256 = humanConditionalCredentialSigningMandateSha256(
    input.signingMandate,
  );
  const unsignedCanonicalSha = canonicalJsonSha256(unsigned);
  const signedFileSha = fileSha256(signedPath);
  const signingAuthSha = buyerSigningAuthorizationSha256(input.signingAuthorization);
  const credentialAuthSha = buyerCredentialAccessAuthorizationSha256(
    input.credentialAccessAuthorization,
  );

  const sendExpiresAt = earliestIso(
    input.sendMandate.mandate_expires_at,
    unsigned.effective_signing_deadline,
    new Date(validBeforeSec * 1000).toISOString(),
  );

  const derived = buildPaymentSendAuthorization({
    sendMandate: input.sendMandate,
    sendMandateSha256,
    signingMandateSha256,
    attemptId: unsigned.attempt_id,
    runId: unsigned.run_id ?? null,
    unsignedArtifactSha256: unsignedCanonicalSha,
    signedArtifactSha256: signedFileSha,
    signingAuthorizationSha256: signingAuthSha,
    credentialAccessAuthorizationSha256: credentialAuthSha,
    buyerWallet: unsigned.buyer_wallet,
    asset: unsigned.asset,
    payTo: unsigned.pay_to,
    amountAtomic: unsigned.seller_amount_atomic,
    sellerNetworkRaw: unsigned.seller_network_raw,
    canonicalNetworkCaip2: unsigned.canonical_network_caip2,
    chainId: unsigned.chain_id,
    endpoint: unsigned.endpoint,
    method: unsigned.method,
    requestQuery: input.sendMandate.request_query,
    requestBody: input.sendMandate.request_body,
    requestBindingSha256: unsigned.request_binding_sha256,
    canonicalRequirementsSha256: unsigned.canonical_requirements_sha256,
    canonicalEnvelopeSha256: unsigned.canonical_envelope_sha256,
    signatureAttemptId: null,
    signerAddress: signed.signer_address,
    signedAt: signed.signed_at,
    eip3009ValidAfter: String(unsigned.message.validAfter),
    eip3009ValidBefore: String(unsigned.message.validBefore),
    sendAuthorizationExpiresAt: sendExpiresAt,
  });

  validatePaymentSendAuthorization({ authorization: derived, now: input.now });

  const subset = verifyDerivedPaymentSendAuthorizationIsSubsetOfSendMandate({
    sendMandate: input.sendMandate,
    sendMandateSha256,
    signingMandateSha256,
    derived,
    unsignedArtifactSha256: unsignedCanonicalSha,
    signedArtifactSha256: signedFileSha,
    signingAuthorizationSha256: signingAuthSha,
    credentialAccessAuthorizationSha256: credentialAuthSha,
    attemptId: unsigned.attempt_id,
  });

  writeArtifactOnce(join(input.directory, DERIVED_PAYMENT_SEND_AUTHORIZATION_ARTIFACT), derived);

  return {
    derived_payment_send_authorization: derived,
    payment_send_authorization_sha256: paymentSendAuthorizationSha256(derived),
    post_sign_jit_audit: POST_SIGN_JIT_AUDIT_PASS,
    recovered_signer: audit.recovered_signer,
    subset_checked_fields: subset.checked_fields,
  };
}

export interface SyntheticConditionalSendE2EResult {
  readonly payment_bearing_request_invocations: 1;
  readonly second_invocation_blocked: true;
  readonly retry: "none";
  readonly resend: "none";
  readonly disposition: "RESPONSE_OBSERVED" | "AMBIGUOUS_SEND_TERMINAL_RECONCILE";
  readonly payment_send_authorization_sha256: string;
  readonly post_sign_jit_audit: typeof POST_SIGN_JIT_AUDIT_PASS;
  readonly live_http: 0;
}

/**
 * Synthetic-only: after signed artifacts exist, derive PSA → commit → one
 * synthetic payment-bearing request. Never performs live HTTP.
 */
export async function runSyntheticConditionalPaymentSendE2E(input: {
  readonly directory: string;
  readonly sendMandate: HumanConditionalPaymentSendMandate;
  readonly signingMandate: HumanConditionalCredentialSigningMandate;
  readonly signingAuthorization: BuyerSigningAuthorization;
  readonly credentialAccessAuthorization: BuyerCredentialAccessAuthorization;
  readonly now: Date;
  readonly nowAtSend?: Date;
  readonly transportOutcome?: SyntheticPaymentTransportOutcome;
  readonly recoveredSignerOverride?: string;
}): Promise<SyntheticConditionalSendE2EResult> {
  // Parent mandate is derivation input only — never a network credential.
  // Guard is exercised separately in unit tests against the mandate object.

  const derived = await derivePaymentSendAuthorization({
    directory: input.directory,
    sendMandate: input.sendMandate,
    signingMandate: input.signingMandate,
    signingAuthorization: input.signingAuthorization,
    credentialAccessAuthorization: input.credentialAccessAuthorization,
    now: input.now,
    recoveredSignerOverride: input.recoveredSignerOverride,
  });

  const sendNow = input.nowAtSend ?? input.now;
  validatePaymentSendAuthorization({
    authorization: derived.derived_payment_send_authorization,
    now: sendNow,
  });

  const ledger = new BuyerPaymentSendLedger();
  ledger.issueDerived({
    sendAuthorizationSha256: derived.payment_send_authorization_sha256,
    sendMandateSha256: humanConditionalPaymentSendMandateSha256(input.sendMandate),
    attemptId: derived.derived_payment_send_authorization.attempt_id,
    now: sendNow,
  });
  ledger.commitNoRetry({
    sendAuthorizationSha256: derived.payment_send_authorization_sha256,
    now: sendNow,
  });

  const transport = new SyntheticPaymentBearingTransport(
    input.transportOutcome ?? { kind: "ok", status: 200, body: '{"synthetic":true}' },
  );
  const first = await transport.invokeOnce({
    ledger,
    sendAuthorizationSha256: derived.payment_send_authorization_sha256,
    now: sendNow,
  });

  // Persist final lifecycle once (write-once).
  persistPaymentSendLifecycle(
    input.directory,
    ledger.get(derived.payment_send_authorization_sha256)!,
  );

  let secondBlocked = false;
  try {
    await transport.invokeOnce({
      ledger,
      sendAuthorizationSha256: derived.payment_send_authorization_sha256,
      now: new Date(sendNow.getTime() + 1000),
    });
  } catch {
    secondBlocked = true;
  }
  if (!secondBlocked) {
    fail("BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST", "second synthetic invoke must be blocked");
  }

  return {
    payment_bearing_request_invocations: 1,
    second_invocation_blocked: true,
    retry: "none",
    resend: "none",
    disposition:
      first.disposition === "RESPONSE_OBSERVED"
        ? "RESPONSE_OBSERVED"
        : "AMBIGUOUS_SEND_TERMINAL_RECONCILE",
    payment_send_authorization_sha256: derived.payment_send_authorization_sha256,
    post_sign_jit_audit: POST_SIGN_JIT_AUDIT_PASS,
    live_http: 0,
  };
}
