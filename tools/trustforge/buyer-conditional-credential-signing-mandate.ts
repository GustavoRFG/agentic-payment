/**
 * buyer-conditional-credential-signing-mandate — parent human authorization for
 * conditional credential acquisition + one signer invocation after exact JIT.
 *
 * Not accepted by credential provider, hidden TTY, runtime-key adapter, or signer.
 * Synthetic builders only in this phase.
 */

import {
  BLOCKED_B363_CONDITIONAL_MANDATE_EXPIRED,
  BLOCKED_B363_CONDITIONAL_MANDATE_INVALID,
  BLOCKED_B363_CONDITIONAL_MANDATE_MISSING,
  GUARD_HUMAN_CONDITIONAL_MANDATE_NOT_DIRECTLY_CREDENTIAL_CAPABLE,
  GUARD_HUMAN_CONDITIONAL_MANDATE_NOT_DIRECTLY_SIGNABLE,
} from "./b363-execution-gates";
import { B35_SECRET_ENTRY_MECHANISM } from "./buyer-hidden-tty-secret-entry";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "./explicit-runtime-key-credential-provider";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE_SCHEMA_VERSION =
  "trustforge_human_conditional_credential_signing_mandate.v1" as const;

export const HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE_DECISION =
  "authorize_one_shot_conditional_credential_signing_derivation" as const;

export const REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED =
  "EXACT_MATCH_REQUIRED" as const;

export const B34_ONE_SHOT_PIPE_TRANSPORT = "B34_ONE_SHOT_PIPE" as const;

export type CanonicalQueryPairs = ReadonlyArray<readonly [string, string]>;

export interface HumanConditionalCredentialSigningMandate {
  readonly schema_version: typeof HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE_SCHEMA_VERSION;
  readonly decision: typeof HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE_DECISION;
  readonly decision_id: string;
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly method: string;
  readonly request_query: CanonicalQueryPairs;
  readonly request_body: unknown | null;
  readonly request_binding_sha256: string;
  readonly x402_version: number;
  readonly scheme: string;
  readonly seller_network_raw: string;
  readonly canonical_network_caip2: string;
  readonly chain_id: number;
  readonly asset: string;
  readonly pay_to: string;
  readonly buyer_wallet: string;
  readonly amount_atomic: string;
  readonly maximum_authorized_amount_atomic: string;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
  readonly prepare_authorization_sha256: string;
  readonly max_attempts: 1;
  readonly max_nonces: 1;
  readonly max_unsigned_artifacts: 1;
  readonly max_signing_authorizations: 1;
  readonly max_credential_acquisitions: 1;
  readonly max_signer_invocations: 1;
  readonly max_signatures: 1;
  readonly allow_retry: false;
  readonly allow_resign: false;
  /** Conditional privilege — still requires derived CredentialAccessAuthorization. */
  readonly credential_access_conditionally_authorized: true;
  /** Conditional privilege — still requires derived BuyerSigningAuthorization. */
  readonly real_signing_conditionally_authorized: true;
  readonly credential_provider_id: typeof EXPLICIT_RUNTIME_KEY_PROVIDER_ID;
  readonly credential_kind: typeof EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND;
  readonly secret_entry_mechanism: typeof B35_SECRET_ENTRY_MECHANISM;
  readonly credential_transport: typeof B34_ONE_SHOT_PIPE_TRANSPORT;
  readonly payment_bearing_send_authorized: false;
  readonly settlement_authorized: false;
  readonly requirements_change_policy: typeof REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED;
  readonly decided_at: string;
  readonly mandate_expires_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, `${label} is required`);
  }
  return value;
}

function requireAtomicAmount(value: unknown, label: string): string {
  const s = requireNonEmptyString(value, label);
  if (!/^[0-9]+$/.test(s) || BigInt(s) <= 0n) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, `${label} must be a positive integer string`);
  }
  return s;
}

export function isHumanConditionalCredentialSigningMandate(
  value: unknown,
): value is HumanConditionalCredentialSigningMandate {
  return (
    isRecord(value) &&
    value.schema_version === HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE_SCHEMA_VERSION
  );
}

export function assertNotHumanConditionalMandateForCredential(value: unknown): void {
  if (isHumanConditionalCredentialSigningMandate(value)) {
    fail(
      GUARD_HUMAN_CONDITIONAL_MANDATE_NOT_DIRECTLY_CREDENTIAL_CAPABLE,
      "HumanConditionalCredentialSigningMandate cannot directly acquire credentials; only a derived CredentialAccessAuthorization may cross the B.3.1 boundary",
    );
  }
}

export function assertNotHumanConditionalMandateForSigner(value: unknown): void {
  if (isHumanConditionalCredentialSigningMandate(value)) {
    fail(
      GUARD_HUMAN_CONDITIONAL_MANDATE_NOT_DIRECTLY_SIGNABLE,
      "HumanConditionalCredentialSigningMandate cannot directly invoke the signer; only a derived BuyerSigningAuthorization may cross the B.3 boundary",
    );
  }
}

export function humanConditionalCredentialSigningMandateSha256(
  mandate: HumanConditionalCredentialSigningMandate,
): string {
  return canonicalJsonSha256(mandate);
}

export function validateHumanConditionalCredentialSigningMandate(input: {
  readonly mandate: HumanConditionalCredentialSigningMandate | null | undefined;
  readonly now: Date;
}): HumanConditionalCredentialSigningMandate {
  const mandate = input.mandate;
  if (!mandate || !isRecord(mandate as unknown)) {
    fail(
      BLOCKED_B363_CONDITIONAL_MANDATE_MISSING,
      "human conditional credential signing mandate is required",
    );
  }
  if (mandate.schema_version !== HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE_SCHEMA_VERSION) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "unsupported schema_version");
  }
  if (mandate.decision !== HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE_DECISION) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "unsupported decision");
  }
  requireNonEmptyString(mandate.decision_id, "decision_id");
  requireNonEmptyString(mandate.provider, "provider");
  requireNonEmptyString(mandate.service_id, "service_id");
  requireNonEmptyString(mandate.endpoint, "endpoint");
  requireNonEmptyString(mandate.method, "method");
  if (!Array.isArray(mandate.request_query)) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "request_query must be an array of pairs");
  }
  requireNonEmptyString(mandate.request_binding_sha256, "request_binding_sha256");
  if (typeof mandate.x402_version !== "number" || !Number.isInteger(mandate.x402_version)) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "x402_version must be an integer");
  }
  requireNonEmptyString(mandate.scheme, "scheme");
  requireNonEmptyString(mandate.seller_network_raw, "seller_network_raw");
  requireNonEmptyString(mandate.canonical_network_caip2, "canonical_network_caip2");
  if (typeof mandate.chain_id !== "number" || mandate.chain_id !== 8453) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "chain_id must be 8453 for Base mainnet canary");
  }
  const amount = requireAtomicAmount(mandate.amount_atomic, "amount_atomic");
  const maximum = requireAtomicAmount(
    mandate.maximum_authorized_amount_atomic,
    "maximum_authorized_amount_atomic",
  );
  if (BigInt(amount) > BigInt(maximum)) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "amount exceeds maximum");
  }
  requireNonEmptyString(mandate.canonical_requirements_sha256, "canonical_requirements_sha256");
  requireNonEmptyString(mandate.canonical_envelope_sha256, "canonical_envelope_sha256");
  requireNonEmptyString(mandate.prepare_authorization_sha256, "prepare_authorization_sha256");
  requireNonEmptyString(mandate.asset, "asset");
  requireNonEmptyString(mandate.pay_to, "pay_to");
  requireNonEmptyString(mandate.buyer_wallet, "buyer_wallet");
  if (
    mandate.max_attempts !== 1 ||
    mandate.max_nonces !== 1 ||
    mandate.max_unsigned_artifacts !== 1 ||
    mandate.max_signing_authorizations !== 1 ||
    mandate.max_credential_acquisitions !== 1 ||
    mandate.max_signer_invocations !== 1 ||
    mandate.max_signatures !== 1
  ) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "all one-shot maxima must be 1");
  }
  if (mandate.allow_retry !== false || mandate.allow_resign !== false) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "retry and resign must be false");
  }
  if (
    mandate.credential_access_conditionally_authorized !== true ||
    mandate.real_signing_conditionally_authorized !== true
  ) {
    fail(
      BLOCKED_B363_CONDITIONAL_MANDATE_INVALID,
      "conditional credential and signing privileges must be explicitly true",
    );
  }
  if (mandate.credential_provider_id !== EXPLICIT_RUNTIME_KEY_PROVIDER_ID) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "credential provider must be explicit-runtime-key");
  }
  if (mandate.credential_kind !== EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "credential kind mismatch");
  }
  if (mandate.secret_entry_mechanism !== B35_SECRET_ENTRY_MECHANISM) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "secret entry must be HIDDEN_PARENT_TTY_ONE_SHOT");
  }
  if (mandate.credential_transport !== B34_ONE_SHOT_PIPE_TRANSPORT) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "credential transport must be B34_ONE_SHOT_PIPE");
  }
  if (
    mandate.payment_bearing_send_authorized !== false ||
    mandate.settlement_authorized !== false
  ) {
    fail(
      BLOCKED_B363_CONDITIONAL_MANDATE_INVALID,
      "mandate must not authorize payment-bearing send or settlement",
    );
  }
  if (mandate.requirements_change_policy !== REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "EXACT_MATCH_REQUIRED required");
  }
  const decidedMs = Date.parse(mandate.decided_at);
  const expiresMs = Date.parse(mandate.mandate_expires_at);
  if (!Number.isFinite(decidedMs) || !Number.isFinite(expiresMs) || !(decidedMs < expiresMs)) {
    fail(BLOCKED_B363_CONDITIONAL_MANDATE_INVALID, "mandate temporal fields invalid");
  }
  if (!(input.now.getTime() < expiresMs)) {
    fail(
      BLOCKED_B363_CONDITIONAL_MANDATE_EXPIRED,
      `conditional mandate expired at ${mandate.mandate_expires_at}`,
    );
  }
  return mandate;
}

/** Synthetic fixture builder — not an operational human decision. */
export function buildSyntheticHumanConditionalCredentialSigningMandate(input: {
  readonly decisionId: string;
  readonly provider?: string;
  readonly serviceId?: string;
  readonly endpoint: string;
  readonly method: string;
  readonly requestQuery?: CanonicalQueryPairs;
  readonly requestBody?: unknown | null;
  readonly requestBindingSha256: string;
  readonly x402Version?: number;
  readonly scheme?: string;
  readonly sellerNetworkRaw: string;
  readonly canonicalNetworkCaip2: string;
  readonly chainId?: number;
  readonly asset: string;
  readonly payTo: string;
  readonly buyerWallet: string;
  readonly amountAtomic?: string;
  readonly maximumAuthorizedAmountAtomic?: string;
  readonly canonicalRequirementsSha256: string;
  readonly canonicalEnvelopeSha256: string;
  readonly prepareAuthorizationSha256: string;
  readonly decidedAt: string;
  readonly mandateExpiresAt: string;
}): HumanConditionalCredentialSigningMandate {
  const amount = input.amountAtomic ?? "1000";
  return {
    schema_version: HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE_SCHEMA_VERSION,
    decision: HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE_DECISION,
    decision_id: input.decisionId,
    provider: input.provider ?? "discovered_x402",
    service_id: input.serviceId ?? "api_onesource_io_api_chain_block_number",
    endpoint: input.endpoint,
    method: input.method,
    request_query: input.requestQuery ?? [["network", "ethereum"]],
    request_body: input.requestBody ?? null,
    request_binding_sha256: input.requestBindingSha256,
    x402_version: input.x402Version ?? 2,
    scheme: input.scheme ?? "exact",
    seller_network_raw: input.sellerNetworkRaw,
    canonical_network_caip2: input.canonicalNetworkCaip2,
    chain_id: input.chainId ?? 8453,
    asset: input.asset,
    pay_to: input.payTo,
    buyer_wallet: input.buyerWallet,
    amount_atomic: amount,
    maximum_authorized_amount_atomic: input.maximumAuthorizedAmountAtomic ?? amount,
    canonical_requirements_sha256: input.canonicalRequirementsSha256,
    canonical_envelope_sha256: input.canonicalEnvelopeSha256,
    prepare_authorization_sha256: input.prepareAuthorizationSha256,
    max_attempts: 1,
    max_nonces: 1,
    max_unsigned_artifacts: 1,
    max_signing_authorizations: 1,
    max_credential_acquisitions: 1,
    max_signer_invocations: 1,
    max_signatures: 1,
    allow_retry: false,
    allow_resign: false,
    credential_access_conditionally_authorized: true,
    real_signing_conditionally_authorized: true,
    credential_provider_id: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
    credential_kind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
    secret_entry_mechanism: B35_SECRET_ENTRY_MECHANISM,
    credential_transport: B34_ONE_SHOT_PIPE_TRANSPORT,
    payment_bearing_send_authorized: false,
    settlement_authorized: false,
    requirements_change_policy: REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED,
    decided_at: input.decidedAt,
    mandate_expires_at: input.mandateExpiresAt,
  };
}

export function mandateAddressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
