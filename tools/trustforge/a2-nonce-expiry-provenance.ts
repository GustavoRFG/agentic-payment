/**
 * a2-nonce-expiry-provenance — explicit mapping of validity/nonce field origins.
 *
 * Seller requirements do NOT own EIP-3009 nonce / validAfter / validBefore.
 * Buyer authorization owns those fields after human APPROVE (JIT).
 */

export const A2_NONCE_EXPIRY_PROVENANCE = "A2_NONCE_EXPIRY_PROVENANCE" as const;

export type ProvenanceController = "seller" | "buyer" | "trustforge_policy" | "protocol_derived";

export interface FieldProvenanceRow {
  readonly field: string;
  readonly origin: string;
  readonly authoritative_source: string;
  readonly derivation_rule: string;
  readonly when_created: string;
  readonly who_controls: ProvenanceController;
  readonly what_it_binds: string;
}

export const NONCE_EXPIRY_PROVENANCE_ROWS: readonly FieldProvenanceRow[] = [
  {
    field: "nonce",
    origin: "buyer EIP-3009 authorization",
    authoritative_source: "buyer-authorization-attempt / unsigned artifact",
    derivation_rule: "cryptographically random 32-byte hex; never copied from seller 402",
    when_created: "AFTER human APPROVE, at attempt reservation (JIT)",
    who_controls: "buyer",
    what_it_binds: "one EIP-3009 TransferWithAuthorization signature attempt",
  },
  {
    field: "validAfter",
    origin: "buyer EIP-3009 authorization",
    authoritative_source: "buyer-eip3009-authorization",
    derivation_rule: "floor(now) - clock_skew_seconds (policy default 60s)",
    when_created: "AFTER human APPROVE, when unsigned artifact is built",
    who_controls: "buyer",
    what_it_binds: "earliest time the authorization may be relayed",
  },
  {
    field: "validBefore",
    origin: "buyer EIP-3009 authorization",
    authoritative_source: "buyer-eip3009-authorization + effective signing deadline",
    derivation_rule: "min(human_auth_expiry, paytime_observed_at + maxTimeoutSeconds, policy caps)",
    when_created: "AFTER human APPROVE, when unsigned artifact is built",
    who_controls: "buyer",
    what_it_binds: "latest time the authorization may be relayed",
  },
  {
    field: "seller.maxTimeoutSeconds",
    origin: "seller payment requirements (x402 accepts[])",
    authoritative_source: "SellerRequirementsObservation.binding.max_timeout_seconds",
    derivation_rule: "verbatim from selected accept entry",
    when_created: "at unpaid 402 observation (selection or pay-time)",
    who_controls: "seller",
    what_it_binds: "seller-advertised local freshness window for the challenge",
  },
  {
    field: "human_authorization_expires_at",
    origin: "TrustForge human mandate TTL policy",
    authoritative_source: "HumanConditional*Mandate.mandate_expires_at",
    derivation_rule: "decided_at + mandate_ttl_ms (default 900s, max 1800s)",
    when_created: "at human APPROVE (mandate seal)",
    who_controls: "trustforge_policy",
    what_it_binds: "how long the human one-shot mandates remain usable",
  },
  {
    field: "resource_or_envelope.expiresAt",
    origin: "optional seller/resource envelope metadata (often Tempo/ancillary)",
    authoritative_source: "payment_required_envelope / ancillary_tempo_evidence",
    derivation_rule: "record-only; NEVER used as EIP-3009 nonce or validBefore",
    when_created: "if present in unpaid 402 envelope",
    who_controls: "seller",
    what_it_binds: "seller/resource marketing or ancillary expiry only",
  },
  {
    field: "effective_signing_deadline",
    origin: "protocol_derived",
    authoritative_source: "calculateEffectiveSigningDeadline",
    derivation_rule: "min(human_authorization_expires_at, paytime_observed_at + maxTimeoutSeconds)",
    when_created: "at pre-sign / freshness validation",
    who_controls: "protocol_derived",
    what_it_binds: "latest moment signing is still allowed for the current fresh 402",
  },
] as const;

export function assertNonceExpiryProvenanceInvariants(): {
  readonly status: "PASS";
  readonly invariant: typeof A2_NONCE_EXPIRY_PROVENANCE;
  readonly rows: readonly FieldProvenanceRow[];
} {
  const nonce = NONCE_EXPIRY_PROVENANCE_ROWS.find((r) => r.field === "nonce");
  if (!nonce || nonce.who_controls !== "buyer") {
    throw new Error(`${A2_NONCE_EXPIRY_PROVENANCE}: nonce must be buyer-controlled`);
  }
  if (/seller/i.test(nonce.origin) && nonce.who_controls === "seller") {
    throw new Error(`${A2_NONCE_EXPIRY_PROVENANCE}: nonce must not be seller-owned`);
  }
  const env = NONCE_EXPIRY_PROVENANCE_ROWS.find(
    (r) => r.field === "resource_or_envelope.expiresAt",
  );
  if (!env || !/NEVER/i.test(env.derivation_rule)) {
    throw new Error(
      `${A2_NONCE_EXPIRY_PROVENANCE}: envelope expiresAt must never drive EIP-3009`,
    );
  }
  return {
    status: "PASS",
    invariant: A2_NONCE_EXPIRY_PROVENANCE,
    rows: NONCE_EXPIRY_PROVENANCE_ROWS,
  };
}
