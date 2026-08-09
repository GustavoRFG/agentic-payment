/**
 * B.2 pre-sign temporal/authorization gate — offline fixtures + real stale artifact.
 *
 * No real keys, no wallet env, no network, no payment headers, no send.
 * Real reference nonce is never printed.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import {
  buildUnsignedBuyerAuthorization,
  canonicalJsonSha256,
  signUnsignedAuthorization,
  type InjectedTypedDataSigner,
} from "../../tools/trustforge/buyer-eip3009-authorization";
import {
  BLOCKED_BUYER_ATTEMPT_STATE_NOT_SIGNABLE,
  BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
  BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
  BLOCKED_HUMAN_AUTHORIZATION_EXPIRED,
  BLOCKED_PAYMENT_REQUIREMENTS_STALE,
  validateBuyerAuthorizationBeforeSigning,
  type PreSignAttemptArtifact,
} from "../../tools/trustforge/buyer-pre-sign-validation";
import { buildSyntheticBuyerSigningAuthorization } from "../../tools/trustforge/buyer-signing-authorization";
import { prepareValidatedBuyerAuthorizationForSigning } from "../../tools/trustforge/buyer-validated-signing";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";

function signWithValidated(input: {
  readonly unsignedArtifact: UnsignedArtifact;
  readonly attempt: PreSignAttemptArtifact;
  readonly humanAuthorization: HumanPaymentAuthorization;
  readonly now: Date;
  readonly signer: InjectedTypedDataSigner;
  readonly expectedUnsignedHash?: string | null;
}) {
  const unsignedHash =
    input.expectedUnsignedHash ?? canonicalJsonSha256(input.unsignedArtifact);
  const signingAuthorization = buildSyntheticBuyerSigningAuthorization({
    decisionId: `presign_${input.attempt.attempt_id}`,
    prepareAuthorizationSha256: canonicalJsonSha256(input.humanAuthorization),
    unsignedArtifact: input.unsignedArtifact,
    unsignedArtifactSha256: unsignedHash,
    signingAuthorizationExpiresAt:
      input.humanAuthorization.authorization_expires_at ?? "2099-01-01T00:00:00.000Z",
  });
  const validated = prepareValidatedBuyerAuthorizationForSigning({
    unsignedArtifact: input.unsignedArtifact,
    attempt: input.attempt,
    humanAuthorization: input.humanAuthorization,
    signingAuthorization,
    now: input.now,
    expectedUnsignedHash: input.expectedUnsignedHash,
  });
  return signUnsignedAuthorization({
    validated,
    signer: input.signer,
    now: input.now,
  });
}

const BUYER = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NONCE = `0x${"11".repeat(32)}`;
const SIGNATURE = `0x${"ab".repeat(65)}`;
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";
const SIGNING_TIME = new Date("2026-01-01T00:01:00.000Z");

const REF_RUN =
  "D:\\trustforge\\artifacts\\runs\\b2-onesource-prepare-only\\run_20260807_131658";
const REF_ATTEMPT = "attempt_2026-08-07T16-40-38-617Z";
const REF_ATTEMPT_DIR = join(REF_RUN, "buyer_authorization", REF_ATTEMPT);
const EXPECTED_FILE_HASH =
  "f43bb5a49bf5c92e07425c562c5f3158329cc29536733f27e167c68a4665b57f";

function fixtureSigner(address = BUYER): InjectedTypedDataSigner & { calls: number } {
  const signer = {
    address,
    calls: 0,
    async signTypedData() {
      signer.calls += 1;
      return SIGNATURE;
    },
  };
  return signer;
}

function observation(): SellerRequirementsObservation {
  return {
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
}

function human(overrides: Partial<HumanPaymentAuthorization> = {}): HumanPaymentAuthorization {
  return {
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
    ...overrides,
  };
}

function buildFreshBundle(overrides: {
  readonly human?: HumanPaymentAuthorization;
  readonly now?: Date;
  readonly nonce?: string;
} = {}) {
  const h = overrides.human ?? human();
  const now = overrides.now ?? SIGNING_TIME;
  const built = buildUnsignedBuyerAuthorization({
    humanAuthorization: h,
    paytimeObservation: observation(),
    authorizedRequirementsSha256: "req-sha",
    authorizedEnvelopeSha256: "env-sha",
    authorizedRequestBindingSha256: "rb-sha",
    authorizedEndpoint: "https://seller.example/api",
    authorizedMethod: "POST",
    buyerAddress: BUYER,
    signingTime: now,
    nonce: overrides.nonce ?? NONCE,
  });
  const attempt: PreSignAttemptArtifact = {
    schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
    run_id: "run",
    attempt_id: "attempt",
    commit_sha: null,
    created_at: now.toISOString(),
    state: "RESERVED",
    reserved_at: now.toISOString(),
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
    created_at: now.toISOString(),
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
  return { human: h, attempt, unsignedArtifact, now };
}

describe("pre-sign validation — synthetic temporal boundaries", () => {
  it("documents ms vs unix-second comparison units", () => {
    const { unsignedArtifact, human: h, attempt } = buildFreshBundle();
    const deadlineMs = Date.parse(unsignedArtifact.effective_signing_deadline);
    const validBeforeSec = Number(unsignedArtifact.valid_before);
    expect(Number.isInteger(validBeforeSec)).toBe(true);
    expect(Math.floor(deadlineMs / 1000)).toBe(validBeforeSec);
    // human/deadline gates use ms; validBefore uses integer seconds
    expect(() =>
      validateBuyerAuthorizationBeforeSigning({
        unsignedArtifact,
        attempt,
        humanAuthorization: h,
        now: new Date(deadlineMs - 1),
      }),
    ).not.toThrow();
  });

  it.each([
    ["before", -1_000, true],
    ["equal", 0, false],
    ["after", 1_000, false],
  ] as const)("human authorization expiry: now %s expires_at → %s", (_label, deltaMs, ok) => {
    const expires = "2026-01-01T00:10:00.000Z";
    const expiresMs = Date.parse(expires);
    // Keep deadline/validBefore after the probe time when testing human expiry in isolation
    // by using a far human expiry only when probing continue; for block cases use exact expires.
    const { unsignedArtifact, attempt } = buildFreshBundle({
      human: human({ authorization_expires_at: expires }),
    });
    // Rebuild so deadline ≤ human expiry with this expires value
    const bundle = buildFreshBundle({
      human: human({ authorization_expires_at: expires }),
    });
    const now = new Date(expiresMs + deltaMs);
    if (ok) {
      // must also be before effective deadline
      const beforeDeadline = new Date(
        Math.min(expiresMs + deltaMs, Date.parse(bundle.unsignedArtifact.effective_signing_deadline) - 1),
      );
      expect(() =>
        validateBuyerAuthorizationBeforeSigning({
          unsignedArtifact: bundle.unsignedArtifact,
          attempt: bundle.attempt,
          humanAuthorization: bundle.human,
          now: beforeDeadline,
        }),
      ).not.toThrow();
    } else {
      expect(() =>
        validateBuyerAuthorizationBeforeSigning({
          unsignedArtifact: bundle.unsignedArtifact,
          attempt: bundle.attempt,
          humanAuthorization: bundle.human,
          now,
        }),
      ).toThrow(new RegExp(BLOCKED_HUMAN_AUTHORIZATION_EXPIRED));
    }
    void unsignedArtifact;
    void attempt;
  });

  it.each([
    ["before", -1, true],
    ["equal", 0, false],
    ["after", 1_000, false],
  ] as const)("effective signing deadline: now %s deadline → continue=%s", (_label, deltaMs, ok) => {
    const bundle = buildFreshBundle();
    const deadlineMs = Date.parse(bundle.unsignedArtifact.effective_signing_deadline);
    const now = new Date(deadlineMs + deltaMs);
    if (ok) {
      expect(() =>
        validateBuyerAuthorizationBeforeSigning({
          ...bundle,
          humanAuthorization: bundle.human,
          now,
        }),
      ).not.toThrow();
    } else {
      expect(() =>
        validateBuyerAuthorizationBeforeSigning({
          ...bundle,
          humanAuthorization: bundle.human,
          now,
        }),
      ).toThrow(new RegExp(BLOCKED_PAYMENT_REQUIREMENTS_STALE));
    }
  });

  it.each([
    ["before", -1, true],
    ["equal", 0, false],
    ["after", 1, false],
  ] as const)("validBefore seconds: nowSec %s validBefore → continue=%s", (_label, deltaSec, ok) => {
    // Use a sub-second deadline so the ms deadline gate can still pass when
    // unix-second now equals validBefore (validBefore = floor(deadlineMs/1000)).
    const bundle = buildFreshBundle();
    const validBeforeSec = Number(bundle.unsignedArtifact.valid_before);
    const deadlineWithRemainder = new Date(validBeforeSec * 1000 + 500).toISOString();
    const unsignedArtifact = {
      ...bundle.unsignedArtifact,
      effective_signing_deadline: deadlineWithRemainder,
    };
    // Keep validBefore bound to floor(deadline) — already validBeforeSec.
    const now = new Date((validBeforeSec + deltaSec) * 1000);
    expect(Math.floor(now.getTime() / 1000)).toBe(validBeforeSec + deltaSec);
    if (ok) {
      expect(() =>
        validateBuyerAuthorizationBeforeSigning({
          unsignedArtifact,
          attempt: bundle.attempt,
          humanAuthorization: bundle.human,
          now,
        }),
      ).not.toThrow();
    } else if (deltaSec === 0) {
      // Equality hits the unix-second validBefore gate while ms deadline still passes.
      expect(() =>
        validateBuyerAuthorizationBeforeSigning({
          unsignedArtifact,
          attempt: bundle.attempt,
          humanAuthorization: bundle.human,
          now,
        }),
      ).toThrow(new RegExp(BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID));
    } else {
      // nowSec > validBefore implies nowMs past the bound deadline second; the
      // millisecond deadline gate may fire first. Either current-time gate is BLOCK.
      expect(() =>
        validateBuyerAuthorizationBeforeSigning({
          unsignedArtifact,
          attempt: bundle.attempt,
          humanAuthorization: bundle.human,
          now,
        }),
      ).toThrow(
        new RegExp(
          `${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}|${BLOCKED_PAYMENT_REQUIREMENTS_STALE}`,
        ),
      );
    }
  });
});

describe("pre-sign validation — adversarial bindings", () => {
  it("blocks mutations before the signer", async () => {
    const base = buildFreshBundle();
    const expectedUnsignedHash = canonicalJsonSha256(base.unsignedArtifact);
    const signer = fixtureSigner();
    const cases: Array<{ label: string; mutate: () => {
      unsignedArtifact: UnsignedArtifact;
      attempt: PreSignAttemptArtifact;
      humanAuthorization: HumanPaymentAuthorization;
    }; code: string }> = [
      {
        label: "extend human expiry sticker without rebinding hash",
        mutate: () => ({
          ...base,
          humanAuthorization: {
            ...base.human,
            authorization_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "extend effective deadline",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            effective_signing_deadline: "2099-01-01T00:00:00.000Z",
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "extend validBefore",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            valid_before: String(Number(base.unsignedArtifact.valid_before) + 10_000),
            message: {
              ...base.unsignedArtifact.message,
              validBefore: String(Number(base.unsignedArtifact.valid_before) + 10_000),
            },
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace pay-time observation timestamp",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            paytime_requirements_observed_at: "2099-01-01T00:00:00.000Z",
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace attempt ID",
        mutate: () => ({
          ...base,
          unsignedArtifact: { ...base.unsignedArtifact, attempt_id: "other" },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace nonce",
        mutate: () => {
          const nonce = `0x${"33".repeat(32)}`;
          return {
            ...base,
            unsignedArtifact: {
              ...base.unsignedArtifact,
              nonce,
              message: { ...base.unsignedArtifact.message, nonce },
            },
          };
        },
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace authorization hash",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            human_authorization_sha256: "ff".repeat(32),
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace requirements hash",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            canonical_requirements_sha256: "aa".repeat(32),
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace envelope hash",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            canonical_envelope_sha256: "bb".repeat(32),
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace buyer",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            buyer_wallet: "0x7777777777777777777777777777777777777777",
            message: {
              ...base.unsignedArtifact.message,
              from: "0x7777777777777777777777777777777777777777",
            },
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace payTo",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            pay_to: "0x6666666666666666666666666666666666666666",
            message: {
              ...base.unsignedArtifact.message,
              to: "0x6666666666666666666666666666666666666666",
            },
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace amount",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            seller_amount_atomic: "999",
            message: { ...base.unsignedArtifact.message, value: "999" },
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace domain",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            domain: { ...base.unsignedArtifact.domain, name: "Other" },
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "replace chain ID",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            chain_id: 1,
            domain: { ...base.unsignedArtifact.domain, chainId: 1 },
          },
        }),
        code: BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      },
      {
        label: "wrong state",
        mutate: () => ({
          ...base,
          unsignedArtifact: {
            ...base.unsignedArtifact,
            state: "RESERVED" as unknown as "UNSIGNED_PERSISTED",
          },
        }),
        code: BLOCKED_BUYER_ATTEMPT_STATE_NOT_SIGNABLE,
      },
    ];

    for (const c of cases) {
      const mutated = c.mutate();
      await expect(
        () =>
          validateBuyerAuthorizationBeforeSigning({
            unsignedArtifact: mutated.unsignedArtifact,
            attempt: mutated.attempt,
            humanAuthorization: mutated.humanAuthorization,
            now: SIGNING_TIME,
            expectedUnsignedHash,
          }),
        c.label,
      ).toThrow(new RegExp(c.code));
    }
    expect(signer.calls).toBe(0);
  });

  it("positive fresh fixture reaches the signer spy exactly once", async () => {
    const bundle = buildFreshBundle();
    const signer = fixtureSigner();
    const result = await signWithValidated({
      unsignedArtifact: bundle.unsignedArtifact,
      attempt: bundle.attempt,
      humanAuthorization: bundle.human,
      now: SIGNING_TIME,
      signer,
      expectedUnsignedHash: canonicalJsonSha256(bundle.unsignedArtifact),
    });
    expect(signer.calls).toBe(1);
    expect(result.signature).toBe(SIGNATURE);
  });

  it("reload before deadline remains eligible; at/after deadline blocks", async () => {
    const bundle = buildFreshBundle();
    // simulate reload: JSON round-trip
    const reloaded = JSON.parse(JSON.stringify(bundle.unsignedArtifact)) as UnsignedArtifact;
    const attemptReloaded = JSON.parse(JSON.stringify(bundle.attempt)) as PreSignAttemptArtifact;
    const humanReloaded = JSON.parse(JSON.stringify(bundle.human)) as HumanPaymentAuthorization;
    const signer = fixtureSigner();

    await signWithValidated({
      unsignedArtifact: reloaded,
      attempt: attemptReloaded,
      humanAuthorization: humanReloaded,
      now: new Date(Date.parse(reloaded.effective_signing_deadline) - 1),
      signer,
    });
    expect(signer.calls).toBe(1);

    await expect(
      (async () =>
        signWithValidated({
          unsignedArtifact: reloaded,
          attempt: attemptReloaded,
          humanAuthorization: humanReloaded,
          now: new Date(Date.parse(reloaded.effective_signing_deadline)),
          signer,
        }))(),
    ).rejects.toThrow(new RegExp(BLOCKED_PAYMENT_REQUIREMENTS_STALE));
    await expect(
      (async () =>
        signWithValidated({
          unsignedArtifact: reloaded,
          attempt: attemptReloaded,
          humanAuthorization: humanReloaded,
          now: new Date(Date.parse(reloaded.effective_signing_deadline) + 1),
          signer,
        }))(),
    ).rejects.toThrow(new RegExp(BLOCKED_PAYMENT_REQUIREMENTS_STALE));
    expect(signer.calls).toBe(1);
  });
});

describe("pre-sign validation — real stale attempt rejection", () => {
  it("rejects the persisted OneSource unsigned attempt before signer", async () => {
    if (!existsSync(REF_ATTEMPT_DIR)) {
      throw new Error(`reference attempt missing: ${REF_ATTEMPT_DIR}`);
    }
    const unsignedPath = join(REF_ATTEMPT_DIR, "buyer_authorization_unsigned.json");
    const attemptPath = join(REF_ATTEMPT_DIR, "buyer_authorization_attempt.json");
    const humanPath = join(REF_RUN, "human_payment_authorization.json");
    const fileHash = createHash("sha256").update(readFileSync(unsignedPath)).digest("hex");
    expect(fileHash).toBe(EXPECTED_FILE_HASH);

    const unsignedArtifact = JSON.parse(readFileSync(unsignedPath, "utf8")) as UnsignedArtifact;
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8")) as PreSignAttemptArtifact;
    const humanAuthorization = JSON.parse(
      readFileSync(humanPath, "utf8"),
    ) as HumanPaymentAuthorization;

    // Structural presence only — never print nonce
    expect(typeof unsignedArtifact.nonce).toBe("string");
    expect(/^0x[0-9a-f]{64}$/.test(unsignedArtifact.nonce)).toBe(true);

    const signer = fixtureSigner(unsignedArtifact.buyer_wallet);
    const now = new Date();
    await expect(
      (async () =>
        signWithValidated({
          unsignedArtifact,
          attempt,
          humanAuthorization,
          now,
          signer,
        }))(),
    ).rejects.toThrow(
      /BLOCKED_HUMAN_AUTHORIZATION_EXPIRED|BLOCKED_PAYMENT_REQUIREMENTS_STALE|BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID/,
    );
    expect(signer.calls).toBe(0);
    expect(unsignedArtifact.state).toBe("UNSIGNED_PERSISTED");
  });
});
