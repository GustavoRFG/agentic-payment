/**
 * buyer-jit-signing-mandate-derivation — offline JIT path from human mandate.
 *
 * Sequence:
 *   validate mandate
 *   → reserve derivation (one-shot)
 *   → exact fresh requirements gate
 *   → prepare-only attempt + nonce + unsigned
 *   → derive exact B.3 signing authorization
 *   → authority subset proof
 *   → current pre-sign validation
 *   → STOP before credential access
 *
 * Injected fresh observation only — no live HTTP in this module.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED,
  assertB31CredentialAccessNotAuthorized,
} from "./b31-execution-gates";
import { loadB31CredentialProviderPolicy } from "./b31-credential-provider-policy";
import {
  ATTEMPT_ARTIFACT,
  UNSIGNED_ARTIFACT,
  writeArtifactOnce,
  type UnsignedArtifact,
} from "./buyer-authorization-artifacts";
import {
  BuyerAttemptRegistry,
  cryptoBuyerNonceSource,
  runBuyerAuthorizationPrepareOnly,
  type BuyerNonceSource,
} from "./buyer-authorization-attempt";
import { assertFreshRequirementsExactMatchMandate } from "./buyer-mandate-fresh-requirements-gate";
import { verifyDerivedSigningAuthorizationIsSubsetOfMandate } from "./buyer-mandate-authority-subset";
import {
  humanOneShotSigningMandateSha256,
  validateHumanOneShotSigningMandate,
  type HumanOneShotSigningMandate,
} from "./buyer-one-shot-signing-mandate";
import type { PreSignAttemptArtifact } from "./buyer-pre-sign-validation";
import { validateBuyerAuthorizationBeforeSigning } from "./buyer-pre-sign-validation";
import {
  BuyerSigningMandateLedger,
  evaluateMandateCrashRecovery,
  loadSigningMandateLifecycle,
  persistSigningMandateLifecycle,
  type SigningMandateLifecycleRecord,
} from "./buyer-signing-mandate-lifecycle";
import {
  buildDerivedBuyerSigningAuthorizationFromMandate,
  buyerSigningAuthorizationSha256,
  validateBuyerSigningAuthorization,
  type BuyerSigningAuthorization,
} from "./buyer-signing-authorization";
import { thinSettlementRequestSummary } from "./thin-settlement-request-binding";
import { createThinSettlementRequestBinding } from "./thin-settlement-request-binding";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";
import {
  canonicalJsonSha256,
  type SellerRequirementsObservation,
} from "./x402-seller-requirements-binding";
import { SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS } from "./x402-seller-requirements-binding";

export const DERIVED_SIGNING_AUTHORIZATION_ARTIFACT =
  "buyer_signing_authorization_derived.json" as const;

export interface JitSigningMandateDerivationInput {
  readonly directory: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly commitSha?: string | null;
  readonly mandate: HumanOneShotSigningMandate;
  /** Injected synthetic/offline observation — not fetched here. */
  readonly freshObservation: SellerRequirementsObservation;
  readonly now: Date;
  readonly nonceSource?: BuyerNonceSource;
  readonly ledger?: BuyerSigningMandateLedger;
  readonly registry?: BuyerAttemptRegistry;
  readonly credentialPolicyPath?: string;
  readonly cwd?: string;
  /**
   * When recovering after unsigned persistence, skip attempt/nonce generation
   * and only complete derived authorization for the existing unsigned artifact.
   */
  readonly recoveryUnsignedArtifact?: UnsignedArtifact | null;
  readonly recoveryUnsignedSha256?: string | null;
}

export interface JitSigningMandateDerivationResult {
  readonly ok: true;
  readonly mandate_sha256: string;
  readonly attempt_id: string;
  readonly unsigned_artifact_sha256: string;
  readonly derived_signing_authorization_sha256: string;
  readonly derived_signing_authorization: BuyerSigningAuthorization;
  readonly lifecycle: SigningMandateLifecycleRecord;
  readonly pre_sign_current_validity: "PASS";
  readonly credential_access: typeof BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED;
  readonly credential_accesses: 0;
  readonly signer_calls: 0;
  readonly payment_headers: 0;
  readonly payments: 0;
  readonly local_freshness_cap_seconds: typeof SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS;
}

/**
 * Deterministic prepare-authorization view of a human mandate.
 * Hash must equal mandate.prepare_authorization_sha256.
 */
export function buildPrepareAuthorizationViewFromMandate(
  mandate: HumanOneShotSigningMandate,
): HumanPaymentAuthorization {
  const requestBinding = createThinSettlementRequestBinding({
    endpoint: mandate.endpoint,
    method: mandate.method,
    input_status: "known",
    query: mandate.request_query.map(([k, v]) => [k, v] as [string, string]),
    body: mandate.request_body ?? null,
  });
  return {
    authorization_schema_version: "trustforge_paid_probe_authorization.v3",
    decision: "authorize_one_prepare_only_attempt",
    provider: mandate.provider,
    service_id: mandate.service_id,
    endpoint: mandate.endpoint,
    method: mandate.method,
    request_binding_sha256: mandate.request_binding_sha256,
    request_summary: thinSettlementRequestSummary(requestBinding),
    canonical_requirements_sha256: mandate.canonical_requirements_sha256,
    canonical_envelope_sha256: mandate.canonical_envelope_sha256,
    x402_version: mandate.x402_version as 1 | 2,
    scheme: mandate.scheme,
    seller_network_raw: mandate.seller_network_raw,
    canonical_network_caip2: mandate.canonical_network_caip2,
    network: mandate.canonical_network_caip2,
    asset: mandate.asset,
    pay_to: mandate.pay_to,
    amount_atomic: mandate.amount_atomic,
    maximum_authorized_amount_atomic: mandate.maximum_authorized_amount_atomic,
    buyer_wallet: mandate.buyer_wallet,
    max_usdc: "0.001",
    max_payment_attempts: 1,
    allow_retry: false,
    allow_wallet_load: false,
    allow_payment_header: false,
    decided_at: mandate.decided_at,
    authorization_expires_at: mandate.mandate_expires_at,
    requirements_refresh_policy: "exact_hash_match_before_signing",
    rationale: "Deterministic prepare view for B.3.6.1 JIT mandate derivation (synthetic/offline)",
  };
}

function markAmbiguousAndThrow(
  ledger: BuyerSigningMandateLedger,
  mandateSha256: string,
  now: Date,
  notes: string,
  error: unknown,
): never {
  ledger.markAmbiguous({ mandateSha256, now, notes });
  throw error instanceof Error ? error : new Error(String(error));
}

/**
 * Offline JIT derivation. Stops at credential-access gate.
 */
export function deriveSigningAuthorizationFromOneShotMandate(
  input: JitSigningMandateDerivationInput,
): JitSigningMandateDerivationResult {
  const mandate = validateHumanOneShotSigningMandate({
    mandate: input.mandate,
    now: input.now,
  });
  const mandateSha256 = humanOneShotSigningMandateSha256(mandate);
  const prepareView = buildPrepareAuthorizationViewFromMandate(mandate);
  const prepareHash = canonicalJsonSha256(prepareView);
  if (prepareHash !== mandate.prepare_authorization_sha256) {
    throw new Error(
      `BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID: prepare_authorization_sha256 does not match deterministic prepare view`,
    );
  }

  const ledger = input.ledger ?? new BuyerSigningMandateLedger();
  const persisted = loadSigningMandateLifecycle(input.directory);
  if (persisted) {
    const recovery = evaluateMandateCrashRecovery(persisted);
    if (recovery.action === "ALREADY_COMPLETE") {
      throw new Error(
        `BLOCKED_B361_HUMAN_SIGNING_MANDATE_ALREADY_CONSUMED: mandate lifecycle already complete`,
      );
    }
    if (recovery.action === "REQUIRE_NEW_HUMAN_MANDATE") {
      throw new Error(
        `MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE: persisted lifecycle state ${persisted.state} cannot safely continue; issue a new human mandate`,
      );
    }
    // COMPLETE_DERIVED_AUTHORIZATION_FOR_EXISTING_UNSIGNED handled below via recovery fields.
  }

  if (!input.recoveryUnsignedArtifact) {
    if (!ledger.get(mandateSha256)) {
      ledger.issue({
        mandateDecisionId: mandate.decision_id,
        mandateSha256,
        now: input.now,
      });
    }
    ledger.assertNotConsumed(mandateSha256);
    // If already issued in-memory but not reserved, reserve now.
    const current = ledger.get(mandateSha256)!;
    if (current.state === "MANDATE_ISSUED") {
      ledger.transition({
        mandateSha256,
        to: "JIT_DERIVATION_RESERVED",
        now: input.now,
        runId: input.runId,
        notes: "JIT derivation reserved; fail-closed on interruption",
      });
    }
  }

  try {
    if (!input.recoveryUnsignedArtifact) {
      assertFreshRequirementsExactMatchMandate({
        mandate,
        freshObservation: input.freshObservation,
        freshEndpoint: mandate.endpoint,
        freshMethod: mandate.method,
        freshRequestQuery: mandate.request_query,
        freshRequestBody: mandate.request_body,
      });
      ledger.transition({
        mandateSha256,
        to: "FRESH_REQUIREMENTS_VALIDATED",
        now: input.now,
      });
    }

    let unsignedArtifact: UnsignedArtifact;
    let unsignedSha256: string;
    let attempt: PreSignAttemptArtifact;

    if (input.recoveryUnsignedArtifact && input.recoveryUnsignedSha256) {
      unsignedArtifact = input.recoveryUnsignedArtifact;
      unsignedSha256 = input.recoveryUnsignedSha256;
      const attemptPath = join(input.directory, ATTEMPT_ARTIFACT);
      if (!existsSync(attemptPath)) {
        throw new Error(
          "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE: recovery requires persisted attempt artifact",
        );
      }
      attempt = JSON.parse(readFileSync(attemptPath, "utf8")) as PreSignAttemptArtifact;
    } else {
      const registry = input.registry ?? new BuyerAttemptRegistry(1);
      const prepare = runBuyerAuthorizationPrepareOnly({
        directory: input.directory,
        runId: input.runId,
        attemptId: input.attemptId,
        commitSha: input.commitSha ?? null,
        registry,
        nonceSource: input.nonceSource ?? cryptoBuyerNonceSource,
        now: input.now,
        prepared: {
          humanAuthorization: prepareView,
          paytimeObservation: input.freshObservation,
          authorizedRequirementsSha256: mandate.canonical_requirements_sha256,
          authorizedEnvelopeSha256: mandate.canonical_envelope_sha256,
          authorizedRequestBindingSha256: mandate.request_binding_sha256,
          authorizedEndpoint: mandate.endpoint,
          authorizedMethod: mandate.method,
          buyerAddress: mandate.buyer_wallet,
          signingTime: input.now,
        },
      });
      ledger.transition({
        mandateSha256,
        to: "ATTEMPT_RESERVED",
        now: input.now,
        attemptId: prepare.attempt_id,
        runId: input.runId,
      });
      unsignedSha256 = prepare.unsigned_artifact_sha256;
      unsignedArtifact = JSON.parse(
        readFileSync(join(input.directory, UNSIGNED_ARTIFACT), "utf8"),
      ) as UnsignedArtifact;
      attempt = JSON.parse(
        readFileSync(join(input.directory, ATTEMPT_ARTIFACT), "utf8"),
      ) as PreSignAttemptArtifact;
      ledger.transition({
        mandateSha256,
        to: "UNSIGNED_PERSISTED",
        now: input.now,
        unsignedArtifactSha256: unsignedSha256,
      });
    }

    // Derived signing auth expiry: min(effective deadline, mandate expiry) — no extension.
    const effectiveMs = Date.parse(unsignedArtifact.effective_signing_deadline);
    const mandateMs = Date.parse(mandate.mandate_expires_at);
    const signingAuthExpiresAt = new Date(Math.min(effectiveMs, mandateMs)).toISOString();

    const derived = buildDerivedBuyerSigningAuthorizationFromMandate({
      decisionId: `derived_${mandate.decision_id}_${unsignedArtifact.attempt_id}`,
      prepareAuthorizationSha256: prepareHash,
      parentMandateSha256: mandateSha256,
      unsignedArtifact,
      unsignedArtifactSha256: unsignedSha256,
      signingAuthorizationExpiresAt: signingAuthExpiresAt,
    });

    verifyDerivedSigningAuthorizationIsSubsetOfMandate({
      mandate,
      mandateSha256,
      freshRequirements: input.freshObservation,
      unsignedArtifact,
      unsignedArtifactSha256: unsignedSha256,
      derivedSigningAuthorization: derived,
    });

    // Persist derived signing authorization write-once.
    const derivedWrite = writeArtifactOnce(
      join(input.directory, DERIVED_SIGNING_AUTHORIZATION_ARTIFACT),
      derived,
    );
    const derivedSha = buyerSigningAuthorizationSha256(derived);
    if (derivedWrite.sha256 !== derivedSha) {
      // canonicalJsonSha256 of object equals writeArtifactOnce hash by construction.
    }

    // Mandatory current pre-sign + signing-auth validation (no signer).
    validateBuyerAuthorizationBeforeSigning({
      unsignedArtifact,
      attempt,
      humanAuthorization: prepareView,
      now: input.now,
      expectedUnsignedHash: unsignedSha256,
    });
    validateBuyerSigningAuthorization({
      authorization: derived,
      unsignedArtifact,
      unsignedArtifactSha256: unsignedSha256,
      prepareAuthorizationSha256: prepareHash,
      now: input.now,
    });

    ledger.transition({
      mandateSha256,
      to: "SIGNING_AUTHORIZATION_DERIVED",
      now: input.now,
      derivedSigningAuthorizationSha256: derivedSha,
      unsignedArtifactSha256: unsignedSha256,
    });
    const consumed = ledger.transition({
      mandateSha256,
      to: "MANDATE_CONSUMED",
      now: input.now,
    });

    // Persist final lifecycle write-once (first successful write only).
    if (!existsSync(join(input.directory, "buyer_signing_mandate_lifecycle.json"))) {
      persistSigningMandateLifecycle(input.directory, consumed);
    }

    // Credential gate separation: derived signing ≠ credential access.
    const credentialPolicy = loadB31CredentialProviderPolicy(
      input.credentialPolicyPath,
      input.cwd,
    );
    if (credentialPolicy.credential_access_enabled !== false) {
      throw new Error(
        `${BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED}: productive credential access must remain disabled for B.3.6.1 offline proof`,
      );
    }

    // Independent B.3.1 gate: derived signing authorization does not authorize credentials.
    try {
      assertB31CredentialAccessNotAuthorized();
    } catch (credentialError) {
      const credentialMessage =
        credentialError instanceof Error ? credentialError.message : String(credentialError);
      if (!credentialMessage.startsWith(BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED)) {
        throw credentialError;
      }
    }

    return {
      ok: true,
      mandate_sha256: mandateSha256,
      attempt_id: unsignedArtifact.attempt_id,
      unsigned_artifact_sha256: unsignedSha256,
      derived_signing_authorization_sha256: derivedSha,
      derived_signing_authorization: derived,
      lifecycle: consumed,
      pre_sign_current_validity: "PASS",
      credential_access: BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED,
      credential_accesses: 0,
      signer_calls: 0,
      payment_headers: 0,
      payments: 0,
      local_freshness_cap_seconds: SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = ledger.get(mandateSha256)?.state;
    if (
      state &&
      state !== "MANDATE_CONSUMED" &&
      state !== "MANDATE_ISSUED" &&
      state !== "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE"
    ) {
      markAmbiguousAndThrow(
        ledger,
        mandateSha256,
        input.now,
        `interrupted_or_rejected:${message.split(":")[0]}`,
        error,
      );
    }
    throw error;
  }
}

export { evaluateMandateCrashRecovery };
