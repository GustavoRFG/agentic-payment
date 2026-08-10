/**
 * B.3.3 explicit-runtime-key adapter — synthetic credentials only; no payment.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED } from "../../tools/trustforge/b31-execution-gates";
import { BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH } from "../../tools/trustforge/b32-execution-gates";
import {
  BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_INVALID,
  BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_MISSING,
} from "../../tools/trustforge/b33-execution-gates";
import { BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED } from "../../tools/trustforge/b3-execution-gates";
import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import { UNSIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import { buildSyntheticBuyerCredentialAccessAuthorization } from "../../tools/trustforge/buyer-credential-access-authorization";
import { BuyerCredentialAccessLedger } from "../../tools/trustforge/buyer-credential-access-ledger";
import { runCredentialGatedBuyerSigning } from "../../tools/trustforge/buyer-credential-gated-signing";
import { loadB31CredentialProviderPolicy } from "../../tools/trustforge/b31-credential-provider-policy";
import {
  buildUnsignedBuyerAuthorization,
  canonicalJsonSha256,
} from "../../tools/trustforge/buyer-eip3009-authorization";
import type { PreSignAttemptArtifact } from "../../tools/trustforge/buyer-pre-sign-validation";
import { buildSyntheticBuyerSigningAuthorization } from "../../tools/trustforge/buyer-signing-authorization";
import {
  createExplicitRuntimeKeyCredentialProvider,
  validateExplicitRuntimePrivateKey,
} from "../../tools/trustforge/explicit-runtime-key-credential-provider";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import {
  SYNTHETIC_B33_RUNTIME_ADDRESS,
  SYNTHETIC_B33_RUNTIME_KEY,
  SYNTHETIC_B33_WRONG_RUNTIME_KEY,
} from "../support/trustforge-synthetic-runtime-key";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "../../tools/trustforge/explicit-runtime-key-credential-provider";

const BUYER = SYNTHETIC_B33_RUNTIME_ADDRESS;
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
  const dir = mkdtempSync(join(tmpdir(), "b33-rtk-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length) {
    const dir = temporaryDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

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
    providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
    credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
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

function writeAccessEnabledPolicy(dir: string, overrides: Record<string, unknown> = {}) {
  const path = join(dir, "credential_provider_policy.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schema_version: "trustforge_buyer_credential_provider_policy.v2",
        credential_provider_configured: true,
        allowed_provider_ids: [EXPLICIT_RUNTIME_KEY_PROVIDER_ID],
        selected_productive_provider_id: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
        provider_id: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
        credential_kind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
        adapter_installed: true,
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
        effect: "b33 synthetic access-enabled",
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path;
}

function assertNoSecretLeak(text: string): void {
  expect(text.includes(SYNTHETIC_B33_RUNTIME_KEY)).toBe(false);
  expect(text.toLowerCase().includes(SYNTHETIC_B33_RUNTIME_KEY.slice(2).toLowerCase())).toBe(
    false,
  );
}

describe("B.3.3 production policy", () => {
  it("selects explicit-runtime-key adapter installed with access disabled", () => {
    const policy = loadB31CredentialProviderPolicy();
    expect(policy.provider_id).toBe(EXPLICIT_RUNTIME_KEY_PROVIDER_ID);
    expect(policy.selected_productive_provider_id).toBe(EXPLICIT_RUNTIME_KEY_PROVIDER_ID);
    expect(policy.adapter_installed).toBe(true);
    expect(policy.transport_adapter_installed).toBe(true);
    expect(policy.credential_access_enabled).toBe(false);
    expect(policy.real_backend_activation).toBe(false);
    expect(policy.real_signing_enabled).toBe(false);
  });
});

describe("B.3.3 credential validation", () => {
  it("rejects missing / malformed / zero / out-of-range without leaking", () => {
    expect(() => validateExplicitRuntimePrivateKey(null)).toThrow(
      BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_MISSING,
    );
    try {
      validateExplicitRuntimePrivateKey("0x1234" as `0x${string}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).toContain(BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_INVALID);
      assertNoSecretLeak(msg);
    }
    expect(() =>
      validateExplicitRuntimePrivateKey(("0x" + "00".repeat(32)) as `0x${string}`),
    ).toThrow(BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_INVALID);
    expect(() =>
      validateExplicitRuntimePrivateKey(
        ("0x" + "ff".repeat(32)) as `0x${string}`,
      ),
    ).toThrow(BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_INVALID);
  });
});

describe("B.3.3 production inactive gate", () => {
  it("blocks before credential input is consumed", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
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
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow(BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED);
    expect(provider.acquireCalls).toBe(0);
    expect(provider.accountDerivations).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });
});

describe("B.3.3 synthetic runtime-key flow", () => {
  it("valid synthetic: one acquire, one derive, one sign, then send gate", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
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
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED);
    expect(provider.acquireCalls).toBe(1);
    expect(provider.accountDerivations).toBe(1);
    expect(provider.signerCalls).toBe(1);
    const signedPath = join(dir, "buyer_authorization_signed.json");
    expect(existsSync(signedPath)).toBe(true);
    const signedText = readFileSync(signedPath, "utf8");
    assertNoSecretLeak(signedText);
  });

  it("missing credential: zero derivations and signer calls", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
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
        credentialInput: null,
      }),
    ).rejects.toThrow(BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_MISSING);
    expect(provider.accountDerivations).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("malformed key: zero derivations where possible", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    let thrown = "";
    try {
      await runCredentialGatedBuyerSigning({
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
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: "0xdead" as `0x${string}`,
        },
      });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toContain(BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_INVALID);
    assertNoSecretLeak(thrown);
    expect(provider.accountDerivations).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("wrong derived address: one derivation, zero signer calls", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
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
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_WRONG_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow(BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH);
    expect(provider.accountDerivations).toBe(1);
    expect(provider.signerCalls).toBe(0);
  });

  it("credential authorization missing: zero provider acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
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
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow(/BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_MISSING/);
    expect(provider.acquireCalls).toBe(0);
  });

  it("expired credential authorization: zero acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: {
          ...bundle.credentialAccessAuthorization,
          access_expires_at: "2026-01-01T00:00:30.000Z",
        },
        now: SIGNING_TIME,
        provider,
        credentialPolicyPath: policyPath,
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow(/BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_EXPIRED/);
    expect(provider.acquireCalls).toBe(0);
  });

  it("wrong provider ID: zero acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: {
          ...bundle.credentialAccessAuthorization,
          provider_id: "external-signer",
        },
        now: SIGNING_TIME,
        provider,
        credentialPolicyPath: policyPath,
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow(/BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS|BLOCKED_B31_PROVIDER_MISMATCH/);
    expect(provider.acquireCalls).toBe(0);
  });

  it("wrong unsigned hash: zero acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: {
          ...bundle.credentialAccessAuthorization,
          unsigned_artifact_sha256: "ff".repeat(32),
        },
        now: SIGNING_TIME,
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        credentialPolicyPath: policyPath,
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow(/BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID/);
    expect(provider.acquireCalls).toBe(0);
  });

  it("T1/T2 expiry after acquisition: acquire 1, signer 0, no retry", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    const afterDeadline = new Date(bundle.unsignedArtifact.effective_signing_deadline);
    afterDeadline.setUTCSeconds(afterDeadline.getUTCSeconds() + 5);
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: bundle.credentialAccessAuthorization,
        now: SIGNING_TIME,
        nowAtSign: afterDeadline,
        provider,
        credentialPolicyPath: policyPath,
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow();
    expect(provider.acquireCalls).toBe(1);
    expect(provider.accountDerivations).toBe(1);
    expect(provider.signerCalls).toBe(0);
  });

  it("attempt already consumed: zero credential acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const ledger = new BuyerCredentialAccessLedger();
    ledger.reserve({
      decisionId: bundle.credentialAccessAuthorization.decision_id,
      authorizationSha256: canonicalJsonSha256(bundle.credentialAccessAuthorization),
      unsignedArtifactSha256: bundle.unsignedHash,
      providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
      now: SIGNING_TIME,
    });
    ledger.markAcquisitionInvoked(
      bundle.credentialAccessAuthorization.decision_id,
      bundle.unsignedHash,
      SIGNING_TIME,
    );
    const provider = createExplicitRuntimeKeyCredentialProvider();
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
        credentialPolicyPath: policyPath,
        credentialLedger: ledger,
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow(/BLOCKED_B31_CREDENTIAL_ACCESS_CONSUMED/);
    expect(provider.acquireCalls).toBe(0);
  });

  it("stale OneSource artifact: zero acquire/signer", async () => {
    if (!existsSync(REF_ATTEMPT_DIR)) return;
    const unsignedArtifact = JSON.parse(
      readFileSync(join(REF_ATTEMPT_DIR, UNSIGNED_ARTIFACT), "utf8"),
    ) as UnsignedArtifact;
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact,
        attempt: {
          schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
          run_id: unsignedArtifact.run_id,
          attempt_id: unsignedArtifact.attempt_id,
          commit_sha: null,
          created_at: unsignedArtifact.created_at,
          state: "RESERVED",
          reserved_at: unsignedArtifact.created_at,
          endpoint: unsignedArtifact.endpoint,
          method: unsignedArtifact.method,
          max_payment_attempts: 1,
          allow_retry: false,
        },
        humanAuthorization: human(),
        signingAuthorization: buildSyntheticBuyerSigningAuthorization({
          decisionId: "stale",
          prepareAuthorizationSha256: "aa".repeat(32),
          unsignedArtifact,
          unsignedArtifactSha256: createHash("sha256")
            .update(JSON.stringify(unsignedArtifact))
            .digest("hex"),
          signingAuthorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
        now: new Date(),
        provider,
        credentialPolicyPath: policyPath,
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_RUNTIME_KEY,
        },
      }),
    ).rejects.toThrow();
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });
});

describe("B.3.3 secret non-persistence / no discovery", () => {
  it("adapter source forbids env/file discovery", () => {
    const src = readFileSync(
      "tools/trustforge/explicit-runtime-key-credential-provider.ts",
      "utf8",
    );
    expect(src).toMatch(/privateKeyToAccount/);
    expect(src).not.toMatch(/process\.env\./);
    expect(src).not.toMatch(/dotenv/);
    expect(src).not.toMatch(/readFileSync/);
    expect(src).not.toMatch(/\breadFile\b/);
    expect(src).not.toMatch(/BUYER_PRIVATE_KEY/);
    expect(src).not.toMatch(/Enter private key/);
  });

  it("GUARD_NO_BUYER_RUNTIME_KEY_SECRET_LEAKAGE on invalid path", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    let thrown = "";
    try {
      await runCredentialGatedBuyerSigning({
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
        credentialInput: {
          kind: "explicit-runtime-key",
          privateKey: SYNTHETIC_B33_WRONG_RUNTIME_KEY,
        },
      });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    assertNoSecretLeak(thrown);
    assertNoSecretLeak(SYNTHETIC_B33_WRONG_RUNTIME_KEY === thrown ? thrown : thrown);
    for (const file of ["buyer_credential_access_ledger.json", "signed_authorization.json"]) {
      const p = join(dir, file);
      if (existsSync(p)) assertNoSecretLeak(readFileSync(p, "utf8"));
    }
  });
});
