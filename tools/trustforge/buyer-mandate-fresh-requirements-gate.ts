/**
 * buyer-mandate-fresh-requirements-gate — exact seller/request match vs mandate.
 *
 * Preferred strongest R1 rule: fresh canonical requirements and envelope hashes
 * must equal the reviewed pair bound into the human mandate. No semantic
 * equivalence. Fail closed before attempt/nonce.
 */

import { BLOCKED_B361_FRESH_REQUIREMENTS_OUTSIDE_HUMAN_MANDATE } from "./b361-execution-gates";
import { BLOCKED_B363_FRESH_REQUIREMENTS_OUTSIDE_CONDITIONAL_MANDATE } from "./b363-execution-gates";
import type { SellerRequirementsObservation } from "./x402-seller-requirements-binding";

/** Shared exact-match surface for B.3.6.1 / B.3.6.3 human mandates. */
export interface MandateExactMatchBinding {
  readonly endpoint: string;
  readonly method: string;
  readonly request_query: ReadonlyArray<readonly [string, string]>;
  readonly request_body: unknown | null;
  readonly request_binding_sha256: string;
  readonly x402_version: number;
  readonly scheme: string;
  readonly seller_network_raw: string;
  readonly canonical_network_caip2: string;
  readonly asset: string;
  readonly pay_to: string;
  readonly amount_atomic: string;
  readonly maximum_authorized_amount_atomic: string;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
}

export interface MandateFreshRequirementsGateResult {
  readonly ok: true;
  readonly policy: "EXACT_MATCH_REQUIRED";
  readonly compared_fields: readonly string[];
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function queryEqual(
  a: MandateExactMatchBinding["request_query"],
  b: MandateExactMatchBinding["request_query"] | undefined,
): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((pair, i) => pair[0] === b[i][0] && pair[1] === b[i][1]);
}

/**
 * Exact equality gate. Call only after mandate temporal validation and before
 * attempt reservation / nonce generation.
 */
export function assertFreshRequirementsExactMatchMandate(input: {
  readonly mandate: MandateExactMatchBinding;
  readonly freshObservation: SellerRequirementsObservation;
  readonly freshEndpoint: string;
  readonly freshMethod: string;
  readonly freshRequestQuery?: MandateExactMatchBinding["request_query"];
  readonly freshRequestBody?: unknown | null;
  readonly blockerCode?: string;
}): MandateFreshRequirementsGateResult {
  const blocker =
    input.blockerCode ?? BLOCKED_B361_FRESH_REQUIREMENTS_OUTSIDE_HUMAN_MANDATE;
  const m = input.mandate;
  const b = input.freshObservation.binding;
  const compared: string[] = [];

  const check = (label: string, actual: unknown, expected: unknown) => {
    compared.push(label);
    if (actual !== expected) {
      fail(
        blocker,
        `${label} mismatch: mandate=${JSON.stringify(expected)} fresh=${JSON.stringify(actual)}`,
      );
    }
  };

  check("endpoint", input.freshEndpoint, m.endpoint);
  check("method", input.freshMethod, m.method);
  if (input.freshRequestQuery !== undefined) {
    compared.push("request_query");
    if (!queryEqual(m.request_query, input.freshRequestQuery)) {
      fail(blocker, "request_query mismatch");
    }
  }
  if (input.freshRequestBody !== undefined) {
    compared.push("request_body");
    if (JSON.stringify(input.freshRequestBody) !== JSON.stringify(m.request_body)) {
      fail(blocker, "request_body mismatch");
    }
  }
  check("request_binding_sha256", b.request_binding_sha256, m.request_binding_sha256);
  check("x402_version", b.protocol_version, m.x402_version);
  check("scheme", b.scheme, m.scheme);
  check("seller_network_raw", b.seller_network_raw, m.seller_network_raw);
  check("canonical_network_caip2", b.canonical_network_caip2, m.canonical_network_caip2);
  compared.push("asset");
  if (!sameAddress(b.asset, m.asset)) fail(blocker, "asset mismatch");
  compared.push("pay_to");
  if (!sameAddress(b.pay_to, m.pay_to)) fail(blocker, "pay_to mismatch");
  check("amount_atomic", b.amount_atomic, m.amount_atomic);
  if (b.amount_atomic === "0" || BigInt(b.amount_atomic) <= 0n) {
    fail(blocker, "amount_atomic must be positive");
  }
  if (BigInt(b.amount_atomic) > BigInt(m.maximum_authorized_amount_atomic)) {
    fail(blocker, "fresh amount exceeds mandate maximum_authorized_amount_atomic");
  }
  // Strongest R1: exact reviewed requirements/envelope hashes.
  check(
    "canonical_requirements_sha256",
    b.canonical_requirements_sha256,
    m.canonical_requirements_sha256,
  );
  check(
    "canonical_envelope_sha256",
    b.canonical_envelope_sha256,
    m.canonical_envelope_sha256,
  );

  return {
    ok: true,
    policy: "EXACT_MATCH_REQUIRED",
    compared_fields: compared,
  };
}

/** B.3.6.3 alias with conditional-mandate blocker code. */
export function assertFreshRequirementsExactMatchConditionalMandate(input: {
  readonly mandate: MandateExactMatchBinding;
  readonly freshObservation: SellerRequirementsObservation;
  readonly freshEndpoint: string;
  readonly freshMethod: string;
  readonly freshRequestQuery?: MandateExactMatchBinding["request_query"];
  readonly freshRequestBody?: unknown | null;
}): MandateFreshRequirementsGateResult {
  return assertFreshRequirementsExactMatchMandate({
    ...input,
    blockerCode: BLOCKED_B363_FRESH_REQUIREMENTS_OUTSIDE_CONDITIONAL_MANDATE,
  });
}
