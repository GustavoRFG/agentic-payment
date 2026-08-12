/**
 * thin-mainnet-payment-runner — B.4 orchestrator over existing payment core.
 *
 * Pluggable custody (credential provider) + human decision UX; does not bypass
 * PSA derivation or allow send retry.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BLOCKED_B4_APPROVAL_REQUIRED,
  BLOCKED_B4_HUMAN_DECISION_ABORTED,
  BLOCKED_B4_HUMAN_DECISION_UI_FAILED,
  BLOCKED_B4_HUMAN_REJECTED,
  GUARD_HUMAN_REJECT_CANNOT_REACH_SIGNER,
  GUARD_THIN_RUNNER_CANNOT_BYPASS_PSA,
  GUARD_THIN_RUNNER_CANNOT_RETRY_SEND,
  B4_PROTECTED_SIGNER_CREDENTIAL_KIND,
  B4_PROTECTED_SIGNER_PROVIDER_ID,
  B4_PROTECTED_VAULT_SECRET_ENTRY,
} from "./b4-execution-gates";
import {
  ATTEMPT_ARTIFACT,
  SIGNED_ARTIFACT,
  UNSIGNED_ARTIFACT,
  type SignedArtifact,
  type UnsignedArtifact,
} from "./buyer-authorization-artifacts";
import {
  buildPrepareAuthorizationViewFromConditionalMandate,
  deriveConditionalCredentialSigningArtifacts,
} from "./buyer-conditional-credential-signing-derivation";
import {
  buildSyntheticHumanConditionalCredentialSigningMandate,
  type ConditionalCredentialKind,
  type ConditionalCredentialProviderId,
  type HumanConditionalCredentialSigningMandate,
} from "./buyer-conditional-credential-signing-mandate";
import {
  buildSyntheticHumanConditionalPaymentSendMandate,
  type HumanConditionalPaymentSendMandate,
} from "./buyer-conditional-payment-send-mandate";
import { derivePaymentSendAuthorization } from "./buyer-conditional-payment-send-derivation";
import { runCredentialGatedBuyerSigning } from "./buyer-credential-gated-signing";
import type { BuyerCredentialProvider } from "./buyer-credential-provider";
import type { PaymentBearingHttpTransport } from "./buyer-payment-bearing-http-transport";
import type { PreSignAttemptArtifact } from "./buyer-pre-sign-validation";
import {
  B35_SECRET_ENTRY_MECHANISM,
  B352_SECRET_ENTRY_MECHANISM,
  type SecretEntryMechanism,
} from "./buyer-secret-entry-mechanism";
import type { WindowsMaskedSecretDialog } from "./buyer-windows-masked-secret-dialog";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import {
  extractAndSanitizeFacilitatorReceipt,
} from "./facilitator-settlement-receipt";
import {
  compareRunnerAgainstGoldenTrace,
  type GoldenTraceStructuralComparison,
} from "./first-mainnet-payment-golden-trace";
import {
  type HumanPaymentDecisionProvider,
  type PaymentApprovalCandidateView,
} from "./human-payment-decision-provider";
import {
  runPaidQuoteFreshnessPreflight,
  type AuthorizedPaymentQuote,
} from "./paid-quote-freshness-preflight";
import { sendAuthorizedPaymentOnce } from "./buyer-productive-one-shot-payment-sender";
import {
  createThinSettlementRequestBinding,
  thinSettlementRequestSummary,
} from "./thin-settlement-request-binding";
import {
  createRunnerState,
  evaluateRunnerCrashRecovery,
  loadRunnerState,
  persistRunnerState,
  transitionRunnerState,
  type ThinMainnetRunnerStateRecord,
} from "./thin-mainnet-runner-state";
import { verifyBaseUsdcPayment } from "./verify-base-usdc-payment";
import {
  canonicalJsonSha256,
  type SellerRequirementsObservation,
} from "./x402-seller-requirements-binding";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "./explicit-runtime-key-credential-provider";
import type { HiddenTtyTerminal } from "./buyer-hidden-tty-terminal";

const DEFAULT_MANDATE_TTL_MS = 900_000;

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function candidateRequestQuery(
  selected: DiscoveredSelectedCandidate,
): ReadonlyArray<readonly [string, string]> {
  return selected.request_query.map(([k, v]) => [k, v] as const);
}

export function buildAuthorizedQuoteFromSelectedCandidate(
  selected: DiscoveredSelectedCandidate,
): AuthorizedPaymentQuote {
  const method = (selected.method ?? "GET") as "GET" | "POST";
  const request_binding = createThinSettlementRequestBinding({
    endpoint: selected.endpoint,
    method,
    input_status: "known",
    query: selected.request_query.map(([k, v]) => [k, v] as [string, string]),
    body: selected.request_body ?? null,
  });
  if (request_binding.binding_sha256 !== selected.request_binding_sha256) {
    fail(
      "BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH",
      "selected candidate request_binding_sha256 does not match recomputed binding",
    );
  }
  return {
    endpoint: selected.endpoint,
    method,
    request_binding,
    seller_requirements: selected.seller_requirements,
    canonical_requirements_sha256: selected.canonical_requirements_sha256,
    canonical_envelope_sha256: selected.canonical_envelope_sha256,
    quote_amount_usdc: selected.quote_amount_usdc,
    quote_atomic: selected.quote_atomic,
    authorized_max_usdc: selected.recommended_max_usdc,
    pay_to: selected.authorized_pay_to,
    seller_network_raw: selected.seller_network_raw,
    canonical_network_caip2: selected.canonical_network_caip2,
    network: selected.network,
    asset: selected.asset,
  };
}

export function buildPaymentApprovalCandidateView(
  selected: DiscoveredSelectedCandidate,
): PaymentApprovalCandidateView {
  const method = (selected.method ?? "GET") as "GET" | "POST";
  const binding = createThinSettlementRequestBinding({
    endpoint: selected.endpoint,
    method,
    input_status: "known",
    query: selected.request_query.map(([k, v]) => [k, v] as [string, string]),
    body: selected.request_body ?? null,
  });
  return {
    service_label: selected.service_id,
    network_label: selected.canonical_network_caip2,
    buyer: selected.buyer_wallet,
    seller: selected.authorized_pay_to,
    amount_usdc: selected.quote_amount_usdc,
    amount_atomic: selected.quote_atomic,
    request_summary: JSON.stringify(thinSettlementRequestSummary(binding)),
    endpoint: selected.endpoint,
    method,
    max_attempts: 1,
    max_signatures: 1,
    max_payment_requests: 1,
    allow_retry: false,
    allow_resend: false,
  };
}

function resolveCredentialMode(provider: BuyerCredentialProvider): {
  readonly credentialProviderId: ConditionalCredentialProviderId;
  readonly credentialKind: ConditionalCredentialKind;
  readonly secretEntryMechanism: SecretEntryMechanism;
} {
  if (provider.providerId === B4_PROTECTED_SIGNER_PROVIDER_ID) {
    return {
      credentialProviderId: B4_PROTECTED_SIGNER_PROVIDER_ID,
      credentialKind: B4_PROTECTED_SIGNER_CREDENTIAL_KIND,
      secretEntryMechanism: B4_PROTECTED_VAULT_SECRET_ENTRY,
    };
  }
  if (provider.providerId === EXPLICIT_RUNTIME_KEY_PROVIDER_ID) {
    return {
      credentialProviderId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
      credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
      secretEntryMechanism:
        process.platform === "win32"
          ? B352_SECRET_ENTRY_MECHANISM
          : B35_SECRET_ENTRY_MECHANISM,
    };
  }
  fail(
    BLOCKED_B4_APPROVAL_REQUIRED,
    `thin runner supports explicit-runtime-key or windows-dpapi-local-signer, got ${provider.providerId}`,
  );
}

function sealSigningMandate(input: {
  readonly decisionId: string;
  readonly selected: DiscoveredSelectedCandidate;
  readonly decidedAt: string;
  readonly mandateExpiresAt: string;
  readonly mode: ReturnType<typeof resolveCredentialMode>;
  readonly freshObservation: SellerRequirementsObservation;
}): HumanConditionalCredentialSigningMandate {
  const selected = input.selected;
  const method = (selected.method ?? "GET") as string;
  const query = candidateRequestQuery(selected);
  const provisional = buildSyntheticHumanConditionalCredentialSigningMandate({
    decisionId: input.decisionId,
    provider: selected.provider,
    serviceId: selected.service_id,
    endpoint: selected.endpoint,
    method,
    requestQuery: query,
    requestBody: selected.request_body ?? null,
    requestBindingSha256: selected.request_binding_sha256,
    x402Version: selected.protocol_version,
    scheme: selected.scheme,
    sellerNetworkRaw: selected.seller_network_raw,
    canonicalNetworkCaip2: selected.canonical_network_caip2,
    asset: selected.asset,
    payTo: selected.authorized_pay_to,
    buyerWallet: selected.buyer_wallet,
    amountAtomic: selected.quote_atomic,
    maximumAuthorizedAmountAtomic: selected.quote_atomic,
    canonicalRequirementsSha256: input.freshObservation.binding.canonical_requirements_sha256,
    canonicalEnvelopeSha256: input.freshObservation.binding.canonical_envelope_sha256,
    prepareAuthorizationSha256: "0".repeat(64),
    decidedAt: input.decidedAt,
    mandateExpiresAt: input.mandateExpiresAt,
    credentialProviderId: input.mode.credentialProviderId,
    credentialKind: input.mode.credentialKind,
    secretEntryMechanism: input.mode.secretEntryMechanism,
  });
  const prepareHash = canonicalJsonSha256(
    buildPrepareAuthorizationViewFromConditionalMandate(provisional),
  );
  return buildSyntheticHumanConditionalCredentialSigningMandate({
    decisionId: provisional.decision_id,
    provider: provisional.provider,
    serviceId: provisional.service_id,
    endpoint: provisional.endpoint,
    method: provisional.method,
    requestQuery: provisional.request_query,
    requestBody: provisional.request_body,
    requestBindingSha256: provisional.request_binding_sha256,
    x402Version: provisional.x402_version,
    scheme: provisional.scheme,
    sellerNetworkRaw: provisional.seller_network_raw,
    canonicalNetworkCaip2: provisional.canonical_network_caip2,
    asset: provisional.asset,
    payTo: provisional.pay_to,
    buyerWallet: provisional.buyer_wallet,
    amountAtomic: provisional.amount_atomic,
    maximumAuthorizedAmountAtomic: provisional.maximum_authorized_amount_atomic,
    canonicalRequirementsSha256: provisional.canonical_requirements_sha256,
    canonicalEnvelopeSha256: provisional.canonical_envelope_sha256,
    prepareAuthorizationSha256: prepareHash,
    decidedAt: provisional.decided_at,
    mandateExpiresAt: provisional.mandate_expires_at,
    credentialProviderId: provisional.credential_provider_id,
    credentialKind: provisional.credential_kind,
    secretEntryMechanism: provisional.secret_entry_mechanism,
  });
}

function sealSendMandate(input: {
  readonly decisionId: string;
  readonly selected: DiscoveredSelectedCandidate;
  readonly decidedAt: string;
  readonly mandateExpiresAt: string;
  readonly freshObservation: SellerRequirementsObservation;
}): HumanConditionalPaymentSendMandate {
  const selected = input.selected;
  return buildSyntheticHumanConditionalPaymentSendMandate({
    decisionId: input.decisionId,
    provider: selected.provider,
    serviceId: selected.service_id,
    endpoint: selected.endpoint,
    method: (selected.method ?? "GET") as string,
    requestQuery: candidateRequestQuery(selected),
    requestBody: selected.request_body ?? null,
    requestBindingSha256: selected.request_binding_sha256,
    x402Version: selected.protocol_version,
    scheme: selected.scheme,
    sellerNetworkRaw: selected.seller_network_raw,
    canonicalNetworkCaip2: selected.canonical_network_caip2,
    asset: selected.asset,
    payTo: selected.authorized_pay_to,
    buyerWallet: selected.buyer_wallet,
    amountAtomic: selected.quote_atomic,
    maximumAuthorizedAmountAtomic: selected.quote_atomic,
    canonicalRequirementsSha256: input.freshObservation.binding.canonical_requirements_sha256,
    canonicalEnvelopeSha256: input.freshObservation.binding.canonical_envelope_sha256,
    decidedAt: input.decidedAt,
    mandateExpiresAt: input.mandateExpiresAt,
  });
}

function persistJson(directory: string, name: string, value: unknown): void {
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

export interface ThinMainnetPaymentRunnerInput {
  readonly directory: string;
  readonly selected: DiscoveredSelectedCandidate;
  readonly decisionProvider: HumanPaymentDecisionProvider;
  readonly credentialProvider: BuyerCredentialProvider;
  readonly transport?: PaymentBearingHttpTransport;
  readonly now?: Date;
  readonly nowAtSign?: Date;
  readonly fetchImpl?: typeof fetch;
  /** Test seam: skip live freshness probe when observation is injected. */
  readonly freshObservation?: SellerRequirementsObservation;
  readonly credentialPolicyPath?: string;
  readonly signerPolicyPath?: string;
  readonly cwd?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly mandateTtlMs?: number;
  readonly windowsMaskedSecretDialog?: WindowsMaskedSecretDialog | null;
  readonly secretEntryTerminal?: HiddenTtyTerminal | null;
  readonly skipOnchainVerify?: boolean;
  readonly nonceSource?: () => `0x${string}`;
}

export interface ThinMainnetPaymentRunnerResult {
  readonly state: ThinMainnetRunnerStateRecord;
  readonly decision: "APPROVE" | "REJECT" | "ABORT" | "UI_FAILED";
  readonly decision_source: string;
  readonly explicit_human_decision: boolean;
  readonly human_decision_id: string;
  readonly signing_mandate: HumanConditionalCredentialSigningMandate | null;
  readonly send_mandate: HumanConditionalPaymentSendMandate | null;
  readonly payment_send_authorization_sha256: string | null;
  readonly signatures: number;
  readonly payment_bearing_requests: number;
  readonly retry: 0;
  readonly resend: 0;
  readonly authority_sequence: readonly string[];
  readonly golden_compare: GoldenTraceStructuralComparison | null;
  readonly onchain_status: string | null;
  readonly facilitator_tx_hash: string | null;
  readonly http_status: number | null;
}

/**
 * Thin operational runner. Never bypasses PSA; never retries send.
 */
export async function runThinMainnetPayment(
  input: ThinMainnetPaymentRunnerInput,
): Promise<ThinMainnetPaymentRunnerResult> {
  void GUARD_THIN_RUNNER_CANNOT_BYPASS_PSA;
  void GUARD_THIN_RUNNER_CANNOT_RETRY_SEND;

  mkdirSync(input.directory, { recursive: true });
  const now = input.now ?? new Date();
  const runId =
    input.runId ??
    input.directory.split(/[\\/]/).filter(Boolean).pop() ??
    `run_${now.getTime()}`;

  const existing = loadRunnerState(input.directory);
  const recovery = evaluateRunnerCrashRecovery({ record: existing });
  if (recovery.disposition === "AMBIGUOUS_RECONCILE_ONLY") {
    fail(
      GUARD_THIN_RUNNER_CANNOT_RETRY_SEND,
      `${recovery.reason}; may_retry_send=false`,
    );
  }
  if (recovery.disposition === "TERMINAL" || recovery.disposition === "RESUME_NOT_ALLOWED") {
    fail("BLOCKED_B4_RUNNER_TERMINAL", recovery.reason);
  }

  let state = existing ?? createRunnerState(runId, now);
  persistRunnerState(input.directory, state);

  const bump = (
    to: Parameters<typeof transitionRunnerState>[1],
    patch?: Parameters<typeof transitionRunnerState>[3],
    clock: Date = now,
  ) => {
    state = transitionRunnerState(state, to, clock, patch);
    persistRunnerState(input.directory, state);
  };

  bump("CANDIDATE_READY");
  bump("HUMAN_DECISION_PENDING");

  const decision = await input.decisionProvider.decideOnce(
    buildPaymentApprovalCandidateView(input.selected),
  );

  persistJson(input.directory, "human_payment_decision.json", {
    decision: decision.decision,
    decision_source: decision.decision_source,
    explicit_human_decision: decision.explicit_human_decision,
    human_decision_id: decision.human_decision_id,
    decided_at: decision.decided_at,
    provider_id: decision.provider_id,
    policy: decision.policy,
  });

  if (decision.decision === "REJECT") {
    bump("HUMAN_REJECTED", { human_decision_id: decision.human_decision_id });
    void GUARD_HUMAN_REJECT_CANNOT_REACH_SIGNER;
    fail(BLOCKED_B4_HUMAN_REJECTED, `human rejected (${decision.decision_source})`);
  }
  if (decision.decision === "ABORT") {
    bump("HUMAN_DECISION_ABORTED", { human_decision_id: decision.human_decision_id });
    fail(
      BLOCKED_B4_HUMAN_DECISION_ABORTED,
      `human decision aborted (${decision.decision_source}); not an explicit REJECT`,
    );
  }
  if (decision.decision === "UI_FAILED") {
    bump("HUMAN_DECISION_UI_FAILED", { human_decision_id: decision.human_decision_id });
    fail(BLOCKED_B4_HUMAN_DECISION_UI_FAILED, "approval UI failed");
  }
  if (decision.decision !== "APPROVE" || !decision.explicit_human_decision) {
    bump("HUMAN_DECISION_UI_FAILED", { human_decision_id: decision.human_decision_id });
    fail(BLOCKED_B4_APPROVAL_REQUIRED, "explicit APPROVE button required");
  }

  bump("HUMAN_APPROVED", { human_decision_id: decision.human_decision_id });
  // Fresh unpaid 402 and JIT window begin ONLY after explicit APPROVE.

  const mode = resolveCredentialMode(input.credentialProvider);
  const mandateExpiresAt = new Date(
    Date.parse(decision.decided_at) + (input.mandateTtlMs ?? DEFAULT_MANDATE_TTL_MS),
  ).toISOString();

  let freshObservation = input.freshObservation ?? null;
  if (!freshObservation) {
    const quote = buildAuthorizedQuoteFromSelectedCandidate(input.selected);
    const preflight = await runPaidQuoteFreshnessPreflight({
      authorized: quote,
      fetchImpl: input.fetchImpl,
      now,
    });
    if (!preflight.go || !preflight.outcome?.sellerRequirements) {
      bump("REQUIREMENTS_CHANGED", {
        notes: preflight.reasons.join(";") || "freshness_failed",
      });
      fail(
        "REQUIREMENTS_CHANGED",
        `fresh 402 preflight failed: ${preflight.reasons.join("; ") || "no 402"}`,
      );
    }
    freshObservation = preflight.outcome.sellerRequirements;
  }

  // Exact hash gate vs selected candidate economics.
  if (
    freshObservation.binding.canonical_requirements_sha256 !==
      input.selected.canonical_requirements_sha256 ||
    freshObservation.binding.canonical_envelope_sha256 !==
      input.selected.canonical_envelope_sha256 ||
    freshObservation.binding.request_binding_sha256 !==
      input.selected.request_binding_sha256
  ) {
    bump("REQUIREMENTS_CHANGED", { notes: "fresh_hash_mismatch" });
    fail("REQUIREMENTS_CHANGED", "fresh unpaid 402 hashes differ from selected candidate");
  }

  bump("FRESH_REQUIREMENTS_VALIDATED");

  const humanDecisionId = decision.human_decision_id;
  const signingMandate = sealSigningMandate({
    decisionId: humanDecisionId,
    selected: input.selected,
    decidedAt: decision.decided_at,
    mandateExpiresAt,
    mode,
    freshObservation,
  });
  const sendMandate = sealSendMandate({
    decisionId: humanDecisionId,
    selected: input.selected,
    decidedAt: decision.decided_at,
    mandateExpiresAt,
    freshObservation,
  });
  persistJson(input.directory, "human_conditional_credential_signing_mandate.json", signingMandate);
  persistJson(input.directory, "human_conditional_payment_send_mandate.json", sendMandate);

  const authority: string[] = [
    "fresh_unpaid_402",
    "exact_requirements_gate",
  ];

  const attemptId = input.attemptId ?? `attempt_${Date.now()}`;
  let derivation;
  try {
    derivation = deriveConditionalCredentialSigningArtifacts({
      directory: input.directory,
      runId,
      attemptId,
      mandate: signingMandate,
      freshObservation,
      now,
      nonceSource: input.nonceSource,
      credentialPolicyPath: input.credentialPolicyPath,
      cwd: input.cwd,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bump("SIGNING_FAILED", { notes: message.split(":")[0] ?? "derive_failed" });
    throw error;
  }

  bump("ATTEMPT_RESERVED", { attempt_id: derivation.attempt_id });
  bump("UNSIGNED_PERSISTED");
  bump("SIGNING_AUTH_DERIVED");
  bump("CREDENTIAL_AUTH_DERIVED");
  authority.push(
    "attempt_nonce_unsigned",
    "BuyerSigningAuthorization",
    "CredentialAccessAuthorization",
  );

  const unsignedArtifact = JSON.parse(
    readFileSync(join(input.directory, UNSIGNED_ARTIFACT), "utf8"),
  ) as UnsignedArtifact;
  const attempt = JSON.parse(
    readFileSync(join(input.directory, ATTEMPT_ARTIFACT), "utf8"),
  ) as PreSignAttemptArtifact;
  const prepareView = buildPrepareAuthorizationViewFromConditionalMandate(signingMandate);

  const useDialog =
    mode.credentialProviderId === EXPLICIT_RUNTIME_KEY_PROVIDER_ID &&
    mode.secretEntryMechanism === B352_SECRET_ENTRY_MECHANISM
      ? input.windowsMaskedSecretDialog
      : null;
  const useTty =
    mode.credentialProviderId === EXPLICIT_RUNTIME_KEY_PROVIDER_ID &&
    mode.secretEntryMechanism === B35_SECRET_ENTRY_MECHANISM
      ? input.secretEntryTerminal
      : null;

  try {
    await runCredentialGatedBuyerSigning({
      directory: input.directory,
      unsignedArtifact,
      attempt,
      humanAuthorization: prepareView,
      signingAuthorization: derivation.derived_signing_authorization,
      credentialAccessAuthorization: derivation.derived_credential_access_authorization,
      now,
      nowAtSign: input.nowAtSign ?? now,
      provider: input.credentialProvider,
      windowsMaskedSecretDialog: useDialog,
      secretEntryTerminal: useTty,
      credentialPolicyPath: input.credentialPolicyPath,
      signerPolicyPath: input.signerPolicyPath,
      cwd: input.cwd,
      expectedUnsignedHash: derivation.unsigned_artifact_sha256,
      returnBeforeSendGateThrow: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/EXPIRED/i.test(message)) {
      bump("SIGNING_EXPIRED", { notes: message.split(":")[0] });
    } else {
      bump("SIGNING_FAILED", { notes: message.split(":")[0] });
    }
    throw error;
  }

  if (!existsSync(join(input.directory, SIGNED_ARTIFACT))) {
    bump("SIGNING_FAILED", { notes: "signed_artifact_missing" });
    fail("SIGNING_FAILED", "signed artifact not persisted");
  }
  bump("SIGNED_PERSISTED");
  authority.push("real_eip3009_signature");

  let psaSha: string;
  let psa;
  try {
    const psaResult = await derivePaymentSendAuthorization({
      directory: input.directory,
      sendMandate,
      signingMandate,
      signingAuthorization: derivation.derived_signing_authorization,
      credentialAccessAuthorization: derivation.derived_credential_access_authorization,
      now,
    });
    psa = psaResult.derived_payment_send_authorization;
    psaSha = psaResult.payment_send_authorization_sha256;
    bump("POST_SIGN_AUDIT_PASS");
    authority.push("POST_SIGN_JIT_AUDIT_PASS");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bump("POST_SIGN_AUDIT_FAILED", { notes: message.split(":")[0] });
    throw error;
  }

  bump("PAYMENT_SEND_AUTH_DERIVED", {
    payment_send_authorization_sha256: psaSha,
  });
  authority.push("PaymentSendAuthorization");

  // Guard: never send without exact PSA artifact binding.
  if (!psa || !psaSha) {
    fail(GUARD_THIN_RUNNER_CANNOT_BYPASS_PSA, "PaymentSendAuthorization required before send");
  }

  const signedArtifact = JSON.parse(
    readFileSync(join(input.directory, SIGNED_ARTIFACT), "utf8"),
  ) as SignedArtifact;

  bump("SEND_COMMITTED_NO_RETRY");
  authority.push("SEND_COMMITTED_NO_RETRY");

  let sendResult;
  try {
    sendResult = await sendAuthorizedPaymentOnce({
      directory: input.directory,
      paymentSendAuthorization: psa,
      unsignedArtifact,
      signedArtifact,
      sellerObservation: freshObservation,
      now,
      transport: input.transport,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/AMBIGUOUS|timeout|redirect/i.test(message)) {
      bump("SEND_AMBIGUOUS_RECONCILE", { notes: message.split(":")[0] });
    } else {
      bump("PAYMENT_FAILED_TERMINAL", { notes: message.split(":")[0] });
    }
    throw error;
  }

  bump("REQUEST_INVOKED");
  authority.push("B371_productive_one_shot_send");

  const httpStatus =
    sendResult.transport_outcome.kind === "response_observed"
      ? sendResult.transport_outcome.status
      : null;

  if (sendResult.classification === "AMBIGUOUS_SEND_TERMINAL_RECONCILE") {
    bump("SEND_AMBIGUOUS_RECONCILE");
    fail("AMBIGUOUS_SEND_TERMINAL_RECONCILE", "send outcome ambiguous; no resend");
  }

  bump("RESPONSE_OBSERVED");
  authority.push("RESPONSE_OBSERVED");

  let facilitatorTx: string | null = null;
  let onchainStatus: string | null = null;
  if (
    sendResult.transport_outcome.kind === "response_observed" &&
    !input.skipOnchainVerify
  ) {
    const receipt = extractAndSanitizeFacilitatorReceipt(
      { headers: new Headers() },
      sendResult.transport_outcome.body_text,
    );
    facilitatorTx = receipt.transactionHash;
    if (facilitatorTx) {
      const verified = await verifyBaseUsdcPayment({
        transactionHash: facilitatorTx,
        expectedAmountUsdc: input.selected.quote_amount_usdc,
        expectedPayTo: input.selected.authorized_pay_to,
        fetchImpl: input.fetchImpl,
      });
      onchainStatus = verified.status;
      if (verified.status === "ONCHAIN_VERIFIED") {
        authority.push("ONCHAIN_VERIFIED");
        bump("RECONCILED");
      }
    }
  }

  bump("CONFIRMED");

  const golden_compare = compareRunnerAgainstGoldenTrace({
    signatures: 1,
    payment_bearing_requests: sendResult.payment_bearing_request_invocations,
    retry: 0,
    resend: 0,
    authority_sequence: authority,
    post_sign_audit_pass: true,
    send_committed: true,
  });

  return {
    state,
    decision: "APPROVE",
    decision_source: decision.decision_source,
    explicit_human_decision: true,
    human_decision_id: humanDecisionId,
    signing_mandate: signingMandate,
    send_mandate: sendMandate,
    payment_send_authorization_sha256: psaSha,
    signatures: 1,
    payment_bearing_requests: sendResult.payment_bearing_request_invocations,
    retry: 0,
    resend: 0,
    authority_sequence: authority,
    golden_compare,
    onchain_status: onchainStatus,
    facilitator_tx_hash: facilitatorTx,
    http_status: httpStatus,
  };
}
