/**
 * buyer-conditional-credential-signing-derivation — offline B.3.6.3 JIT path.
 *
 * Human conditional mandate → exact fresh 402 → attempt/nonce/unsigned →
 * derived SigningAuthorization → derived CredentialAccessAuthorization →
 * current validation. Optional synthetic credential-gated sign stops at send gate.
 *
 * Injected observation / synthetic TTY only — no live HTTP, no operational keys.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED } from "./b3-execution-gates";
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
import {
  buildDerivedBuyerCredentialAccessAuthorizationFromConditionalMandate,
  buyerCredentialAccessAuthorizationSha256,
  validateBuyerCredentialAccessAuthorization,
  type BuyerCredentialAccessAuthorization,
} from "./buyer-credential-access-authorization";
import { runCredentialGatedBuyerSigning } from "./buyer-credential-gated-signing";
import {
  humanConditionalCredentialSigningMandateSha256,
  validateHumanConditionalCredentialSigningMandate,
  type HumanConditionalCredentialSigningMandate,
} from "./buyer-conditional-credential-signing-mandate";
import { verifyDualAuthoritySubsetOfConditionalMandate } from "./buyer-conditional-mandate-authority-subset";
import {
  BuyerConditionalMandateLedger,
  evaluateConditionalMandateCrashRecovery,
  loadConditionalMandateLifecycle,
  persistConditionalMandateLifecycle,
  type ConditionalMandateLifecycleRecord,
} from "./buyer-conditional-mandate-lifecycle";
import type { HiddenTtyTerminal } from "./buyer-hidden-tty-terminal";
import type { WindowsMaskedSecretDialog } from "./buyer-windows-masked-secret-dialog";
import { assertFreshRequirementsExactMatchConditionalMandate } from "./buyer-mandate-fresh-requirements-gate";
import type { PreSignAttemptArtifact } from "./buyer-pre-sign-validation";
import { validateBuyerAuthorizationBeforeSigning } from "./buyer-pre-sign-validation";
import {
  buildDerivedBuyerSigningAuthorizationFromConditionalMandate,
  buyerSigningAuthorizationSha256,
  validateBuyerSigningAuthorization,
  type BuyerSigningAuthorization,
} from "./buyer-signing-authorization";
import type { BuyerCredentialProvider } from "./buyer-credential-provider";
import {
  createThinSettlementRequestBinding,
  thinSettlementRequestSummary,
} from "./thin-settlement-request-binding";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";
import {
  canonicalJsonSha256,
  SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS,
  type SellerRequirementsObservation,
} from "./x402-seller-requirements-binding";
import { GUARD_SIGNING_DOES_NOT_AUTHORIZE_SEND } from "./b363-execution-gates";

export const DERIVED_SIGNING_AUTHORIZATION_ARTIFACT =
  "buyer_signing_authorization_derived.json" as const;
export const DERIVED_CREDENTIAL_ACCESS_AUTHORIZATION_ARTIFACT =
  "buyer_credential_access_authorization_derived.json" as const;

export function buildPrepareAuthorizationViewFromConditionalMandate(
  mandate: HumanConditionalCredentialSigningMandate,
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
    rationale:
      "Deterministic prepare view for B.3.6.3 conditional credential+signing mandate (synthetic/offline)",
  };
}

export function assertSigningDoesNotAuthorizeSend(
  auth: BuyerSigningAuthorization,
): void {
  if (
    auth.payment_bearing_send_authorized !== false ||
    auth.settlement_authorized !== false
  ) {
    throw new Error(
      `${GUARD_SIGNING_DOES_NOT_AUTHORIZE_SEND}: real signing authorization does not imply payment authorization`,
    );
  }
}

export interface ConditionalCredentialSigningDerivationInput {
  readonly directory: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly commitSha?: string | null;
  readonly mandate: HumanConditionalCredentialSigningMandate;
  readonly freshObservation: SellerRequirementsObservation;
  readonly now: Date;
  readonly nonceSource?: BuyerNonceSource;
  readonly ledger?: BuyerConditionalMandateLedger;
  readonly registry?: BuyerAttemptRegistry;
  readonly cwd?: string;
  readonly credentialPolicyPath?: string;
}

export interface ConditionalCredentialSigningDerivationResult {
  readonly ok: true;
  readonly mandate_sha256: string;
  readonly attempt_id: string;
  readonly unsigned_artifact_sha256: string;
  readonly derived_signing_authorization_sha256: string;
  readonly derived_credential_access_authorization_sha256: string;
  readonly derived_signing_authorization: BuyerSigningAuthorization;
  readonly derived_credential_access_authorization: BuyerCredentialAccessAuthorization;
  readonly lifecycle: ConditionalMandateLifecycleRecord;
  readonly pre_sign_current_validity: "PASS";
  readonly authority_subset: "PASS";
  readonly local_freshness_cap_seconds: typeof SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS;
}

function markAmbiguousAndThrow(
  ledger: BuyerConditionalMandateLedger,
  mandateSha256: string,
  now: Date,
  notes: string,
  error: unknown,
): never {
  ledger.markAmbiguous({ mandateSha256, now, notes });
  throw error instanceof Error ? error : new Error(String(error));
}

/**
 * Offline derivation through credential-access authorization persistence.
 * Does not invoke TTY/provider/signer.
 */
export function deriveConditionalCredentialSigningArtifacts(
  input: ConditionalCredentialSigningDerivationInput,
): ConditionalCredentialSigningDerivationResult {
  const mandate = validateHumanConditionalCredentialSigningMandate({
    mandate: input.mandate,
    now: input.now,
  });
  const mandateSha256 = humanConditionalCredentialSigningMandateSha256(mandate);
  const prepareView = buildPrepareAuthorizationViewFromConditionalMandate(mandate);
  const prepareHash = canonicalJsonSha256(prepareView);
  if (prepareHash !== mandate.prepare_authorization_sha256) {
    throw new Error(
      "BLOCKED_B363_CONDITIONAL_MANDATE_INVALID: prepare_authorization_sha256 mismatch",
    );
  }

  const ledger = input.ledger ?? new BuyerConditionalMandateLedger();
  const persisted = loadConditionalMandateLifecycle(input.directory);
  if (persisted) {
    const recovery = evaluateConditionalMandateCrashRecovery(persisted);
    if (recovery.action === "ALREADY_COMPLETE") {
      throw new Error(
        "BLOCKED_B363_CONDITIONAL_MANDATE_ALREADY_CONSUMED: mandate lifecycle already complete",
      );
    }
    if (recovery.action === "REQUIRE_NEW_HUMAN_MANDATE") {
      throw new Error(
        "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE: persisted lifecycle cannot safely continue",
      );
    }
  }

  if (!ledger.get(mandateSha256)) {
    ledger.issue({
      mandateDecisionId: mandate.decision_id,
      mandateSha256,
      now: input.now,
    });
  }
  ledger.assertNotConsumed(mandateSha256);
  const current = ledger.get(mandateSha256)!;
  if (current.state === "MANDATE_ISSUED") {
    ledger.transition({
      mandateSha256,
      to: "JIT_DERIVATION_RESERVED",
      now: input.now,
      runId: input.runId,
    });
  }

  try {
    assertFreshRequirementsExactMatchConditionalMandate({
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

    const unsignedSha256 = prepare.unsigned_artifact_sha256;
    const unsignedArtifact = JSON.parse(
      readFileSync(join(input.directory, UNSIGNED_ARTIFACT), "utf8"),
    ) as UnsignedArtifact;
    const attempt = JSON.parse(
      readFileSync(join(input.directory, ATTEMPT_ARTIFACT), "utf8"),
    ) as PreSignAttemptArtifact;
    ledger.transition({
      mandateSha256,
      to: "UNSIGNED_PERSISTED",
      now: input.now,
      unsignedArtifactSha256: unsignedSha256,
    });

    const effectiveMs = Date.parse(unsignedArtifact.effective_signing_deadline);
    const mandateMs = Date.parse(mandate.mandate_expires_at);
    const signingAuthExpiresAt = new Date(Math.min(effectiveMs, mandateMs)).toISOString();

    const derivedSigning = buildDerivedBuyerSigningAuthorizationFromConditionalMandate({
      decisionId: `derived_sign_${mandate.decision_id}_${unsignedArtifact.attempt_id}`,
      prepareAuthorizationSha256: prepareHash,
      parentConditionalMandateSha256: mandateSha256,
      unsignedArtifact,
      unsignedArtifactSha256: unsignedSha256,
      signingAuthorizationExpiresAt: signingAuthExpiresAt,
    });
    assertSigningDoesNotAuthorizeSend(derivedSigning);
    const signingSha = buyerSigningAuthorizationSha256(derivedSigning);
    writeArtifactOnce(join(input.directory, DERIVED_SIGNING_AUTHORIZATION_ARTIFACT), derivedSigning);
    ledger.transition({
      mandateSha256,
      to: "SIGNING_AUTHORIZATION_DERIVED",
      now: input.now,
      derivedSigningAuthorizationSha256: signingSha,
    });

    const accessExpiresAt = new Date(
      Math.min(
        effectiveMs,
        Date.parse(derivedSigning.signing_authorization_expires_at),
        mandateMs,
      ),
    ).toISOString();
    const derivedCredential =
      buildDerivedBuyerCredentialAccessAuthorizationFromConditionalMandate({
        decisionId: `derived_cred_${mandate.decision_id}_${unsignedArtifact.attempt_id}`,
        parentConditionalMandateSha256: mandateSha256,
        signingAuthorization: derivedSigning,
        signingAuthorizationSha256: signingSha,
        unsignedArtifact,
        unsignedArtifactSha256: unsignedSha256,
        accessExpiresAt,
        secretEntryMechanism: mandate.secret_entry_mechanism,
      });
    const credentialSha = buyerCredentialAccessAuthorizationSha256(derivedCredential);
    writeArtifactOnce(
      join(input.directory, DERIVED_CREDENTIAL_ACCESS_AUTHORIZATION_ARTIFACT),
      derivedCredential,
    );

    verifyDualAuthoritySubsetOfConditionalMandate({
      mandate,
      mandateSha256,
      freshRequirements: input.freshObservation,
      unsignedArtifact,
      unsignedArtifactSha256: unsignedSha256,
      derivedSigningAuthorization: derivedSigning,
      signingAuthorizationSha256: signingSha,
      derivedCredentialAccessAuthorization: derivedCredential,
    });

    validateBuyerAuthorizationBeforeSigning({
      unsignedArtifact,
      attempt,
      humanAuthorization: prepareView,
      now: input.now,
      expectedUnsignedHash: unsignedSha256,
    });
    validateBuyerSigningAuthorization({
      authorization: derivedSigning,
      unsignedArtifact,
      unsignedArtifactSha256: unsignedSha256,
      prepareAuthorizationSha256: prepareHash,
      now: input.now,
    });
    validateBuyerCredentialAccessAuthorization({
      authorization: derivedCredential,
      signingAuthorization: derivedSigning,
      signingAuthorizationSha256: signingSha,
      unsignedArtifact,
      unsignedArtifactSha256: unsignedSha256,
      providerId: mandate.credential_provider_id,
      credentialKind: mandate.credential_kind,
      expectedSignerAddress: mandate.buyer_wallet,
      now: input.now,
    });

    ledger.transition({
      mandateSha256,
      to: "CREDENTIAL_AUTHORIZATION_DERIVED",
      now: input.now,
      derivedCredentialAccessAuthorizationSha256: credentialSha,
    });
    const consumed = ledger.transition({
      mandateSha256,
      to: "MANDATE_CONSUMED",
      now: input.now,
    });
    if (!existsSync(join(input.directory, "buyer_conditional_mandate_lifecycle.json"))) {
      persistConditionalMandateLifecycle(input.directory, consumed);
    }

    return {
      ok: true,
      mandate_sha256: mandateSha256,
      attempt_id: unsignedArtifact.attempt_id,
      unsigned_artifact_sha256: unsignedSha256,
      derived_signing_authorization_sha256: signingSha,
      derived_credential_access_authorization_sha256: credentialSha,
      derived_signing_authorization: derivedSigning,
      derived_credential_access_authorization: derivedCredential,
      lifecycle: consumed,
      pre_sign_current_validity: "PASS",
      authority_subset: "PASS",
      local_freshness_cap_seconds: SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS,
    };
  } catch (error) {
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
        `interrupted_or_rejected:${String(error).split(":")[0]}`,
        error,
      );
    }
    throw error;
  }
}

/**
 * Synthetic-only end-to-end: derived artifacts → hidden TTY → pipe → runtime-key
 * → one signature → SEND GATE. Requires access-enabled policy override for tests.
 */
export async function runSyntheticConditionalMandateSignToSendGate(input: {
  readonly directory: string;
  readonly derivation: ConditionalCredentialSigningDerivationResult;
  readonly mandate: HumanConditionalCredentialSigningMandate;
  readonly now: Date;
  readonly provider: BuyerCredentialProvider;
  readonly secretEntryTerminal?: HiddenTtyTerminal;
  readonly windowsMaskedSecretDialog?: WindowsMaskedSecretDialog;
  readonly credentialPolicyPath: string;
  readonly cwd?: string;
}): Promise<{
  readonly terminal: typeof BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED;
  readonly signer_calls: 1;
  readonly payment_headers: 0;
}> {
  const prepareView = buildPrepareAuthorizationViewFromConditionalMandate(input.mandate);
  const attempt = JSON.parse(
    readFileSync(join(input.directory, ATTEMPT_ARTIFACT), "utf8"),
  ) as PreSignAttemptArtifact;
  const unsignedArtifact = JSON.parse(
    readFileSync(join(input.directory, UNSIGNED_ARTIFACT), "utf8"),
  ) as UnsignedArtifact;

  assertSigningDoesNotAuthorizeSend(input.derivation.derived_signing_authorization);

  try {
    await runCredentialGatedBuyerSigning({
      directory: input.directory,
      unsignedArtifact,
      attempt,
      humanAuthorization: prepareView,
      signingAuthorization: input.derivation.derived_signing_authorization,
      credentialAccessAuthorization:
        input.derivation.derived_credential_access_authorization,
      now: input.now,
      nowAtSign: input.now,
      provider: input.provider,
      secretEntryTerminal: input.secretEntryTerminal,
      windowsMaskedSecretDialog: input.windowsMaskedSecretDialog,
      credentialPolicyPath: input.credentialPolicyPath,
      cwd: input.cwd,
      expectedUnsignedHash: input.derivation.unsigned_artifact_sha256,
      returnBeforeSendGateThrow: false,
    });
    throw new Error("UNEXPECTED_SEND_SUCCEEDED");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED)) {
      throw error;
    }
  }
  return {
    terminal: BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED,
    signer_calls: 1,
    payment_headers: 0,
  };
}
