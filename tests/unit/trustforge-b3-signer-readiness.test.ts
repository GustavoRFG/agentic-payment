/**
 * B.3 signer integration readiness — synthetic only, no real keys/credentials.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import { UNSIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import {
  runAuthorizedBuyerSigning,
  createUnauthorizedBuyerCredentialProvider,
  type BuyerAuthorizationSigner,
  type HexAddress,
} from "../../tools/trustforge/buyer-authorization-signer";
import { BuyerSignatureAttemptLedger } from "../../tools/trustforge/buyer-signature-attempt-ledger";
import {
  buildSyntheticBuyerSigningAuthorization,
  type BuyerSigningAuthorization,
} from "../../tools/trustforge/buyer-signing-authorization";
import {
  BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED,
  BLOCKED_B3_REAL_SIGNER_CREDENTIAL_PROVIDER_NOT_AUTHORIZED,
  BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_EXPIRED,
  BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
  BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_MISSING,
  BLOCKED_B3_SIGNATURE_ATTEMPT_AMBIGUOUS,
  BLOCKED_B3_SIGNATURE_ATTEMPT_CONSUMED,
} from "../../tools/trustforge/b3-execution-gates";
import {
  loadB3SignerActivationPolicy,
  validateB3SignerActivationPolicy,
} from "../../tools/trustforge/b3-signer-activation-policy";
import {
  buildUnsignedBuyerAuthorization,
  canonicalJsonSha256,
} from "../../tools/trustforge/buyer-eip3009-authorization";
import type { PreSignAttemptArtifact } from "../../tools/trustforge/buyer-pre-sign-validation";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";

const BUYER = "0x1111111111111111111111111111111111111111" as HexAddress;
const PAY_TO = "0x2222222222222222222222222222222222222222";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NONCE = `0x${"11".repeat(32)}`;
const SIGNATURE = `0x${"ab".repeat(65)}` as const;
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
  const dir = mkdtempSync(join(tmpdir(), "b3-signer-"));
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

function syntheticSigner(address: HexAddress = BUYER): BuyerAuthorizationSigner & {
  calls: number;
} {
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
    decisionId: "decision-1",
    prepareAuthorizationSha256: canonicalJsonSha256(h),
    unsignedArtifact,
    unsignedArtifactSha256: unsignedHash,
    signingAuthorizationExpiresAt: h.authorization_expires_at!,
  });
  return { human: h, attempt, unsignedArtifact, unsignedHash, signingAuthorization };
}

function persistUnsigned(dir: string, artifact: UnsignedArtifact) {
  writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(artifact)}\n`, "utf8");
}

describe("B.3 signer activation policy", () => {
  it("loads the checked-in inactive readiness policy", () => {
    const policy = loadB3SignerActivationPolicy();
    expect(policy.signer_adapter_installed).toBe(true);
    expect(policy.real_signing_enabled).toBe(false);
    expect(policy.credential_provider_enabled).toBe(false);
    expect(policy.payment_bearing_send_enabled).toBe(false);
  });

  it("rejects enabling real signing in policy", () => {
    const result = validateB3SignerActivationPolicy({
      ...loadB3SignerActivationPolicy(),
      real_signing_enabled: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe("B.3 credential provider boundary", () => {
  it("unauthorized provider never yields a signer", async () => {
    const provider = createUnauthorizedBuyerCredentialProvider();
    await expect(provider.acquireBuyerSigner()).rejects.toThrow(
      new RegExp(BLOCKED_B3_REAL_SIGNER_CREDENTIAL_PROVIDER_NOT_AUTHORIZED),
    );
  });
});

describe("B.3 authorized signing gates", () => {
  it("missing signing authorization blocks before signer", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const signer = syntheticSigner();
    await expect(
      runAuthorizedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: null,
        now: SIGNING_TIME,
        signer,
        expectedUnsignedHash: bundle.unsignedHash,
        returnBeforeSendGateThrow: true,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_MISSING));
    expect(signer.calls).toBe(0);
  });

  it("expired signing authorization blocks before signer", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const signer = syntheticSigner();
    const expired: BuyerSigningAuthorization = {
      ...bundle.signingAuthorization,
      signing_authorization_expires_at: "2026-01-01T00:00:30.000Z",
    };
    await expect(
      runAuthorizedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: expired,
        now: SIGNING_TIME,
        signer,
        expectedUnsignedHash: bundle.unsignedHash,
        returnBeforeSendGateThrow: true,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_EXPIRED));
    expect(signer.calls).toBe(0);
  });

  it.each([
    ["attempt_id", (a: BuyerSigningAuthorization) => ({ ...a, attempt_id: "other" })],
    [
      "unsigned hash",
      (a: BuyerSigningAuthorization) => ({ ...a, unsigned_artifact_sha256: "ff".repeat(32) }),
    ],
    [
      "buyer",
      (a: BuyerSigningAuthorization) => ({
        ...a,
        buyer_wallet: "0x7777777777777777777777777777777777777777",
      }),
    ],
    ["amount", (a: BuyerSigningAuthorization) => ({ ...a, amount_atomic: "999" })],
    [
      "payTo",
      (a: BuyerSigningAuthorization) => ({
        ...a,
        pay_to: "0x6666666666666666666666666666666666666666",
      }),
    ],
    [
      "asset",
      (a: BuyerSigningAuthorization) => ({
        ...a,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02914",
      }),
    ],
    [
      "network",
      (a: BuyerSigningAuthorization) => ({ ...a, canonical_network_caip2: "eip155:84532" }),
    ],
  ] as const)("wrong %s blocks before signer", async (_label, mutate) => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const signer = syntheticSigner();
    await expect(
      runAuthorizedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: mutate(bundle.signingAuthorization),
        now: SIGNING_TIME,
        signer,
        expectedUnsignedHash: bundle.unsignedHash,
        returnBeforeSendGateThrow: true,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID));
    expect(signer.calls).toBe(0);
  });

  it("rejects the real stale OneSource attempt before signer", async () => {
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
    const dir = workDir();
    const signer = syntheticSigner(unsignedArtifact.buyer_wallet as HexAddress);
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);
    await expect(
      runAuthorizedBuyerSigning({
        directory: dir,
        unsignedArtifact,
        attempt,
        humanAuthorization,
        signingAuthorization: buildSyntheticBuyerSigningAuthorization({
          decisionId: "stale",
          prepareAuthorizationSha256: canonicalJsonSha256(humanAuthorization),
          unsignedArtifact,
          unsignedArtifactSha256: canonicalJsonSha256(unsignedArtifact),
          signingAuthorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
        now: new Date(),
        signer,
        returnBeforeSendGateThrow: true,
      }),
    ).rejects.toThrow(/BLOCKED_HUMAN_AUTHORIZATION_EXPIRED|BLOCKED_PAYMENT_REQUIREMENTS_STALE/);
    expect(signer.calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("valid synthetic fixture signs once and stops before send", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const signer = syntheticSigner();
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);
    await expect(
      runAuthorizedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        now: SIGNING_TIME,
        signer,
        expectedUnsignedHash: bundle.unsignedHash,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED));
    expect(signer.calls).toBe(1);
    expect(existsSync(join(dir, "buyer_authorization_signed.json"))).toBe(true);
    expect(existsSync(join(dir, "buyer_signature_attempt_ledger.json"))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    const signed = JSON.parse(
      readFileSync(join(dir, "buyer_authorization_signed.json"), "utf8"),
    );
    expect(signed.payment_header_created).toBe(false);
    expect(signed.sent).toBe(false);
    expect(signed.payment_bearing_request_count).toBe(0);
  });
});

describe("B.3 signature attempt one-shot lifecycle", () => {
  it("does not resign after signer invoked / ambiguous", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const ledger = new BuyerSignatureAttemptLedger();
    ledger.markSignerInvoked({
      signingAuthorizationDecisionId: bundle.signingAuthorization.decision_id,
      signingAuthorizationSha256: canonicalJsonSha256(bundle.signingAuthorization),
      unsignedArtifactSha256: bundle.unsignedHash,
      attemptId: bundle.attempt.attempt_id,
      runId: bundle.attempt.run_id,
      now: SIGNING_TIME,
      signatureAttemptId: "sig_crash",
    });
    ledger.persist(dir, bundle.signingAuthorization.decision_id, bundle.unsignedHash);
    const signer = syntheticSigner();
    await expect(
      runAuthorizedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        now: SIGNING_TIME,
        signer,
        expectedUnsignedHash: bundle.unsignedHash,
        ledger: BuyerSignatureAttemptLedger.loadFromDirectory(dir),
        returnBeforeSendGateThrow: true,
      }),
    ).rejects.toThrow(
      new RegExp(`${BLOCKED_B3_SIGNATURE_ATTEMPT_CONSUMED}|${BLOCKED_B3_SIGNATURE_ATTEMPT_AMBIGUOUS}`),
    );
    expect(signer.calls).toBe(0);
  });

  it("after signed persistence, restart does not resign or send", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    persistUnsigned(dir, bundle.unsignedArtifact);
    const signer = syntheticSigner();
    await expect(
      runAuthorizedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        now: SIGNING_TIME,
        signer,
        expectedUnsignedHash: bundle.unsignedHash,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED));
    expect(signer.calls).toBe(1);

    const signer2 = syntheticSigner();
    await expect(
      runAuthorizedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        now: SIGNING_TIME,
        signer: signer2,
        expectedUnsignedHash: bundle.unsignedHash,
        ledger: BuyerSignatureAttemptLedger.loadFromDirectory(dir),
        returnBeforeSendGateThrow: true,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_B3_SIGNATURE_ATTEMPT_CONSUMED));
    expect(signer2.calls).toBe(0);
  });
});

describe("B.3 productive reachability", () => {
  it("maps entrypoints: prepare reachable; credential/real-sign/send unreachable", () => {
    const prepare = readFileSync("tools/trustforge/b2-prepare-only-runner.ts", "utf8");
    expect(prepare).toMatch(/runBuyerAuthorizationPrepareOnly|BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED/);

    const signerMod = readFileSync("tools/trustforge/buyer-authorization-signer.ts", "utf8");
    expect(signerMod).toMatch(/createUnauthorizedBuyerCredentialProvider/);
    expect(signerMod).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(signerMod).not.toMatch(/privateKeyToAccount/);

    const thin = readFileSync("tools/trustforge/x402-thin-settlement-executor.ts", "utf8");
    expect(thin).not.toMatch(/runAuthorizedBuyerSigning/);
    expect(thin).not.toMatch(/buyer-authorization-signer/);
  });

  it("reference unsigned file hash is unchanged by tests", () => {
    if (!existsSync(REF_ATTEMPT_DIR)) return;
    const hash = createHash("sha256")
      .update(readFileSync(join(REF_ATTEMPT_DIR, "buyer_authorization_unsigned.json")))
      .digest("hex");
    expect(hash).toBe(
      "f43bb5a49bf5c92e07425c562c5f3158329cc29536733f27e167c68a4665b57f",
    );
  });
});
