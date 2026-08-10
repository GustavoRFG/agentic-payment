/**
 * B.3.2 signer mechanism selection — registry, inactive adapters, no secrets.
 */

import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH,
  BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS,
  BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN,
  BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE,
} from "../../tools/trustforge/b32-execution-gates";
import {
  B32_CREDENTIAL_MEMORY_LIFECYCLE_POLICY,
  acquireExplicitRuntimeKeySignerInactive,
  assertRestrictedSignerSurface,
  createInactiveEncryptedLocalKeystoreProvider,
  createInactiveExplicitRuntimeKeyProvider,
  createInactiveExternalSignerProvider,
  createInactiveSecureSigningProvider,
} from "../../tools/trustforge/buyer-credential-provider-adapters";
import {
  assertExplicitProviderSelection,
  assertRealBackendActivationAllowed,
  rejectUnknownProviderId,
  resolveProductiveCredentialProvider,
} from "../../tools/trustforge/buyer-credential-provider-registry";
import {
  loadB31CredentialProviderPolicy,
  validateB31CredentialProviderPolicy,
  type B31CredentialProviderPolicy,
} from "../../tools/trustforge/b31-credential-provider-policy";
import { stampAuthorizedCredentialAccessRequest } from "../../tools/trustforge/buyer-credential-provider";
import { BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED } from "../../tools/trustforge/b31-execution-gates";
import { runCredentialGatedBuyerSigning } from "../../tools/trustforge/buyer-credential-gated-signing";
import { BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED } from "../../tools/trustforge/b3-execution-gates";
import type { HexAddress } from "../../tools/trustforge/buyer-authorization-signer";
import {
  createSyntheticBuyerCredentialProvider,
  SYNTHETIC_CREDENTIAL_KIND,
  SYNTHETIC_CREDENTIAL_PROVIDER_ID,
} from "../support/trustforge-synthetic-credential-provider";

// Reuse B.3.1 fixture builders via dynamic import of shared patterns.
import { createHash } from "node:crypto";
import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import { UNSIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import { buildSyntheticBuyerCredentialAccessAuthorization } from "../../tools/trustforge/buyer-credential-access-authorization";
import {
  buildUnsignedBuyerAuthorization,
  canonicalJsonSha256,
} from "../../tools/trustforge/buyer-eip3009-authorization";
import type { PreSignAttemptArtifact } from "../../tools/trustforge/buyer-pre-sign-validation";
import { buildSyntheticBuyerSigningAuthorization } from "../../tools/trustforge/buyer-signing-authorization";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import type { ValidatedBuyerAuthorizationForSigning } from "../../tools/trustforge/buyer-validated-signing";
import type { BuyerCredentialAccessAuthorization } from "../../tools/trustforge/buyer-credential-access-authorization";

const BUYER = "0x1111111111111111111111111111111111111111" as HexAddress;
const OTHER = "0x7777777777777777777777777777777777777777" as HexAddress;
const PAY_TO = "0x2222222222222222222222222222222222222222";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NONCE = `0x${"11".repeat(32)}`;
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";
const SIGNING_TIME = new Date("2026-01-01T00:01:00.000Z");

const REF_RUN =
  "D:\\trustforge\\artifacts\\runs\\b2-onesource-prepare-only\\run_20260807_131658";
const REF_ATTEMPT_DIR = join(
  REF_RUN,
  "buyer_authorization",
  "attempt_2026-08-07T16-40-38-617Z",
);

const temporaryDirs: string[] = [];
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b32-mech-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length) {
    const dir = temporaryDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function basePolicy(overrides: Record<string, unknown> = {}): B31CredentialProviderPolicy {
  const validated = validateB31CredentialProviderPolicy({
    schema_version: "trustforge_buyer_credential_provider_policy.v2",
    credential_provider_configured: true,
    allowed_provider_ids: [
      "inactive_production",
      "explicit-runtime-key",
      "encrypted-local-keystore",
      "external-signer",
      "secure-signing-provider",
    ],
    selected_productive_provider_id: "NONE",
    provider_id: "inactive_production",
    credential_kind: "none",
    expected_signer_address: null,
    credential_access_enabled: false,
    real_backend_activation: false,
    credential_caching_enabled: false,
    automatic_discovery_enabled: false,
    fallback_provider_enabled: false,
    real_signing_enabled: false,
    payment_bearing_send_enabled: false,
    settlement_enabled: false,
    retry_enabled: false,
    effect: "test",
    ...overrides,
  });
  if (!validated.ok) throw new Error(validated.reason);
  return validated.policy;
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

function human(): HumanPaymentAuthorization {
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
  };
}

function buildBundle() {
  const h = human();
  const built = buildUnsignedBuyerAuthorization({
    humanAuthorization: h,
    paytimeObservation: observation(),
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
    decisionId: "sign-1",
    prepareAuthorizationSha256: canonicalJsonSha256(h),
    unsignedArtifact,
    unsignedArtifactSha256: unsignedHash,
    signingAuthorizationExpiresAt: h.authorization_expires_at!,
  });
  const signingAuthorizationSha256 = canonicalJsonSha256(signingAuthorization);
  const credentialAccessAuthorization = buildSyntheticBuyerCredentialAccessAuthorization({
    decisionId: "cred-1",
    signingAuthorization,
    signingAuthorizationSha256,
    unsignedArtifact,
    unsignedArtifactSha256: unsignedHash,
    providerId: SYNTHETIC_CREDENTIAL_PROVIDER_ID,
    credentialKind: SYNTHETIC_CREDENTIAL_KIND,
    expectedSignerAddress: BUYER,
    accessExpiresAt: h.authorization_expires_at!,
  });
  return {
    human: h,
    attempt,
    unsignedArtifact,
    unsignedHash,
    signingAuthorization,
    signingAuthorizationSha256,
    credentialAccessAuthorization,
  };
}

function writePolicy(dir: string, overrides: Record<string, unknown> = {}) {
  const path = join(dir, "credential_provider_policy.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schema_version: "trustforge_buyer_credential_provider_policy.v2",
        credential_provider_configured: true,
        allowed_provider_ids: [SYNTHETIC_CREDENTIAL_PROVIDER_ID],
        selected_productive_provider_id: "NONE",
        provider_id: SYNTHETIC_CREDENTIAL_PROVIDER_ID,
        credential_kind: SYNTHETIC_CREDENTIAL_KIND,
        expected_signer_address: BUYER,
        credential_access_enabled: true,
        real_backend_activation: false,
        credential_caching_enabled: false,
        automatic_discovery_enabled: false,
        fallback_provider_enabled: false,
        real_signing_enabled: false,
        payment_bearing_send_enabled: false,
        settlement_enabled: false,
        retry_enabled: false,
        effect: "b32 synthetic",
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path;
}

function fakeValidated(
  unsigned: UnsignedArtifact,
  unsignedHash: string,
  signingAuth: ReturnType<typeof buildSyntheticBuyerSigningAuthorization>,
  signingAuthHash: string,
): ValidatedBuyerAuthorizationForSigning {
  return {
    __brand: "ValidatedBuyerAuthorizationForSigning",
    unsignedArtifact: unsigned,
    unsignedArtifactSha256: unsignedHash,
    signingAuthorization: signingAuth,
    signingAuthorizationSha256: signingAuthHash,
    typedData: {
      __brand: "ValidatedBuyerTypedData",
      domain: unsigned.domain,
      types: unsigned.types,
      primaryType: unsigned.primary_type,
      message: unsigned.message,
    },
  } as unknown as ValidatedBuyerAuthorizationForSigning;
}

describe("B.3.2 production policy", () => {
  it("loads v2 inactive registry policy", () => {
    const policy = loadB31CredentialProviderPolicy();
    expect(policy.schema_version).toBe("trustforge_buyer_credential_provider_policy.v2");
    expect(policy.credential_access_enabled).toBe(false);
    expect(policy.real_backend_activation).toBe(false);
    expect(policy.credential_caching_enabled).toBe(false);
    expect(policy.selected_productive_provider_id).toBe("explicit-runtime-key");
    expect(policy.provider_id).toBe("explicit-runtime-key");
    expect(policy.adapter_installed).toBe(true);
    expect(policy.allowed_provider_ids).toContain("explicit-runtime-key");
    expect(policy.fallback_provider_enabled).toBe(false);
  });

  it("rejects real_backend_activation true", () => {
    const result = validateB31CredentialProviderPolicy({
      ...loadB31CredentialProviderPolicy(),
      real_backend_activation: true,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects credential caching", () => {
    const result = validateB31CredentialProviderPolicy({
      ...loadB31CredentialProviderPolicy(),
      credential_caching_enabled: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe("B.3.2 provider registry", () => {
  it("requires explicit provider id and rejects unknown", () => {
    expect(() => rejectUnknownProviderId("not-a-provider")).toThrow(
      BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN,
    );
  });

  it("rejects ambiguous selected vs configured", () => {
    expect(() =>
      assertExplicitProviderSelection({
        policy: basePolicy({
          provider_id: "explicit-runtime-key",
          credential_kind: "explicit_runtime_private_key",
          selected_productive_provider_id: "external-signer",
        }),
      }),
    ).toThrow(BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS);
  });

  it("resolves adapters; non-runtime-key stay inactive; runtime-key needs credential", async () => {
    const inactiveCases: Array<{
      provider_id: string;
      credential_kind: string;
    }> = [
      { provider_id: "encrypted-local-keystore", credential_kind: "encrypted_local_keystore" },
      { provider_id: "external-signer", credential_kind: "external_signer" },
      { provider_id: "secure-signing-provider", credential_kind: "secure_signing_provider" },
    ];
    for (const c of inactiveCases) {
      const provider = resolveProductiveCredentialProvider(
        basePolicy({
          provider_id: c.provider_id,
          credential_kind: c.credential_kind,
          selected_productive_provider_id: "NONE",
        }),
      );
      expect(provider.providerId).toBe(c.provider_id);
      await expect(
        provider.acquireSigner(
          stampAuthorizedCredentialAccessRequest({
            accessAuthorization: {
              provider_id: c.provider_id,
              credential_kind: c.credential_kind,
            } as BuyerCredentialAccessAuthorization,
            accessAuthorizationSha256: "x",
            context: {
              expectedSignerAddress: BUYER,
              attemptId: "a",
              runId: "r",
              unsignedArtifactSha256: "u",
              signingAuthorizationSha256: "s",
            },
            validated: fakeValidated(
              buildBundle().unsignedArtifact,
              "u",
              buildBundle().signingAuthorization,
              "s",
            ),
          }),
        ),
      ).rejects.toThrow(BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE);
    }

    const runtime = resolveProductiveCredentialProvider(
      basePolicy({
        provider_id: "explicit-runtime-key",
        credential_kind: "explicit_runtime_private_key",
        selected_productive_provider_id: "explicit-runtime-key",
        adapter_installed: true,
      }),
    );
    const bundle = buildBundle();
    await expect(
      runtime.acquireSigner(
        stampAuthorizedCredentialAccessRequest({
          accessAuthorization: {
            ...bundle.credentialAccessAuthorization,
            provider_id: "explicit-runtime-key",
            credential_kind: "explicit_runtime_private_key",
          },
          accessAuthorizationSha256: "x",
          context: {
            expectedSignerAddress: BUYER,
            attemptId: "a",
            runId: "r",
            unsignedArtifactSha256: bundle.unsignedHash,
            signingAuthorizationSha256: bundle.signingAuthorizationSha256,
          },
          validated: fakeValidated(
            bundle.unsignedArtifact,
            bundle.unsignedHash,
            bundle.signingAuthorization,
            bundle.signingAuthorizationSha256,
          ),
        }),
      ),
    ).rejects.toThrow(/BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_MISSING|BLOCKED_B33_RUNTIME_KEY_UNAUTHORIZED_ACCESS/);
  });

  it("assertRealBackendActivationAllowed blocks while inactive", () => {
    expect(() =>
      assertRealBackendActivationAllowed(basePolicy(), "explicit-runtime-key"),
    ).toThrow(BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE);
  });
});

describe("B.3.2 inactive adapters never touch secrets", () => {
  it("explicit-runtime-key does not read process.env and blocks before key use", async () => {
    const prior = process.env.BUYER_PRIVATE_KEY;
    process.env.BUYER_PRIVATE_KEY = "0x" + "ab".repeat(32);
    try {
      const provider = createInactiveExplicitRuntimeKeyProvider();
      const src = readFileSync(
        "tools/trustforge/buyer-credential-provider-adapters.ts",
        "utf8",
      );
      expect(src).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
      expect(src).not.toMatch(/privateKeyToAccount/);
      expect(src).not.toMatch(/dotenv/);
      await expect(
        acquireExplicitRuntimeKeySignerInactive({
          authorizedRequest: stampAuthorizedCredentialAccessRequest({
            accessAuthorization: {} as BuyerCredentialAccessAuthorization,
            accessAuthorizationSha256: "x",
            context: {
              expectedSignerAddress: BUYER,
              attemptId: "a",
              runId: "r",
              unsignedArtifactSha256: "u",
              signingAuthorizationSha256: "s",
            },
            validated: fakeValidated(
              buildBundle().unsignedArtifact,
              "u",
              buildBundle().signingAuthorization,
              "s",
            ),
          }),
          credentialInput: {
            kind: "explicit-runtime-key",
            privateKey: ("0x" + "cd".repeat(32)) as `0x${string}`,
          },
        }),
      ).rejects.toThrow(BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE);
      void provider;
    } finally {
      if (prior === undefined) delete process.env.BUYER_PRIVATE_KEY;
      else process.env.BUYER_PRIVATE_KEY = prior;
    }
  });

  it("encrypted keystore / external / secure adapters are inactive", async () => {
    const providers = [
      createInactiveEncryptedLocalKeystoreProvider(),
      createInactiveExternalSignerProvider(),
      createInactiveSecureSigningProvider(),
    ];
    for (const p of providers) {
      await expect(
        p.acquireSigner(
          stampAuthorizedCredentialAccessRequest({
            accessAuthorization: {} as BuyerCredentialAccessAuthorization,
            accessAuthorizationSha256: "x",
            context: {
              expectedSignerAddress: BUYER,
              attemptId: "a",
              runId: "r",
              unsignedArtifactSha256: "u",
              signingAuthorizationSha256: "s",
            },
            validated: fakeValidated(
              buildBundle().unsignedArtifact,
              "u",
              buildBundle().signingAuthorization,
              "s",
            ),
          }),
          p.providerId === "encrypted-local-keystore"
            ? {
                kind: "encrypted-local-keystore",
                keystorePath: "C:\\not-opened\\wallet.json",
                password: "not-used",
              }
            : undefined,
        ),
      ).rejects.toThrow(BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE);
    }
  });

  it("documents memory lifecycle without claiming JS secure erasure", () => {
    expect(B32_CREDENTIAL_MEMORY_LIFECYCLE_POLICY.credential_cache).toBe("disabled");
    expect(B32_CREDENTIAL_MEMORY_LIFECYCLE_POLICY.javascript_secure_erasure_guaranteed).toBe(
      false,
    );
  });
});

describe("B.3.2 gated path + synthetic", () => {
  it("production inactive still stops at B31 before provider acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createSyntheticBuyerCredentialProvider({ address: BUYER });
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: bundle.credentialAccessAuthorization,
        now: SIGNING_TIME,
        provider,
      }),
    ).rejects.toThrow(BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED);
    expect(provider.resolveCalls).toBe(0);
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("missing provider id in access auth blocks with zero acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writePolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createSyntheticBuyerCredentialProvider({ address: BUYER });
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: null,
        now: SIGNING_TIME,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(/BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_MISSING/);
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("wrong expected address blocks before acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writePolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createSyntheticBuyerCredentialProvider({ address: OTHER });
    const badAuth = {
      ...bundle.credentialAccessAuthorization,
      expected_signer_address: OTHER,
    };
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: badAuth,
        now: SIGNING_TIME,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(/BLOCKED_B31|BLOCKED_B32/);
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("stale OneSource artifact: zero credential and signer calls", async () => {
    if (!existsSync(REF_ATTEMPT_DIR)) return;
    const unsignedPath = join(REF_ATTEMPT_DIR, UNSIGNED_ARTIFACT);
    const unsignedArtifact = JSON.parse(readFileSync(unsignedPath, "utf8")) as UnsignedArtifact;
    const dir = workDir();
    const policyPath = writePolicy(dir);
    const provider = createSyntheticBuyerCredentialProvider({ address: BUYER });
    const attempt = {
      schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
      run_id: unsignedArtifact.run_id,
      attempt_id: unsignedArtifact.attempt_id,
      commit_sha: null,
      created_at: unsignedArtifact.created_at,
      state: "RESERVED" as const,
      reserved_at: unsignedArtifact.created_at,
      endpoint: unsignedArtifact.endpoint,
      method: unsignedArtifact.method,
      max_payment_attempts: 1,
      allow_retry: false,
    };
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact,
        attempt,
        humanAuthorization: human(),
        signingAuthorization: bundleSigningFor(unsignedArtifact),
        now: new Date(),
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow();
    expect(provider.resolveCalls).toBe(0);
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("valid synthetic still ends at send gate", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writePolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createSyntheticBuyerCredentialProvider({ address: BUYER });
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: bundle.credentialAccessAuthorization,
        now: SIGNING_TIME,
        nowAtSign: SIGNING_TIME,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED);
    expect(provider.acquireCalls).toBe(1);
    expect(provider.signerCalls).toBe(1);
  });

  it("provider identity mismatch uses B32 actual signer mismatch after acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writePolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    // Identity reports BUYER (from resolve) but acquire returns OTHER — simulate by wrapping.
    const inner = createSyntheticBuyerCredentialProvider({ address: OTHER });
    const provider = {
      ...inner,
      providerId: SYNTHETIC_CREDENTIAL_PROVIDER_ID,
      credentialKind: SYNTHETIC_CREDENTIAL_KIND,
      get resolveCalls() {
        return inner.resolveCalls;
      },
      get acquireCalls() {
        return inner.acquireCalls;
      },
      get signerCalls() {
        return inner.signerCalls;
      },
      async resolveSignerIdentity(ctx: Parameters<typeof inner.resolveSignerIdentity>[0]) {
        const id = await inner.resolveSignerIdentity(ctx);
        return { ...id, address: BUYER };
      },
      acquireSigner: inner.acquireSigner.bind(inner),
    };
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: bundle.credentialAccessAuthorization,
        now: SIGNING_TIME,
        nowAtSign: SIGNING_TIME,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH);
    expect(inner.signerCalls).toBe(0);
  });
});

describe("B.3.2 general-purpose signer surface", () => {
  it("BuyerAuthorizationSigner contract has no signMessage/signTransaction in adapters", () => {
    const src = readFileSync(
      "tools/trustforge/buyer-credential-provider-adapters.ts",
      "utf8",
    );
    expect(src).toMatch(/RestrictedBuyerAuthorizationSigner/);
    expect(src).not.toMatch(/signMessage\s*\(/);
    expect(src).not.toMatch(/signTransaction\s*\(/);
    // Type-level helper remains callable.
    expect(() =>
      assertRestrictedSignerSurface({
        address: BUYER,
        async signTypedData() {
          return (`0x${"ab".repeat(65)}`) as `0x${string}`;
        },
      }),
    ).not.toThrow();
  });
});

function bundleSigningFor(unsignedArtifact: UnsignedArtifact) {
  const unsignedHash = createHash("sha256")
    .update(JSON.stringify(unsignedArtifact))
    .digest("hex");
  // Intentionally weak — stale path must fail before auth matching.
  return buildSyntheticBuyerSigningAuthorization({
    decisionId: "stale",
    prepareAuthorizationSha256: "x".repeat(64),
    unsignedArtifact,
    unsignedArtifactSha256: unsignedHash,
    signingAuthorizationExpiresAt: "2099-01-01T00:00:00.000Z",
  });
}
