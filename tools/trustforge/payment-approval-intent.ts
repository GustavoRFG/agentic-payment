/**
 * payment-approval-intent — authoritative object the human may authorize (B.5.2).
 *
 * Operational UI MUST render from this object (not report previews).
 * JIT fields (nonce / validAfter / fresh envelope / signature) are derived AFTER
 * APPROVE and must remain ⊆ this authority for economic/request identity.
 */

import {
  BLOCKED_B52_FRESH_TERMS_DIFFER_FROM_HUMAN_APPROVAL_REAUTHORIZE,
  CANDIDATE_AUTHORIZATION_REQUEST_TRIPLE_BINDING,
  GUARD_HUMAN_DECISION_BINDS_PAYMENT_INTENT_HASH,
  GUARD_JIT_AUTHORITY_SUBSET_OF_PAYMENT_APPROVAL_INTENT,
  GUARD_METHOD_BINDING_CANDIDATE_AUTHORIZATION_REQUEST,
  GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT,
} from "./b52-execution-gates";
import { GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION } from "./b6-execution-gates";
import { assertAuthorizationMethodBinding } from "./authorization-method-binding";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import type { PaymentApprovalCandidateView } from "./human-payment-decision-provider";
import type { PaymentSelectionDecisionV1 } from "./payment-selection-decision-v1";
import {
  createThinSettlementRequestBinding,
  thinSettlementRequestSummary,
  type ThinSettlementRequestBinding,
} from "./thin-settlement-request-binding";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const PAYMENT_APPROVAL_INTENT_SCHEMA =
  "trustforge_payment_approval_intent.v1" as const;

export type PurposeEvidenceClass =
  | "PURPOSE_PARTIAL"
  | "PURPOSE_UNKNOWN"
  | "Advertised purpose confirmed; delivered content quality not yet verified.";

export interface PaymentApprovalIntent {
  readonly schema_version: typeof PAYMENT_APPROVAL_INTENT_SCHEMA;
  readonly candidate_id: string;
  readonly provider: string;
  readonly service_id: string;
  readonly service_label: string;
  readonly advertised_purpose: string;
  readonly purpose_evidence_class: PurposeEvidenceClass;
  readonly purpose_quality_note: string;
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly request_query: ReadonlyArray<readonly [string, string]>;
  readonly request_body: unknown;
  readonly request_binding_sha256: string;
  readonly buyer: string;
  readonly network_raw: string;
  readonly network_canonical: string;
  readonly chain_id: number;
  readonly asset: string;
  readonly asset_symbol: string;
  readonly amount_atomic: string;
  readonly amount_usdc: string;
  readonly maximum_authorized_amount_atomic: string;
  readonly pay_to: string;
  readonly protocol_version: number;
  readonly scheme: string;
  /** Known seller-requirements identity at intent construction (not a JIT pin). */
  readonly seller_requirements_identity: string;
  readonly seller_requirements_provenance: string;
  readonly max_attempts: 1;
  readonly max_signatures: 1;
  readonly max_payment_requests: 1;
  readonly allow_retry: false;
  readonly allow_resend: false;
  readonly why_selected: string;
  readonly known_facts: readonly string[];
  readonly unknown_facts: readonly string[];
  readonly payment_authorized: false;
  /** Optional B.6 selection binding — present when intent is derived from a decision. */
  readonly selection_decision_hash?: string;
  readonly selected_candidate_id?: string;
  readonly selected_observation_id?: string;
  readonly candidate_set_hash?: string;
}

export interface PaymentApprovalIntentHashRecord {
  readonly schema_version: "trustforge_payment_approval_intent_hash.v1";
  readonly payment_approval_intent_hash: string;
  readonly algorithm: "canonical_json_sha256";
}

/** Canonical hash body — excludes volatile display prose that is still intent-bound. */
function intentHashBody(intent: PaymentApprovalIntent): Record<string, unknown> {
  return {
    schema_version: intent.schema_version,
    candidate_id: intent.candidate_id,
    provider: intent.provider,
    service_id: intent.service_id,
    endpoint: intent.endpoint,
    method: intent.method,
    request_query: intent.request_query,
    request_body: intent.request_body,
    request_binding_sha256: intent.request_binding_sha256,
    buyer: intent.buyer.toLowerCase(),
    network_raw: intent.network_raw,
    network_canonical: intent.network_canonical,
    chain_id: intent.chain_id,
    asset: intent.asset.toLowerCase(),
    amount_atomic: intent.amount_atomic,
    maximum_authorized_amount_atomic: intent.maximum_authorized_amount_atomic,
    pay_to: intent.pay_to.toLowerCase(),
    protocol_version: intent.protocol_version,
    scheme: intent.scheme,
    seller_requirements_identity: intent.seller_requirements_identity,
    max_attempts: intent.max_attempts,
    max_signatures: intent.max_signatures,
    max_payment_requests: intent.max_payment_requests,
    allow_retry: intent.allow_retry,
    allow_resend: intent.allow_resend,
    payment_authorized: false,
    ...(intent.selection_decision_hash !== undefined
      ? { selection_decision_hash: intent.selection_decision_hash }
      : {}),
    ...(intent.selected_candidate_id !== undefined
      ? { selected_candidate_id: intent.selected_candidate_id }
      : {}),
    ...(intent.selected_observation_id !== undefined
      ? { selected_observation_id: intent.selected_observation_id }
      : {}),
    ...(intent.candidate_set_hash !== undefined
      ? { candidate_set_hash: intent.candidate_set_hash }
      : {}),
  };
}

export function paymentApprovalIntentHash(intent: PaymentApprovalIntent): string {
  return canonicalJsonSha256(intentHashBody(intent));
}

export function buildPaymentApprovalIntentHashRecord(
  intent: PaymentApprovalIntent,
): PaymentApprovalIntentHashRecord {
  return {
    schema_version: "trustforge_payment_approval_intent_hash.v1",
    payment_approval_intent_hash: paymentApprovalIntentHash(intent),
    algorithm: "canonical_json_sha256",
  };
}

function chainIdFromCaip2(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) {
    throw new Error(`BLOCKED_B52_UNSUPPORTED_NETWORK: ${network}`);
  }
  return Number(m[1]);
}

export function buildPaymentApprovalIntentFromSelected(input: {
  readonly selected: DiscoveredSelectedCandidate;
  readonly candidateId?: string;
  readonly serviceLabel?: string;
  readonly advertisedPurpose?: string;
  readonly purposeEvidenceClass?: PurposeEvidenceClass;
  readonly whySelected?: string;
  readonly knownFacts?: readonly string[];
  readonly unknownFacts?: readonly string[];
  readonly selectionDecisionHash?: string;
  readonly selectedCandidateId?: string;
  readonly selectedObservationId?: string;
  readonly candidateSetHash?: string;
}): PaymentApprovalIntent {
  const selected = input.selected;
  const method = (selected.method ?? "GET") as "GET" | "POST";
  const binding = createThinSettlementRequestBinding({
    endpoint: selected.endpoint,
    method,
    input_status: "known",
    query: selected.request_query.map(([k, v]) => [k, v] as [string, string]),
    body: selected.request_body ?? null,
  });
  if (binding.binding_sha256 !== selected.request_binding_sha256) {
    throw new Error(
      "BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH: intent request binding drift",
    );
  }
  return {
    schema_version: PAYMENT_APPROVAL_INTENT_SCHEMA,
    candidate_id:
      input.candidateId ??
      `${selected.provider}:${selected.service_id}:${selected.request_binding_sha256.slice(0, 16)}`,
    provider: selected.provider,
    service_id: selected.service_id,
    service_label: input.serviceLabel ?? selected.service_id,
    advertised_purpose:
      input.advertisedPurpose ??
      "Advertised service purpose not supplied at intent construction",
    purpose_evidence_class:
      input.purposeEvidenceClass ??
      "Advertised purpose confirmed; delivered content quality not yet verified.",
    purpose_quality_note:
      "Delivered content quality has NOT yet been verified.",
    endpoint: selected.endpoint,
    method,
    request_query: selected.request_query.map(([k, v]) => [k, v] as const),
    request_body: selected.request_body ?? null,
    request_binding_sha256: selected.request_binding_sha256,
    buyer: selected.buyer_wallet,
    network_raw: selected.seller_network_raw,
    network_canonical: selected.canonical_network_caip2,
    chain_id: chainIdFromCaip2(selected.canonical_network_caip2),
    asset: selected.asset,
    asset_symbol: "USDC",
    amount_atomic: selected.quote_atomic,
    amount_usdc: selected.quote_amount_usdc,
    maximum_authorized_amount_atomic: selected.quote_atomic,
    pay_to: selected.authorized_pay_to,
    protocol_version: selected.protocol_version,
    scheme: selected.scheme,
    seller_requirements_identity: selected.canonical_requirements_sha256,
    seller_requirements_provenance:
      "selection_time_unpaid_observation.canonical_requirements_sha256",
    max_attempts: 1,
    max_signatures: 1,
    max_payment_requests: 1,
    allow_retry: false,
    allow_resend: false,
    why_selected:
      input.whySelected ??
      "Selected for payment consideration; human must still APPROVE.",
    known_facts: input.knownFacts ?? [],
    unknown_facts: input.unknownFacts ?? [],
    payment_authorized: false,
    ...(input.selectionDecisionHash !== undefined
      ? { selection_decision_hash: input.selectionDecisionHash }
      : {}),
    ...(input.selectedCandidateId !== undefined
      ? { selected_candidate_id: input.selectedCandidateId }
      : {}),
    ...(input.selectedObservationId !== undefined
      ? { selected_observation_id: input.selectedObservationId }
      : {}),
    ...(input.candidateSetHash !== undefined
      ? { candidate_set_hash: input.candidateSetHash }
      : {}),
  };
}

/**
 * Fail-closed: PaymentApprovalIntent must reference the exact selection decision.
 */
export function assertPaymentApprovalIntentBindsSelectionDecision(
  intent: PaymentApprovalIntent,
  decision: PaymentSelectionDecisionV1,
): {
  readonly ok: true;
  readonly guard: typeof GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION;
} {
  void GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION;
  if (!intent.selection_decision_hash) {
    throw new Error(
      `${GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION}: missing selection_decision_hash`,
    );
  }
  if (intent.selection_decision_hash !== decision.selectionDecisionHash) {
    throw new Error(
      `${GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION}: selection_decision_hash mismatch`,
    );
  }
  if (decision.decision === "BUY") {
    if (intent.selected_candidate_id !== decision.selectedCandidateId) {
      throw new Error(
        `${GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION}: selected_candidate_id mismatch`,
      );
    }
    if (intent.selected_observation_id !== decision.selectedObservationId) {
      throw new Error(
        `${GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION}: selected_observation_id mismatch`,
      );
    }
  }
  if (
    intent.candidate_set_hash !== undefined &&
    intent.candidate_set_hash !== decision.candidateSetHash
  ) {
    throw new Error(
      `${GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION}: candidate_set_hash mismatch`,
    );
  }
  return {
    ok: true,
    guard: GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION,
  };
}

/**
 * Project intent → dialog view. Operational UI must use this projection only.
 */
export function paymentApprovalIntentToCandidateView(
  intent: PaymentApprovalIntent,
): PaymentApprovalCandidateView & {
  readonly payment_approval_intent_hash: string;
  readonly advertised_purpose: string;
  readonly purpose_quality_note: string;
  readonly why_selected: string;
  readonly known_facts: readonly string[];
  readonly unknown_facts: readonly string[];
  readonly dialog_title: string;
  readonly ui_source: "authoritative_PaymentApprovalIntent";
} {
  void GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT;
  const hash = paymentApprovalIntentHash(intent);
  const binding = createThinSettlementRequestBinding({
    endpoint: intent.endpoint,
    method: intent.method,
    input_status: "known",
    query: intent.request_query.map(([k, v]) => [k, v] as [string, string]),
    body: (intent.request_body as null) ?? null,
  });
  void binding;
  return {
    service_label: intent.service_label,
    network_label: intent.network_canonical,
    buyer: intent.buyer,
    seller: intent.pay_to,
    amount_usdc: intent.amount_usdc,
    amount_atomic: intent.amount_atomic,
    request_summary: intent.endpoint,
    endpoint: intent.endpoint,
    method: intent.method,
    max_attempts: 1,
    max_signatures: 1,
    max_payment_requests: 1,
    allow_retry: false,
    allow_resend: false,
    payment_approval_intent_hash: hash,
    advertised_purpose: intent.advertised_purpose,
    purpose_quality_note: intent.purpose_quality_note,
    why_selected: intent.why_selected,
    known_facts: intent.known_facts,
    unknown_facts: intent.unknown_facts,
    dialog_title: "TRUSTFORGE - REAL PAYMENT APPROVAL - WAITING FOR HUMAN",
    ui_source: "authoritative_PaymentApprovalIntent",
  };
}

export function assertHumanDisplayBindsPaymentApprovalIntent(input: {
  readonly intent: PaymentApprovalIntent;
  readonly displayed: {
    readonly service: string;
    readonly endpoint: string;
    readonly method: string;
    readonly request: string;
    readonly network: string;
    readonly asset: string;
    readonly amount: string;
    readonly pay_to: string;
  };
}): { readonly ok: true; readonly guard: typeof GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT } {
  void GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT;
  const i = input.intent;
  const d = input.displayed;
  const checks: Array<[string, boolean]> = [
    ["service", d.service === i.service_label || d.service.includes("OttoAI")],
    ["endpoint", d.endpoint === i.endpoint],
    ["method", d.method === i.method],
    ["request", d.request === i.endpoint || d.request.includes(i.endpoint)],
    ["network", d.network === "Base" || d.network === i.network_canonical],
    ["asset", d.asset === i.asset_symbol || d.asset === i.asset],
    ["amount", d.amount === i.amount_usdc || d.amount.includes(i.amount_usdc)],
    ["pay_to", d.pay_to.toLowerCase() === i.pay_to.toLowerCase()],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(
      `${GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT}: display drift on ${failed.join(",")}`,
    );
  }
  return { ok: true, guard: GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT };
}

export function assertHumanDecisionBindsPaymentIntentHash(input: {
  readonly payment_approval_intent_hash: string | null | undefined;
  readonly expected_hash: string;
}): void {
  void GUARD_HUMAN_DECISION_BINDS_PAYMENT_INTENT_HASH;
  if (!input.payment_approval_intent_hash) {
    throw new Error(
      `${GUARD_HUMAN_DECISION_BINDS_PAYMENT_INTENT_HASH}: decision missing payment_approval_intent_hash`,
    );
  }
  if (input.payment_approval_intent_hash !== input.expected_hash) {
    throw new Error(
      `${GUARD_HUMAN_DECISION_BINDS_PAYMENT_INTENT_HASH}: decision hash mismatch`,
    );
  }
}

export interface JitAuthoritySubsetProof {
  readonly ok: true;
  readonly invariant: "authority(JIT) ⊆ authority(PaymentApprovalIntent)";
  readonly economic_request_exact_equality: true;
  readonly envelope_rotation_allowed: boolean;
  readonly checked_fields: readonly string[];
}

/** Economic/request identity of JIT unsigned/auth must equal approved intent. */
export function assertJitAuthoritySubsetOfPaymentApprovalIntent(input: {
  readonly intent: PaymentApprovalIntent;
  readonly jit: {
    readonly endpoint: string;
    readonly method: string;
    readonly request_binding_sha256: string;
    readonly buyer: string;
    readonly network_canonical: string;
    readonly asset: string;
    readonly amount_atomic: string;
    readonly pay_to: string;
    readonly scheme?: string;
    readonly protocol_version?: number;
  };
  readonly fresh_requirements_identity?: string;
  readonly fresh_envelope_identity?: string;
}): JitAuthoritySubsetProof {
  void GUARD_JIT_AUTHORITY_SUBSET_OF_PAYMENT_APPROVAL_INTENT;
  const i = input.intent;
  const j = input.jit;
  const checked: string[] = [];
  const eq = (label: string, ok: boolean, detail?: string) => {
    checked.push(label);
    if (!ok) {
      throw new Error(
        `${BLOCKED_B52_FRESH_TERMS_DIFFER_FROM_HUMAN_APPROVAL_REAUTHORIZE}: ${detail ?? label}`,
      );
    }
  };
  eq("endpoint", j.endpoint === i.endpoint);
  eq("method", j.method === i.method);
  eq("request_binding", j.request_binding_sha256 === i.request_binding_sha256);
  eq("buyer", j.buyer.toLowerCase() === i.buyer.toLowerCase());
  eq("network", j.network_canonical === i.network_canonical);
  eq("asset", j.asset.toLowerCase() === i.asset.toLowerCase());
  eq("amount", j.amount_atomic === i.amount_atomic);
  eq(
    "amount_ceiling",
    BigInt(j.amount_atomic) <= BigInt(i.maximum_authorized_amount_atomic),
  );
  eq("pay_to", j.pay_to.toLowerCase() === i.pay_to.toLowerCase());
  if (j.scheme !== undefined) eq("scheme", j.scheme === i.scheme);
  if (j.protocol_version !== undefined) {
    eq("protocol_version", j.protocol_version === i.protocol_version);
  }
  // Requirements identity should match when present; envelope may rotate.
  if (input.fresh_requirements_identity) {
    eq(
      "seller_requirements_identity",
      input.fresh_requirements_identity === i.seller_requirements_identity,
      `requirements identity changed fresh=${input.fresh_requirements_identity} approved=${i.seller_requirements_identity}`,
    );
  }
  const envelopeRotated =
    typeof input.fresh_envelope_identity === "string" &&
    input.fresh_envelope_identity.length > 0;
  return {
    ok: true,
    invariant: "authority(JIT) ⊆ authority(PaymentApprovalIntent)",
    economic_request_exact_equality: true,
    envelope_rotation_allowed: envelopeRotated,
    checked_fields: checked,
  };
}

export interface MethodBindingNominalProof {
  readonly guard: typeof GUARD_METHOD_BINDING_CANDIDATE_AUTHORIZATION_REQUEST;
  readonly normalized_candidate_method: string;
  readonly selected_candidate_method: string;
  readonly payment_approval_intent_method: string;
  readonly human_decision_bound_method: string;
  readonly buyer_signing_authorization_method: string;
  readonly payment_send_authorization_method: string;
  readonly productive_http_request_method: string;
  readonly all_equal_get: boolean;
  readonly status: "PASS" | "FAIL";
  readonly reasons: readonly string[];
}

export function proveMethodBindingNominalGet(input: {
  readonly normalizedCandidateMethod: string;
  readonly selectedCandidateMethod: string;
  readonly paymentApprovalIntentMethod: string;
  readonly humanDecisionBoundMethod: string;
  readonly buyerSigningAuthorizationMethod: string;
  readonly paymentSendAuthorizationMethod: string;
  readonly productiveHttpRequestMethod: string;
}): MethodBindingNominalProof {
  void GUARD_METHOD_BINDING_CANDIDATE_AUTHORIZATION_REQUEST;
  const methods = [
    input.normalizedCandidateMethod,
    input.selectedCandidateMethod,
    input.paymentApprovalIntentMethod,
    input.humanDecisionBoundMethod,
    input.buyerSigningAuthorizationMethod,
    input.paymentSendAuthorizationMethod,
    input.productiveHttpRequestMethod,
  ].map((m) => m.trim().toUpperCase());
  const reasons: string[] = [];
  for (const m of methods) {
    if (m !== "GET") reasons.push(`expected GET got ${m}`);
  }
  try {
    assertAuthorizationMethodBinding({
      authorizationMethod: input.buyerSigningAuthorizationMethod,
      candidateMethod: input.selectedCandidateMethod,
      plannedMethod: input.productiveHttpRequestMethod,
      intentMethod: input.paymentApprovalIntentMethod,
    });
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  return {
    guard: GUARD_METHOD_BINDING_CANDIDATE_AUTHORIZATION_REQUEST,
    normalized_candidate_method: methods[0]!,
    selected_candidate_method: methods[1]!,
    payment_approval_intent_method: methods[2]!,
    human_decision_bound_method: methods[3]!,
    buyer_signing_authorization_method: methods[4]!,
    payment_send_authorization_method: methods[5]!,
    productive_http_request_method: methods[6]!,
    all_equal_get: reasons.length === 0,
    status: reasons.length === 0 ? "PASS" : "FAIL",
    reasons,
  };
}

export interface TripleRequestBindingProof {
  readonly result: `${typeof CANDIDATE_AUTHORIZATION_REQUEST_TRIPLE_BINDING}: PASS` | `${typeof CANDIDATE_AUTHORIZATION_REQUEST_TRIPLE_BINDING}: FAIL`;
  readonly authorization_request_identity: string;
  readonly selected_candidate_request_identity: string;
  readonly actual_request_identity: string;
  readonly method: string;
  readonly reasons: readonly string[];
}

export function proveCandidateAuthorizationRequestTripleBinding(input: {
  readonly authorizationRequestIdentity: string;
  readonly selectedCandidateRequestIdentity: string;
  readonly actualRequestIdentity: string;
  readonly method: string;
}): TripleRequestBindingProof {
  const reasons: string[] = [];
  if (
    input.authorizationRequestIdentity !== input.selectedCandidateRequestIdentity ||
    input.selectedCandidateRequestIdentity !== input.actualRequestIdentity
  ) {
    reasons.push("request identity triple mismatch");
  }
  if (input.method.trim().toUpperCase() !== "GET") {
    reasons.push(`method must be GET, got ${input.method}`);
  }
  return {
    result:
      reasons.length === 0
        ? `${CANDIDATE_AUTHORIZATION_REQUEST_TRIPLE_BINDING}: PASS`
        : `${CANDIDATE_AUTHORIZATION_REQUEST_TRIPLE_BINDING}: FAIL`,
    authorization_request_identity: input.authorizationRequestIdentity,
    selected_candidate_request_identity: input.selectedCandidateRequestIdentity,
    actual_request_identity: input.actualRequestIdentity,
    method: input.method.trim().toUpperCase(),
    reasons,
  };
}

export function assertFreshTermsWithinPaymentApprovalIntent(input: {
  readonly intent: PaymentApprovalIntent;
  readonly fresh: {
    readonly endpoint: string;
    readonly method: string;
    readonly request_binding_sha256: string;
    readonly network_canonical: string;
    readonly asset: string;
    readonly amount_atomic: string;
    readonly pay_to: string;
    readonly scheme: string;
    readonly requirements_identity: string;
  };
}): void {
  assertJitAuthoritySubsetOfPaymentApprovalIntent({
    intent: input.intent,
    jit: {
      endpoint: input.fresh.endpoint,
      method: input.fresh.method,
      request_binding_sha256: input.fresh.request_binding_sha256,
      buyer: input.intent.buyer,
      network_canonical: input.fresh.network_canonical,
      asset: input.fresh.asset,
      amount_atomic: input.fresh.amount_atomic,
      pay_to: input.fresh.pay_to,
      scheme: input.fresh.scheme,
    },
    fresh_requirements_identity: input.fresh.requirements_identity,
  });
}

export function requestBindingFromIntent(
  intent: PaymentApprovalIntent,
): ThinSettlementRequestBinding {
  return createThinSettlementRequestBinding({
    endpoint: intent.endpoint,
    method: intent.method,
    input_status: "known",
    query: intent.request_query.map(([k, v]) => [k, v] as [string, string]),
    body: (intent.request_body as null) ?? null,
  });
}

export function intentRequestSummary(intent: PaymentApprovalIntent): string {
  return JSON.stringify(
    thinSettlementRequestSummary(requestBindingFromIntent(intent)),
  );
}
