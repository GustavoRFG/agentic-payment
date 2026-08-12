/**
 * B.3.5.1 Windows hidden input UX / paste corrective — synthetic only.
 * Never uses operational MetaMask keys. No payment.
 */

import { describe, expect, it } from "vitest";

import {
  BLOCKED_B351_PASTE_SHORTCUT_NOT_SUPPORTED,
  BLOCKED_B35_SECRET_ENTRY_ABORTED,
  BLOCKED_B35_SECRET_ENTRY_INVALID,
} from "../../tools/trustforge/b35-execution-gates";
import { readHiddenParentTtySecret } from "../../tools/trustforge/buyer-hidden-tty-secret-entry";
import {
  SecretEntryLedger,
  stampAuthorizedSecretEntry,
} from "../../tools/trustforge/buyer-secret-entry-authorization";
import { buildSyntheticBuyerCredentialAccessAuthorization } from "../../tools/trustforge/buyer-credential-access-authorization";
import { buildSyntheticBuyerSigningAuthorization } from "../../tools/trustforge/buyer-signing-authorization";
import {
  buildUnsignedBuyerAuthorization,
  canonicalJsonSha256,
} from "../../tools/trustforge/buyer-eip3009-authorization";
import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import type { PreSignAttemptArtifact } from "../../tools/trustforge/buyer-pre-sign-validation";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import type { ValidatedBuyerAuthorizationForSigning } from "../../tools/trustforge/buyer-validated-signing";
import { stampAuthorizedCredentialAccessRequest } from "../../tools/trustforge/buyer-credential-provider";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "../../tools/trustforge/explicit-runtime-key-credential-provider";
import {
  SYNTHETIC_B33_RUNTIME_ADDRESS,
  SYNTHETIC_B33_RUNTIME_KEY,
} from "../support/trustforge-synthetic-runtime-key";
import { createSyntheticHiddenTty } from "../support/trustforge-synthetic-hidden-tty";

const BUYER = SYNTHETIC_B33_RUNTIME_ADDRESS;
const PAY_TO = "0x2222222222222222222222222222222222222222";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NONCE = `0x${"22".repeat(32)}`;
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";
const SIGNING_TIME = new Date("2026-01-01T00:01:00.000Z");

/** Deterministic synthetic fixture — not an operational key. */
const SYNTHETIC_64_HEX =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0fedcba9876543210";

function assertNoSecretLeak(text: string): void {
  expect(text.includes(SYNTHETIC_B33_RUNTIME_KEY)).toBe(false);
  expect(text.includes(SYNTHETIC_64_HEX)).toBe(false);
  expect(text.toLowerCase().includes(SYNTHETIC_64_HEX)).toBe(false);
}

function authBundle() {
  const h: HumanPaymentAuthorization = {
    authorization_schema_version: "v3",
    decision: "approve",
    provider: "fixture",
    service_id: "svc",
    endpoint: "https://seller.example/api",
    method: "POST",
    canonical_requirements_sha256: "req-sha",
    canonical_envelope_sha256: "env-sha",
    request_binding_sha256: "rb-sha",
    seller_network_raw: "base",
    canonical_network_caip2: "eip155:8453",
    asset: ASSET,
    pay_to: PAY_TO,
    amount_atomic: "1000",
    maximum_authorized_amount_atomic: "2000",
    buyer_wallet: BUYER,
    max_usdc: "0.002",
    max_payment_attempts: 1,
    allow_retry: false,
    authorization_expires_at: "2026-01-01T00:10:00.000Z",
  };
  const obs: SellerRequirementsObservation = {
    requirements_observed_at: OBSERVED_AT,
    selected_requirements: {},
    payment_required_envelope: {},
    ancillary_tempo_evidence: null,
    binding: {
      protocol_version: 1,
      transport: "payment-required-header",
      scheme: "exact",
      seller_network_raw: "base",
      canonical_network_caip2: "eip155:8453",
      asset: ASSET,
      amount_field: "maxAmountRequired",
      amount_atomic: "1000",
      pay_to: PAY_TO,
      max_timeout_seconds: 600,
      resource: null,
      extra: { name: "USD Coin", version: "2" },
      request_binding_sha256: "rb-sha",
      canonical_requirements_sha256: "req-sha",
      canonical_envelope_sha256: "env-sha",
    },
  };
  const built = buildUnsignedBuyerAuthorization({
    humanAuthorization: h,
    paytimeObservation: obs,
    authorizedRequirementsSha256: "req-sha",
    authorizedEnvelopeSha256: "env-sha",
    authorizedRequestBindingSha256: "rb-sha",
    authorizedEndpoint: "https://seller.example/api",
    authorizedMethod: "POST",
    buyerAddress: BUYER,
    signingTime: SIGNING_TIME,
    nonce: NONCE,
  });
  const attempt: PreSignAttemptArtifact = {
    schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
    run_id: "run",
    attempt_id: "attempt",
    commit_sha: null,
    created_at: SIGNING_TIME.toISOString(),
    state: "RESERVED",
    reserved_at: SIGNING_TIME.toISOString(),
    endpoint: "https://seller.example/api",
    method: "POST",
    max_payment_attempts: 1,
    allow_retry: false,
  };
  const unsignedArtifact: UnsignedArtifact = {
    schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
    run_id: "run",
    attempt_id: "attempt",
    commit_sha: null,
    created_at: SIGNING_TIME.toISOString(),
    state: "UNSIGNED_PERSISTED",
    signing_time: built.signing_time,
    human_authorization_sha256: canonicalJsonSha256(h),
    canonical_requirements_sha256: "req-sha",
    canonical_envelope_sha256: "env-sha",
    request_binding_sha256: "rb-sha",
    endpoint: "https://seller.example/api",
    method: "POST",
    protocol_version: 1,
    seller_network_raw: "base",
    canonical_network_caip2: "eip155:8453",
    chain_id: 8453,
    asset: ASSET,
    pay_to: PAY_TO,
    seller_amount_atomic: built.seller_amount_atomic,
    maximum_authorized_amount_atomic: built.maximum_authorized_amount_atomic,
    buyer_wallet: BUYER,
    paytime_requirements_observed_at: OBSERVED_AT,
    effective_signing_deadline: built.effective_signing_deadline,
    valid_after: built.message.validAfter,
    valid_before: built.message.validBefore,
    nonce: built.message.nonce,
    domain: built.domain,
    domain_provenance: built.domain_provenance,
    types: built.types,
    primary_type: built.primary_type,
    message: built.message,
    canonical_unsigned_payload_sha256: built.canonical_unsigned_payload_sha256,
  };
  const unsignedHash = canonicalJsonSha256(unsignedArtifact);
  const signingAuthorization = buildSyntheticBuyerSigningAuthorization({
    decisionId: "sign-b351",
    prepareAuthorizationSha256: canonicalJsonSha256(h),
    unsignedArtifact,
    unsignedArtifactSha256: unsignedHash,
    signingAuthorizationExpiresAt: h.authorization_expires_at!,
  });
  const signingAuthorizationSha256 = canonicalJsonSha256(signingAuthorization);
  const credentialAccessAuthorization = buildSyntheticBuyerCredentialAccessAuthorization({
    decisionId: "cred-b351",
    signingAuthorization,
    signingAuthorizationSha256,
    unsignedArtifact,
    unsignedArtifactSha256: unsignedHash,
    providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
    credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
    expectedSignerAddress: BUYER,
    accessExpiresAt: h.authorization_expires_at!,
  });
  const stamped = stampAuthorizedCredentialAccessRequest({
    accessAuthorization: credentialAccessAuthorization,
    accessAuthorizationSha256: canonicalJsonSha256(credentialAccessAuthorization),
    context: {
      expectedSignerAddress: BUYER,
      attemptId: "attempt",
      runId: "run",
      unsignedArtifactSha256: unsignedHash,
      signingAuthorizationSha256,
    },
    validated: {
      __brand: "ValidatedBuyerAuthorizationForSigning",
      unsignedArtifact,
      unsignedArtifactSha256: unsignedHash,
      signingAuthorization,
      signingAuthorizationSha256,
      typedData: {
        domain: unsignedArtifact.domain,
        types: unsignedArtifact.types,
        primaryType: unsignedArtifact.primary_type,
        message: unsignedArtifact.message,
      },
    } as unknown as ValidatedBuyerAuthorizationForSigning,
  });
  const authorization = stampAuthorizedSecretEntry({
    authorizedRequest: stamped,
    credentialAccessEnabled: true,
  });
  void attempt;
  return { authorization };
}

function lastMaskStars(safeOutput: string[]): number {
  const joined = safeOutput.join("");
  const matches = [...joined.matchAll(/Private key: (\**)/g)];
  if (matches.length === 0) return -1;
  return matches[matches.length - 1]![1]!.length;
}

describe("B.3.5.1 Windows hidden input UX", () => {
  it("host-style paste of 64 hex: mask shows 64 stars and structural PASS", async () => {
    const { authorization } = authBundle();
    const tty = createSyntheticHiddenTty();
    tty.enqueueHostPasteHexThenEnter(SYNTHETIC_64_HEX);
    const ledger = new SecretEntryLedger();
    ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
    const result = await readHiddenParentTtySecret({
      authorization,
      terminal: tty.terminal,
      ledger,
    });
    expect(result.credentialBytes.byteLength).toBe(32);
    expect(result.evidence.accepted_ascii_length).toBe(64);
    expect(result.evidence.ctrl_v_control_bytes_ignored).toBe(0);
    expect(result.evidence.pasteboard_api_accessed).toBe(false);
    expect(lastMaskStars(tty.safeOutput)).toBe(64);
    assertNoSecretLeak(tty.safeOutput.join(""));
  });

  it("typed characters update mask progressively", async () => {
    const { authorization } = authBundle();
    const tty = createSyntheticHiddenTty();
    tty.enqueueBytes([0x61, 0x62, 0x63, 0x64]); // abcd
    tty.enqueueBytes([0x0d]);
    const ledger = new SecretEntryLedger();
    ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
    await expect(
      readHiddenParentTtySecret({
        authorization,
        terminal: tty.terminal,
        ledger,
      }),
    ).rejects.toThrow(BLOCKED_B35_SECRET_ENTRY_INVALID);
    expect(lastMaskStars(tty.safeOutput)).toBe(4);
    const out = tty.safeOutput.join("");
    expect(out).toContain("received character count: 4");
    expect(out).toContain("hex-only: yes");
    assertNoSecretLeak(out);
  });

  it("Ctrl+V 0x16 is never appended; empty Enter → PASTE_SHORTCUT_NOT_SUPPORTED", async () => {
    const { authorization } = authBundle();
    const tty = createSyntheticHiddenTty();
    tty.enqueueCtrlVControlByte();
    tty.enqueueBytes([0x0d]);
    const ledger = new SecretEntryLedger();
    ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
    await expect(
      readHiddenParentTtySecret({
        authorization,
        terminal: tty.terminal,
        ledger,
      }),
    ).rejects.toThrow(BLOCKED_B351_PASTE_SHORTCUT_NOT_SUPPORTED);
    const out = tty.safeOutput.join("");
    expect(out).toContain("control byte");
    expect(out).toContain("received character count: 0");
    expect(out).not.toMatch(/Private key: \*[^*]/); // no stars from 0x16
    assertNoSecretLeak(out);
  });

  it("Ctrl+V then host paste of 64 hex succeeds; 0x16 not in credential", async () => {
    const { authorization } = authBundle();
    const tty = createSyntheticHiddenTty();
    tty.enqueueCtrlVControlByte();
    tty.enqueueHostPasteHexThenEnter(SYNTHETIC_64_HEX);
    const ledger = new SecretEntryLedger();
    ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
    const result = await readHiddenParentTtySecret({
      authorization,
      terminal: tty.terminal,
      ledger,
    });
    expect(result.credentialBytes.byteLength).toBe(32);
    expect(result.evidence.ctrl_v_control_bytes_ignored).toBe(1);
    expect(result.evidence.accepted_ascii_length).toBe(64);
    expect(lastMaskStars(tty.safeOutput)).toBe(64);
    assertNoSecretLeak(tty.safeOutput.join(""));
  });

  it("Backspace reduces mask stars", async () => {
    const { authorization } = authBundle();
    const tty = createSyntheticHiddenTty();
    tty.enqueueBytes([0x61, 0x62, 0x63, 0x08, 0x0d]); // abc, backspace, enter
    const ledger = new SecretEntryLedger();
    ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
    await expect(
      readHiddenParentTtySecret({
        authorization,
        terminal: tty.terminal,
        ledger,
      }),
    ).rejects.toThrow(BLOCKED_B35_SECRET_ENTRY_INVALID);
    expect(lastMaskStars(tty.safeOutput)).toBe(2);
  });

  it("Ctrl+C still aborts; Escape aborts", async () => {
    for (const enqueue of [
      (t: ReturnType<typeof createSyntheticHiddenTty>) => t.enqueueCtrlC(),
      (t: ReturnType<typeof createSyntheticHiddenTty>) => t.enqueueEscape(),
    ]) {
      const { authorization } = authBundle();
      const tty = createSyntheticHiddenTty();
      enqueue(tty);
      const ledger = new SecretEntryLedger();
      ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
      await expect(
        readHiddenParentTtySecret({
          authorization,
          terminal: tty.terminal,
          ledger,
        }),
      ).rejects.toThrow(BLOCKED_B35_SECRET_ENTRY_ABORTED);
      expect(tty.terminal.getRawMode()).toBe(false);
    }
  });

  it("existing synthetic runtime key (0x+64) still accepted with mask", async () => {
    const { authorization } = authBundle();
    const tty = createSyntheticHiddenTty();
    tty.enqueueHexKeyThenEnter(SYNTHETIC_B33_RUNTIME_KEY);
    const ledger = new SecretEntryLedger();
    ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
    const result = await readHiddenParentTtySecret({
      authorization,
      terminal: tty.terminal,
      ledger,
    });
    expect(result.credentialBytes.byteLength).toBe(32);
    expect(result.evidence.accepted_ascii_length).toBe(66);
    expect(lastMaskStars(tty.safeOutput)).toBe(66);
    assertNoSecretLeak(tty.safeOutput.join(""));
  });
});
