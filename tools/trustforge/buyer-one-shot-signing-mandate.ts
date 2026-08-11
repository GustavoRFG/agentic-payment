/**
 * buyer-one-shot-signing-mandate — human parent authorization for JIT derivation.
 *
 * The mandate authorizes deterministic creation of at most one future exact
 * signing authorization under fixed economic/request constraints. It is NOT
 * accepted by BuyerAuthorizationSigner. Synthetic builders only in this phase.
 */

import {
  BLOCKED_B361_HUMAN_SIGNING_MANDATE_EXPIRED,
  BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
  BLOCKED_B361_HUMAN_SIGNING_MANDATE_MISSING,
  GUARD_HUMAN_SIGNING_MANDATE_CANNOT_BYPASS_EXACT_SIGNING_AUTHORIZATION,
} from "./b361-execution-gates";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const HUMAN_ONE_SHOT_SIGNING_MANDATE_SCHEMA_VERSION =
  "trustforge_human_one_shot_signing_mandate.v1" as const;

export const HUMAN_ONE_SHOT_SIGNING_MANDATE_DECISION =
  "authorize_one_shot_jit_signing_derivation" as const;

export const REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED =
  "EXACT_MATCH_REQUIRED" as const;

export type CanonicalQueryPairs = ReadonlyArray<readonly [string, string]>;

export interface HumanOneShotSigningMandate {
  readonly schema_version: typeof HUMAN_ONE_SHOT_SIGNING_MANDATE_SCHEMA_VERSION;
  readonly decision: typeof HUMAN_ONE_SHOT_SIGNING_MANDATE_DECISION;
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
  /** Prepare authorization hash when a prior prepare decision still applies. */
  readonly prepare_authorization_sha256: string;
  readonly max_attempts: 1;
  readonly max_signatures: 1;
  readonly max_credential_acquisitions: 1;
  readonly allow_retry: false;
  readonly allow_resign: false;
  /** Mandate never grants credential access; B.3.1 remains independent. */
  readonly credential_access_authorized: false;
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

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID, `${label} is required`);
  }
  return value;
}

function requireAtomicAmount(value: unknown, label: string): string {
  const s = requireNonEmptyString(value, label);
  if (!/^[0-9]+$/.test(s) || BigInt(s) <= 0n) {
    fail(BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID, `${label} must be a positive integer string`);
  }
  return s;
}

export function isHumanOneShotSigningMandate(
  value: unknown,
): value is HumanOneShotSigningMandate {
  return (
    isRecord(value) &&
    value.schema_version === HUMAN_ONE_SHOT_SIGNING_MANDATE_SCHEMA_VERSION
  );
}

/**
 * Structural guard: mandates must never be treated as signing authorizations.
 */
export function assertNotHumanOneShotSigningMandate(value: unknown): void {
  if (isHumanOneShotSigningMandate(value)) {
    fail(
      GUARD_HUMAN_SIGNING_MANDATE_CANNOT_BYPASS_EXACT_SIGNING_AUTHORIZATION,
      "HumanOneShotSigningMandate cannot reach BuyerAuthorizationSigner; only a derived exact SigningAuthorization may cross the B.3 signer boundary",
    );
  }
}

export function humanOneShotSigningMandateSha256(
  mandate: HumanOneShotSigningMandate,
): string {
  return canonicalJsonSha256(mandate);
}

/**
 * Validate mandate shape and temporal usability against `now`.
 * Equality with expiry is BLOCK (not usable at the boundary).
 */
export function validateHumanOneShotSigningMandate(input: {
  readonly mandate: HumanOneShotSigningMandate | null | undefined;
  readonly now: Date;
}): HumanOneShotSigningMandate {
  const mandate = input.mandate;
  if (!mandate || !isRecord(mandate as unknown)) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_MISSING,
      "human one-shot signing mandate is required for JIT derivation",
    );
  }
  if (mandate.schema_version !== HUMAN_ONE_SHOT_SIGNING_MANDATE_SCHEMA_VERSION) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "unsupported human one-shot signing mandate schema_version",
    );
  }
  if (mandate.decision !== HUMAN_ONE_SHOT_SIGNING_MANDATE_DECISION) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "decision must be authorize_one_shot_jit_signing_derivation",
    );
  }
  requireNonEmptyString(mandate.decision_id, "decision_id");
  requireNonEmptyString(mandate.provider, "provider");
  requireNonEmptyString(mandate.service_id, "service_id");
  requireNonEmptyString(mandate.endpoint, "endpoint");
  requireNonEmptyString(mandate.method, "method");
  if (!Array.isArray(mandate.request_query)) {
    fail(BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID, "request_query must be an array of pairs");
  }
  for (const pair of mandate.request_query) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      fail(BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID, "request_query pairs must be [key, value]");
    }
  }
  requireNonEmptyString(mandate.request_binding_sha256, "request_binding_sha256");
  if (typeof mandate.x402_version !== "number" || !Number.isInteger(mandate.x402_version)) {
    fail(BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID, "x402_version must be an integer");
  }
  requireNonEmptyString(mandate.scheme, "scheme");
  requireNonEmptyString(mandate.seller_network_raw, "seller_network_raw");
  requireNonEmptyString(mandate.canonical_network_caip2, "canonical_network_caip2");
  if (typeof mandate.chain_id !== "number" || !Number.isInteger(mandate.chain_id) || mandate.chain_id <= 0) {
    fail(BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID, "chain_id must be a positive integer");
  }
  const expectedChain = Number(mandate.canonical_network_caip2.replace(/^eip155:/, ""));
  if (mandate.chain_id !== expectedChain) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "chain_id must match canonical_network_caip2",
    );
  }
  requireNonEmptyString(mandate.asset, "asset");
  requireNonEmptyString(mandate.pay_to, "pay_to");
  requireNonEmptyString(mandate.buyer_wallet, "buyer_wallet");
  const amount = requireAtomicAmount(mandate.amount_atomic, "amount_atomic");
  const maximum = requireAtomicAmount(
    mandate.maximum_authorized_amount_atomic,
    "maximum_authorized_amount_atomic",
  );
  if (BigInt(amount) > BigInt(maximum)) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "amount_atomic must not exceed maximum_authorized_amount_atomic",
    );
  }
  requireNonEmptyString(mandate.canonical_requirements_sha256, "canonical_requirements_sha256");
  requireNonEmptyString(mandate.canonical_envelope_sha256, "canonical_envelope_sha256");
  requireNonEmptyString(mandate.prepare_authorization_sha256, "prepare_authorization_sha256");
  if (
    mandate.max_attempts !== 1 ||
    mandate.max_signatures !== 1 ||
    mandate.max_credential_acquisitions !== 1
  ) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "max_attempts, max_signatures, and max_credential_acquisitions must be 1",
    );
  }
  if (mandate.allow_retry !== false || mandate.allow_resign !== false) {
    fail(BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID, "retry and resign must be false");
  }
  if (mandate.credential_access_authorized !== false) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "credential_access_authorized must be false; B.3.1 remains an independent gate",
    );
  }
  if (
    mandate.payment_bearing_send_authorized !== false ||
    mandate.settlement_authorized !== false
  ) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "mandate must not authorize payment-bearing send or settlement",
    );
  }
  if (mandate.requirements_change_policy !== REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "requirements_change_policy must be EXACT_MATCH_REQUIRED",
    );
  }
  const decidedMs = Date.parse(mandate.decided_at);
  const expiresMs = Date.parse(mandate.mandate_expires_at);
  if (!Number.isFinite(decidedMs) || !Number.isFinite(expiresMs)) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "decided_at and mandate_expires_at must be usable timestamps",
    );
  }
  if (!(decidedMs < expiresMs)) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_INVALID,
      "mandate_expires_at must be strictly after decided_at",
    );
  }
  // Equality with expiry is BLOCK.
  if (!(input.now.getTime() < expiresMs)) {
    fail(
      BLOCKED_B361_HUMAN_SIGNING_MANDATE_EXPIRED,
      `human signing mandate expired at ${mandate.mandate_expires_at}`,
    );
  }
  return mandate;
}

/**
 * Synthetic fixture builder only — not an operational human decision.
 */
export function buildSyntheticHumanOneShotSigningMandate(input: {
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
  readonly chainId: number;
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
}): HumanOneShotSigningMandate {
  const amount = input.amountAtomic ?? "1000";
  const maximum = input.maximumAuthorizedAmountAtomic ?? amount;
  return {
    schema_version: HUMAN_ONE_SHOT_SIGNING_MANDATE_SCHEMA_VERSION,
    decision: HUMAN_ONE_SHOT_SIGNING_MANDATE_DECISION,
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
    chain_id: input.chainId,
    asset: input.asset,
    pay_to: input.payTo,
    buyer_wallet: input.buyerWallet,
    amount_atomic: amount,
    maximum_authorized_amount_atomic: maximum,
    canonical_requirements_sha256: input.canonicalRequirementsSha256,
    canonical_envelope_sha256: input.canonicalEnvelopeSha256,
    prepare_authorization_sha256: input.prepareAuthorizationSha256,
    max_attempts: 1,
    max_signatures: 1,
    max_credential_acquisitions: 1,
    allow_retry: false,
    allow_resign: false,
    credential_access_authorized: false,
    payment_bearing_send_authorized: false,
    settlement_authorized: false,
    requirements_change_policy: REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED,
    decided_at: input.decidedAt,
    mandate_expires_at: input.mandateExpiresAt,
  };
}

export function mandateAddressesEqual(a: string, b: string): boolean {
  return sameAddress(a, b);
}
