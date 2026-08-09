/**
 * B.3.1 credential-provider readiness — no real keys, no wallet env, no payment.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import { UNSIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import type { HexAddress } from "../../tools/trustforge/buyer-authorization-signer";
import {
  buildSyntheticBuyerCredentialAccessAuthorization,
} from "../../tools/trustforge/buyer-credential-access-authorization";
import { BuyerCredentialAccessLedger } from "../../tools/trustforge/buyer-credential-access-ledger";
import { runCredentialGatedBuyerSigning } from "../../tools/trustforge/buyer-credential-gated-signing";
import {
  BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_EXPIRED,
  BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
  BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_MISSING,
  BLOCKED_B31_CREDENTIAL_ACCESS_CONSUMED,
  BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED,
  BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH,
  BLOCKED_B31_PROVIDER_MISMATCH,
} from "../../tools/trustforge/b31-execution-gates";
import { BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS } from "../../tools/trustforge/b32-execution-gates";
import {
  loadB31CredentialProviderPolicy,
  validateB31CredentialProviderPolicy,
} from "../../tools/trustforge/b31-credential-provider-policy";
import {
  buildUnsignedBuyerAuthorization,
  canonicalJsonSha256,
} from "../../tools/trustforge/buyer-eip3009-authorization";
import type { PreSignAttemptArtifact } from "../../tools/trustforge/buyer-pre-sign-validation";
import {
  buildSyntheticBuyerSigningAuthorization,
} from "../../tools/trustforge/buyer-signing-authorization";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import { BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED } from "../../tools/trustforge/b3-execution-gates";
import {
  createSyntheticBuyerCredentialProvider,
  SYNTHETIC_CREDENTIAL_KIND,
  SYNTHETIC_CREDENTIAL_PROVIDER_ID,
} from "../support/trustforge-synthetic-credential-provider";

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
  const dir = mkdtempSync(join(tmpdir(), "b31-cred-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length) {
    const dir = temporaryDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
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

function writeAccessEnabledPolicy(dir: string, overrides: Record<string, unknown> = {}) {
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
        effect: "synthetic test-only access-enabled policy",
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path;
}

function persistUnsigned(dir: string, artifact: UnsignedArtifact) {
  writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(artifact)}\n`, "utf8");
}

describe("B.3.1 credential provider policy", () => {
  it("loads inactive production policy", () => {
    const policy = loadB31CredentialProviderPolicy();
    expect(policy.credential_provider_configured).toBe(true);
    expect(policy.credential_access_enabled).toBe(false);
    expect(policy.automatic_discovery_enabled).toBe(false);
    expect(policy.fallback_provider_enabled).toBe(false);
    expect(policy.real_backend_activation).toBe(false);
    expect(policy.selected_productive_provider_id).toBe("NONE");
  });

  it("rejects automatic discovery", () => {
    const result = validateB31CredentialProviderPolicy({
      ...loadB31CredentialProviderPolicy(),
      automatic_discovery_enabled: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe("B.3.1 production inactive credential access", () => {
  it("blocks otherwise-valid synthetic artifacts before any provider call", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
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
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        // production policy path (default): access disabled
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED));
    expect(provider.resolveCalls).toBe(0);
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });
});

describe("B.3.1 synthetic credential provider gates", () => {
  it("missing credential-access authorization blocks before provider", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const policyPath = writeAccessEnabledPolicy(dir);
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
        nowAtSign: SIGNING_TIME,
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_MISSING));
    expect(provider.resolveCalls).toBe(0);
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("expired credential-access authorization blocks before provider", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const policyPath = writeAccessEnabledPolicy(dir);
    const provider = createSyntheticBuyerCredentialProvider({ address: BUYER });
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
        nowAtSign: SIGNING_TIME,
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_EXPIRED));
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("wrong provider ID blocks before acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const policyPath = writeAccessEnabledPolicy(dir);
    const provider = createSyntheticBuyerCredentialProvider({ address: BUYER });
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: {
          ...bundle.credentialAccessAuthorization,
          provider_id: "other-provider",
        },
        now: SIGNING_TIME,
        nowAtSign: SIGNING_TIME,
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(
      new RegExp(
        `${BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS}|${BLOCKED_B31_PROVIDER_MISMATCH}|${BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID}`,
      ),
    );
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("wrong expected signer blocks before acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const policyPath = writeAccessEnabledPolicy(dir);
    const provider = createSyntheticBuyerCredentialProvider({ address: BUYER });
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: {
          ...bundle.credentialAccessAuthorization,
          expected_signer_address: OTHER,
        },
        now: SIGNING_TIME,
        nowAtSign: SIGNING_TIME,
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID));
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("wrong unsigned hash blocks before acquire", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const policyPath = writeAccessEnabledPolicy(dir);
    const provider = createSyntheticBuyerCredentialProvider({ address: BUYER });
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
        nowAtSign: SIGNING_TIME,
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID));
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("provider identity mismatch blocks before acquire completes signing", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const policyPath = writeAccessEnabledPolicy(dir);
    const provider = createSyntheticBuyerCredentialProvider({ address: OTHER });
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
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH));
    expect(provider.resolveCalls).toBe(1);
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });

  it("stale real OneSource attempt fails before credential/signer calls", async () => {
    if (!existsSync(REF_ATTEMPT_DIR)) {
      throw new Error(`reference attempt missing: ${REF_ATTEMPT_DIR}`);
    }
    const unsignedArtifact = JSON.parse(
      readFileSync(join(REF_ATTEMPT_DIR, "buyer_authorization_unsigned.json"), "utf8"),
    ) as UnsignedArtifact;
    const attempt = JSON.parse(
      readFileSync(join(REF_ATTEMPT_DIR, "buyer_authorization_attempt.json"), "utf8"),
    ) as PreSignAttemptArtifact;
    const humanAuthorization = JSON.parse(
      readFileSync(join(REF_RUN, "human_payment_authorization.json"), "utf8"),
    ) as HumanPaymentAuthorization;
    const provider = createSyntheticBuyerCredentialProvider({
      address: unsignedArtifact.buyer_wallet as HexAddress,
    });
    const dir = workDir();
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact,
        attempt,
        humanAuthorization,
        signingAuthorization: buildSyntheticBuyerSigningAuthorization({
          decisionId: "stale-sign",
          prepareAuthorizationSha256: canonicalJsonSha256(humanAuthorization),
          unsignedArtifact,
          unsignedArtifactSha256: canonicalJsonSha256(unsignedArtifact),
          signingAuthorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
        now: new Date(),
        provider,
      }),
    ).rejects.toThrow(/BLOCKED_HUMAN_AUTHORIZATION_EXPIRED|BLOCKED_PAYMENT_REQUIREMENTS_STALE|BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED/);
    expect(provider.resolveCalls).toBe(0);
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
    const hash = createHash("sha256")
      .update(readFileSync(join(REF_ATTEMPT_DIR, "buyer_authorization_unsigned.json")))
      .digest("hex");
    expect(hash).toBe(
      "f43bb5a49bf5c92e07425c562c5f3158329cc29536733f27e167c68a4665b57f",
    );
  });

  it("valid synthetic case acquires once, signs once, stops before send", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const policyPath = writeAccessEnabledPolicy(dir);
    const provider = createSyntheticBuyerCredentialProvider({ address: BUYER });
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);
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
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        credentialPolicyPath: policyPath,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED));
    expect(provider.acquireCalls).toBe(1);
    expect(provider.signerCalls).toBe(1);
    expect(existsSync(join(dir, "buyer_authorization_signed.json"))).toBe(true);
    expect(existsSync(join(dir, "buyer_credential_access_ledger.json"))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("credential access one-shot: cannot re-acquire after invocation", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const policyPath = writeAccessEnabledPolicy(dir);
    const ledger = new BuyerCredentialAccessLedger();
    ledger.reserve({
      decisionId: bundle.credentialAccessAuthorization.decision_id,
      authorizationSha256: canonicalJsonSha256(bundle.credentialAccessAuthorization),
      unsignedArtifactSha256: bundle.unsignedHash,
      providerId: SYNTHETIC_CREDENTIAL_PROVIDER_ID,
      now: SIGNING_TIME,
    });
    ledger.markAcquisitionInvoked(
      bundle.credentialAccessAuthorization.decision_id,
      bundle.unsignedHash,
      SIGNING_TIME,
    );
    ledger.persist(dir, bundle.credentialAccessAuthorization.decision_id, bundle.unsignedHash);
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
        expectedUnsignedHash: bundle.unsignedHash,
        provider,
        credentialPolicyPath: policyPath,
        credentialLedger: BuyerCredentialAccessLedger.loadFromDirectory(dir),
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B31_CREDENTIAL_ACCESS_CONSUMED));
    expect(provider.acquireCalls).toBe(0);
    expect(provider.signerCalls).toBe(0);
  });
});

describe("B.3.1 productive reachability", () => {
  it("keeps real credential acquisition unreachable from thin settlement", () => {
    const thin = readFileSync("tools/trustforge/x402-thin-settlement-executor.ts", "utf8");
    expect(thin).not.toMatch(/runCredentialGatedBuyerSigning/);
    expect(thin).not.toMatch(/buyer-credential-gated-signing/);
    const gated = readFileSync("tools/trustforge/buyer-credential-gated-signing.ts", "utf8");
    expect(gated).toMatch(/assertB31CredentialAccessNotAuthorized|BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED/);
    expect(gated).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(gated).not.toMatch(/privateKeyToAccount/);
    expect(gated).not.toMatch(/dotenv/);
  });
});
