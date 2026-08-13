/**
 * A.2 nonce / expiry provenance — structural invariants.
 * NO PAYMENT.
 */

import { describe, expect, it } from "vitest";

import {
  A2_NONCE_EXPIRY_PROVENANCE,
  assertNonceExpiryProvenanceInvariants,
  NONCE_EXPIRY_PROVENANCE_ROWS,
} from "../../tools/trustforge/a2-nonce-expiry-provenance";

describe("A.2 nonce/expiry provenance", () => {
  it("passes structural invariants (buyer owns nonce; envelope expiresAt never drives EIP-3009)", () => {
    const result = assertNonceExpiryProvenanceInvariants();
    expect(result.status).toBe("PASS");
    expect(result.invariant).toBe(A2_NONCE_EXPIRY_PROVENANCE);
    expect(result.rows.length).toBeGreaterThanOrEqual(7);
  });

  it("maps required fields with authoritative controllers", () => {
    const byField = new Map(NONCE_EXPIRY_PROVENANCE_ROWS.map((r) => [r.field, r]));
    expect(byField.get("nonce")?.who_controls).toBe("buyer");
    expect(byField.get("validAfter")?.who_controls).toBe("buyer");
    expect(byField.get("validBefore")?.who_controls).toBe("buyer");
    expect(byField.get("seller.maxTimeoutSeconds")?.who_controls).toBe("seller");
    expect(byField.get("human_authorization_expires_at")?.who_controls).toBe(
      "trustforge_policy",
    );
    expect(byField.get("resource_or_envelope.expiresAt")?.derivation_rule).toMatch(
      /NEVER/i,
    );
    expect(byField.get("effective_signing_deadline")?.who_controls).toBe(
      "protocol_derived",
    );
  });

  it("does not attribute buyer nonce to seller metadata", () => {
    const nonce = NONCE_EXPIRY_PROVENANCE_ROWS.find((r) => r.field === "nonce");
    expect(nonce).toBeDefined();
    expect(nonce!.who_controls).not.toBe("seller");
    expect(nonce!.origin.toLowerCase()).not.toContain("seller 402");
  });
});
