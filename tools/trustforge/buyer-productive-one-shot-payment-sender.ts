/**
 * buyer-productive-one-shot-payment-sender — B.3.7.1 productive send bridge.
 *
 * Authority: exact PaymentSendAuthorization.
 * Credential: PersistedSignedBuyerAuthorization (never a private key / signer).
 *
 * Flow:
 *   PSA + signed artifact + observation
 *   → binding + temporal validation
 *   → header from persisted signature
 *   → SEND_COMMITTED_NO_RETRY
 *   → exactly one HTTP invocation
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AMBIGUOUS_SEND_TERMINAL_RECONCILE,
  BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST,
} from "./b37-execution-gates";
import {
  B371_PRODUCTIVE_SEND_BRIDGE_ID,
  BLOCKED_B371_PAYMENT_SEND_AUTHORIZATION_EXPIRED,
  BLOCKED_B371_PAYMENT_SEND_AUTHORIZATION_INVALID,
  BLOCKED_B371_PAYMENT_SEND_BINDING_MISMATCH,
  BLOCKED_B371_SEND_COMMIT_REQUIRED,
  GUARD_B37_OPERATIONAL_PAYMENT_CANNOT_USE_KEY_HELD_LIVE_EXECUTOR,
  GUARD_NO_PAYMENT_HEADER_SECRET_LEAKAGE,
  GUARD_NO_RESEND_AFTER_SEND_COMMIT,
  GUARD_PRODUCTIVE_SEND_BRIDGE_CANNOT_SIGN,
  GUARD_SEND_IMPLEMENTATION_AVAILABLE_NOT_AUTHORIZATION,
} from "./b371-execution-gates";
import {
  SIGNED_ARTIFACT,
  UNSIGNED_ARTIFACT,
  writeArtifactOnce,
  type SignedArtifact,
  type UnsignedArtifact,
} from "./buyer-authorization-artifacts";
import {
  buildPaymentHeaderFromPersistedSignedArtifact,
  sanitizeBuiltPaymentHeaderEvidence,
  type BuiltPaymentHeader,
} from "./buyer-payment-header-from-signed-artifact";
import {
  createFetchPaymentBearingHttpTransport,
  type PaymentBearingHttpTransport,
  type PaymentBearingTransportOutcome,
  type PreparedPaymentBearingRequest,
} from "./buyer-payment-bearing-http-transport";
import {
  assertExactDerivedPaymentSendAuthorization,
  paymentSendAuthorizationSha256,
  validatePaymentSendAuthorization,
  type PaymentSendAuthorization,
} from "./buyer-payment-send-authorization";
import {
  BuyerPaymentSendLedger,
  persistPaymentSendLifecycle,
  type PaymentSendLifecycleRecord,
} from "./buyer-payment-send-lifecycle";
import { createThinSettlementRequestBinding } from "./thin-settlement-request-binding";
import {
  canonicalJson,
  canonicalJsonSha256,
  type SellerRequirementsObservation,
} from "./x402-seller-requirements-binding";

export const SEND_COMMIT_ARTIFACT = "buyer_payment_send_commit.json" as const;

export interface SendAuthorizedPaymentOnceInput {
  readonly directory: string;
  readonly paymentSendAuthorization: PaymentSendAuthorization;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly signedArtifact: SignedArtifact;
  readonly sellerObservation: SellerRequirementsObservation;
  readonly now: Date;
  readonly ledger?: BuyerPaymentSendLedger;
  readonly transport?: PaymentBearingHttpTransport;
  /** When false, skip write-once commit/lifecycle artifacts (unit tests). Default true. */
  readonly persistArtifacts?: boolean;
}

export type ProductiveSendClassification =
  | "RESPONSE_OBSERVED_SUCCESS"
  | "RESPONSE_OBSERVED_NON_SUCCESS"
  | typeof AMBIGUOUS_SEND_TERMINAL_RECONCILE;

export interface SendAuthorizedPaymentOnceResult {
  readonly bridge_id: typeof B371_PRODUCTIVE_SEND_BRIDGE_ID;
  readonly payment_send_authorization_sha256: string;
  readonly signed_artifact_sha256: string;
  readonly header_evidence: ReturnType<typeof sanitizeBuiltPaymentHeaderEvidence>;
  readonly lifecycle: PaymentSendLifecycleRecord;
  readonly transport_outcome: PaymentBearingTransportOutcome;
  readonly classification: ProductiveSendClassification;
  readonly payment_bearing_request_invocations: 1;
  readonly live_external_payment: false;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function lower(a: string): string {
  return a.toLowerCase();
}

function sha256CanonicalArtifact(value: unknown): string {
  return canonicalJsonSha256(value);
}

/** Matches writeArtifactOnce on-disk body hash (canonicalJson + newline). */
export function sha256WriteOnceBody(value: unknown): string {
  return createHash("sha256").update(`${canonicalJson(value)}\n`, "utf8").digest("hex");
}

export function assertProductiveSendBridgeCannotSign(): never {
  fail(
    GUARD_PRODUCTIVE_SEND_BRIDGE_CANNOT_SIGN,
    "ProductiveOneShotPaymentSender cannot sign; it consumes PersistedSignedBuyerAuthorization only",
  );
}

export function assertB37OperationalPaymentCannotUseKeyHeldLiveExecutor(): never {
  fail(
    GUARD_B37_OPERATIONAL_PAYMENT_CANNOT_USE_KEY_HELD_LIVE_EXECUTOR,
    "B.3.7 operational payment must use ProductiveOneShotPaymentSender, not key-held live payment executors",
  );
}

export function assertSendImplementationAvailableIsNotAuthorization(): never {
  fail(
    GUARD_SEND_IMPLEMENTATION_AVAILABLE_NOT_AUTHORIZATION,
    "SEND IMPLEMENTATION AVAILABLE != SEND AUTHORIZED; exact PaymentSendAuthorization required",
  );
}

export function validatePaymentSendBinding(input: {
  readonly psa: PaymentSendAuthorization;
  readonly unsigned: UnsignedArtifact;
  readonly signed: SignedArtifact;
  readonly observation: SellerRequirementsObservation;
  readonly unsignedCanonicalSha256: string;
  readonly signedArtifactSha256: string;
}): void {
  const { psa, unsigned, signed, observation } = input;
  const check = (label: string, ok: boolean) => {
    if (!ok) fail(BLOCKED_B371_PAYMENT_SEND_BINDING_MISMATCH, label);
  };

  check("attempt_id", psa.attempt_id === unsigned.attempt_id && psa.attempt_id === signed.attempt_id);
  check("buyer", lower(psa.buyer_wallet) === lower(unsigned.buyer_wallet));
  check("buyer_from", lower(psa.buyer_wallet) === lower(unsigned.message.from));
  check("buyer_signer", lower(psa.buyer_wallet) === lower(signed.signer_address));
  check("asset", lower(psa.asset) === lower(unsigned.asset));
  check("pay_to", lower(psa.pay_to) === lower(unsigned.pay_to));
  check("message_to", lower(psa.pay_to) === lower(unsigned.message.to));
  check("amount", psa.amount_atomic === String(unsigned.message.value));
  check("amount_seller", psa.amount_atomic === unsigned.seller_amount_atomic);
  check("network", psa.canonical_network_caip2 === unsigned.canonical_network_caip2);
  check("endpoint", psa.endpoint === unsigned.endpoint);
  check("method", psa.method === unsigned.method);
  check("request_binding", psa.request_binding_sha256 === unsigned.request_binding_sha256);
  check(
    "request_binding_obs",
    psa.request_binding_sha256 === observation.binding.request_binding_sha256,
  );
  check(
    "requirements",
    psa.canonical_requirements_sha256 === unsigned.canonical_requirements_sha256 &&
      psa.canonical_requirements_sha256 === observation.binding.canonical_requirements_sha256,
  );
  check(
    "envelope",
    psa.canonical_envelope_sha256 === unsigned.canonical_envelope_sha256 &&
      psa.canonical_envelope_sha256 === observation.binding.canonical_envelope_sha256,
  );
  check("unsigned_hash", psa.unsigned_artifact_sha256 === input.unsignedCanonicalSha256);
  check("signed_hash", psa.signed_artifact_sha256 === input.signedArtifactSha256);
  check("signed_state", signed.state === "SIGNED_PERSISTED");
  check("sent_false", signed.sent === false);
  check("payment_header_false", signed.payment_header_created === false);
  check("payment_count_zero", signed.payment_bearing_request_count === 0);

  const recomputedRb = createThinSettlementRequestBinding({
    endpoint: psa.endpoint,
    method: psa.method,
    input_status: "known",
    query: psa.request_query,
    body: psa.request_body,
  });
  check("request_binding_recompute", recomputedRb.binding_sha256 === psa.request_binding_sha256);
}

export function validatePreSendTemporalWindow(input: {
  readonly psa: PaymentSendAuthorization;
  readonly unsigned: UnsignedArtifact;
  readonly now: Date;
}): void {
  try {
    validatePaymentSendAuthorization({ authorization: input.psa, now: input.now });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/EXPIRED|expired/i.test(message)) {
      fail(BLOCKED_B371_PAYMENT_SEND_AUTHORIZATION_EXPIRED, message.split("\n")[0]!);
    }
    fail(BLOCKED_B371_PAYMENT_SEND_AUTHORIZATION_INVALID, message.split("\n")[0]!);
  }
  const validBefore = Number(input.unsigned.message.validBefore);
  const nowSec = Math.floor(input.now.getTime() / 1000);
  if (!(nowSec < validBefore)) {
    fail(BLOCKED_B371_PAYMENT_SEND_AUTHORIZATION_EXPIRED, "EIP-3009 validBefore has passed");
  }
  const deadlineMs = Date.parse(input.unsigned.effective_signing_deadline);
  if (!(input.now.getTime() < deadlineMs)) {
    fail(
      BLOCKED_B371_PAYMENT_SEND_AUTHORIZATION_EXPIRED,
      "effective signing/send deadline has passed",
    );
  }
}

function buildPreparedRequest(input: {
  readonly psa: PaymentSendAuthorization;
  readonly header: BuiltPaymentHeader;
}): PreparedPaymentBearingRequest {
  const rb = createThinSettlementRequestBinding({
    endpoint: input.psa.endpoint,
    method: input.psa.method,
    input_status: "known",
    query: input.psa.request_query,
    body: input.psa.request_body,
  });
  const url = new URL(rb.endpoint);
  for (const [k, v] of rb.query) {
    url.searchParams.append(k, v);
  }
  if (input.psa.method !== "GET") {
    fail(BLOCKED_B371_PAYMENT_SEND_AUTHORIZATION_INVALID, "R1 productive bridge is GET-only");
  }
  return {
    url: url.toString(),
    method: "GET",
    headers: {
      [input.header.header_name]: input.header.header_value,
      Accept: "application/json",
    },
    body: null,
  };
}

function classifyOutcome(
  outcome: PaymentBearingTransportOutcome,
): ProductiveSendClassification {
  if (outcome.kind === "ambiguous") return AMBIGUOUS_SEND_TERMINAL_RECONCILE;
  if (outcome.status >= 200 && outcome.status < 300) return "RESPONSE_OBSERVED_SUCCESS";
  return "RESPONSE_OBSERVED_NON_SUCCESS";
}

function resolveSignedArtifactSha256(directory: string, signed: SignedArtifact): string {
  const signedPath = join(directory, SIGNED_ARTIFACT);
  if (existsSync(signedPath)) {
    return createHash("sha256").update(readFileSync(signedPath)).digest("hex");
  }
  return sha256WriteOnceBody(signed);
}

/**
 * Productive one-shot send. Never imports signing/key APIs.
 */
export async function sendAuthorizedPaymentOnce(
  input: SendAuthorizedPaymentOnceInput,
): Promise<SendAuthorizedPaymentOnceResult> {
  void GUARD_NO_PAYMENT_HEADER_SECRET_LEAKAGE;
  void GUARD_SEND_IMPLEMENTATION_AVAILABLE_NOT_AUTHORIZATION;

  const psa = assertExactDerivedPaymentSendAuthorization(input.paymentSendAuthorization);
  const psaSha = paymentSendAuthorizationSha256(psa);
  const unsignedCanonicalSha = sha256CanonicalArtifact(input.unsignedArtifact);
  const signedArtifactSha = resolveSignedArtifactSha256(input.directory, input.signedArtifact);

  validatePaymentSendBinding({
    psa,
    unsigned: input.unsignedArtifact,
    signed: input.signedArtifact,
    observation: input.sellerObservation,
    unsignedCanonicalSha256: unsignedCanonicalSha,
    signedArtifactSha256: signedArtifactSha,
  });

  validatePreSendTemporalWindow({
    psa,
    unsigned: input.unsignedArtifact,
    now: input.now,
  });

  const ledger = input.ledger ?? new BuyerPaymentSendLedger();
  if (!ledger.get(psaSha)) {
    ledger.issueDerived({
      sendAuthorizationSha256: psaSha,
      sendMandateSha256: psa.parent_human_conditional_payment_send_mandate_sha256,
      attemptId: psa.attempt_id,
      now: input.now,
    });
  }

  const current = ledger.get(psaSha)!;
  if (current.state === "AMBIGUOUS_SEND_TERMINAL_RECONCILE") {
    fail(GUARD_NO_RESEND_AFTER_SEND_COMMIT, "ambiguous send is terminal; no resend");
  }
  if (
    current.state === "PAYMENT_REQUEST_INVOKED" ||
    current.state === "RESPONSE_OBSERVED" ||
    current.payment_bearing_request_count >= 1
  ) {
    fail(
      BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST,
      "PaymentSendAuthorization already used for a payment-bearing request",
    );
  }
  // Restart after SEND_COMMITTED without durable response evidence: fail closed.
  // Never resume into a second network attempt for the same PSA.
  if (current.state === "SEND_COMMITTED_NO_RETRY") {
    ledger.markAmbiguous({
      sendAuthorizationSha256: psaSha,
      now: input.now,
      reason: "restart_after_send_commit_before_known_outcome",
    });
    fail(
      GUARD_NO_RESEND_AFTER_SEND_COMMIT,
      `${AMBIGUOUS_SEND_TERMINAL_RECONCILE}: SEND_COMMITTED_NO_RETRY already persisted; no resend`,
    );
  }
  if (current.state === "SEND_AUTHORIZATION_DERIVED") {
    ledger.markValidatedCurrent({ sendAuthorizationSha256: psaSha, now: input.now });
  }

  const header = buildPaymentHeaderFromPersistedSignedArtifact({
    unsignedArtifact: input.unsignedArtifact,
    signedArtifact: input.signedArtifact,
    sellerObservation: input.sellerObservation,
  });

  ledger.commitNoRetry({
    sendAuthorizationSha256: psaSha,
    now: input.now,
    signedArtifactSha256: psa.signed_artifact_sha256,
    requestBindingSha256: psa.request_binding_sha256,
  });

  const commitRecord = ledger.get(psaSha)!;
  if (commitRecord.state !== "SEND_COMMITTED_NO_RETRY") {
    fail(
      BLOCKED_B371_SEND_COMMIT_REQUIRED,
      `expected SEND_COMMITTED_NO_RETRY, got ${commitRecord.state}`,
    );
  }

  if (input.persistArtifacts !== false) {
    const commitPath = join(input.directory, SEND_COMMIT_ARTIFACT);
    if (!existsSync(commitPath)) {
      writeArtifactOnce(commitPath, {
        schema_version: "trustforge_payment_send_commit.v1",
        state: "SEND_COMMITTED_NO_RETRY",
        payment_send_authorization_sha256: psaSha,
        signed_artifact_sha256: psa.signed_artifact_sha256,
        request_binding_sha256: psa.request_binding_sha256,
        attempt_id: psa.attempt_id,
        invocation_ordinal: 1,
        committed_at: input.now.toISOString(),
        bridge_id: B371_PRODUCTIVE_SEND_BRIDGE_ID,
      });
    }
  }

  ledger.assertMayInvoke(psaSha);
  ledger.markInvoked({ sendAuthorizationSha256: psaSha, now: input.now });

  const prepared = buildPreparedRequest({ psa, header });
  const transport = input.transport ?? createFetchPaymentBearingHttpTransport();

  let outcome: PaymentBearingTransportOutcome;
  try {
    outcome = await transport.invokeOnce(prepared);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ledger.markAmbiguous({
      sendAuthorizationSha256: psaSha,
      now: input.now,
      reason: message.split(":")[0] ?? "transport_error",
    });
    throw error;
  }

  if (outcome.kind === "response_observed") {
    ledger.markResponseObserved({
      sendAuthorizationSha256: psaSha,
      now: new Date(),
      notes: `http_${outcome.status}`,
    });
  } else {
    ledger.markAmbiguous({
      sendAuthorizationSha256: psaSha,
      now: input.now,
      reason: outcome.reason,
    });
  }

  if (input.persistArtifacts !== false) {
    const lifePath = join(input.directory, "buyer_payment_send_lifecycle.json");
    if (!existsSync(lifePath)) {
      persistPaymentSendLifecycle(input.directory, ledger.get(psaSha)!);
    }
  }

  const sanitizedOutcome: PaymentBearingTransportOutcome =
    outcome.kind === "response_observed"
      ? {
          kind: "response_observed",
          status: outcome.status,
          redirected: false,
          body_text:
            outcome.body_text.length > 256
              ? `${outcome.body_text.slice(0, 256)}…`
              : outcome.body_text,
          observed_at: outcome.observed_at,
        }
      : outcome;

  return {
    bridge_id: B371_PRODUCTIVE_SEND_BRIDGE_ID,
    payment_send_authorization_sha256: psaSha,
    signed_artifact_sha256: psa.signed_artifact_sha256,
    header_evidence: sanitizeBuiltPaymentHeaderEvidence(header),
    lifecycle: ledger.get(psaSha)!,
    transport_outcome: sanitizedOutcome,
    classification: classifyOutcome(outcome),
    payment_bearing_request_invocations: 1,
    live_external_payment: false,
  };
}

export function loadPersistedBuyerAuthorizationPair(directory: string): {
  readonly unsignedArtifact: UnsignedArtifact;
  readonly signedArtifact: SignedArtifact;
  readonly unsignedCanonicalSha256: string;
  readonly signedFileSha256: string;
} {
  const unsignedPath = join(directory, UNSIGNED_ARTIFACT);
  const signedPath = join(directory, SIGNED_ARTIFACT);
  const unsignedArtifact = JSON.parse(
    readFileSync(unsignedPath, "utf8"),
  ) as UnsignedArtifact;
  const signedArtifact = JSON.parse(readFileSync(signedPath, "utf8")) as SignedArtifact;
  return {
    unsignedArtifact,
    signedArtifact,
    unsignedCanonicalSha256: sha256CanonicalArtifact(unsignedArtifact),
    signedFileSha256: createHash("sha256").update(readFileSync(signedPath)).digest("hex"),
  };
}
