/**
 * B.3.5 hidden TTY secret entry — synthetic only; no real keys; no payment.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED } from "../../tools/trustforge/b31-execution-gates";
import {
  BLOCKED_B35_INTERACTIVE_TTY_REQUIRED,
  BLOCKED_B35_SECRET_ENTRY_ABORTED,
  BLOCKED_B35_SECRET_ENTRY_INVALID,
  BLOCKED_B35_SECRET_ENTRY_OVERSIZED,
  BLOCKED_B35_SECRET_ENTRY_TIMEOUT,
} from "../../tools/trustforge/b35-execution-gates";
import { BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED } from "../../tools/trustforge/b3-execution-gates";
import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import { UNSIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import { buildSyntheticBuyerCredentialAccessAuthorization } from "../../tools/trustforge/buyer-credential-access-authorization";
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
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "../../tools/trustforge/explicit-runtime-key-credential-provider";
import { stampAuthorizedCredentialAccessRequest } from "../../tools/trustforge/buyer-credential-provider";
import { readHiddenParentTtySecret } from "../../tools/trustforge/buyer-hidden-tty-secret-entry";
import {
  SecretEntryLedger,
  stampAuthorizedSecretEntry,
} from "../../tools/trustforge/buyer-secret-entry-authorization";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import type { ValidatedBuyerAuthorizationForSigning } from "../../tools/trustforge/buyer-validated-signing";
import {
  SYNTHETIC_B33_RUNTIME_ADDRESS,
  SYNTHETIC_B33_RUNTIME_KEY,
  SYNTHETIC_B33_WRONG_RUNTIME_KEY,
} from "../support/trustforge-synthetic-runtime-key";
import { createSyntheticHiddenTty } from "../support/trustforge-synthetic-hidden-tty";

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
  const dir = mkdtempSync(join(tmpdir(), "b35-tty-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length) {
    const dir = temporaryDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function assertNoSecretLeak(text: string): void {
  expect(text.includes(SYNTHETIC_B33_RUNTIME_KEY)).toBe(false);
  expect(text.toLowerCase().includes(SYNTHETIC_B33_RUNTIME_KEY.slice(2).toLowerCase())).toBe(
    false,
  );
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

function writeAccessEnabledPolicy(dir: string) {
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
        transport_adapter_installed: true,
        secret_entry_adapter_installed: true,
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
        effect: "b35 synthetic",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path;
}

function authBundle() {
  const bundle = buildBundle();
  const stamped = stampAuthorizedCredentialAccessRequest({
    accessAuthorization: bundle.credentialAccessAuthorization,
    accessAuthorizationSha256: canonicalJsonSha256(bundle.credentialAccessAuthorization),
    context: {
      expectedSignerAddress: BUYER,
      attemptId: "attempt",
      runId: "run",
      unsignedArtifactSha256: bundle.unsignedHash,
      signingAuthorizationSha256: bundle.signingAuthorizationSha256,
    },
    validated: {
      __brand: "ValidatedBuyerAuthorizationForSigning",
      unsignedArtifact: bundle.unsignedArtifact,
      unsignedArtifactSha256: bundle.unsignedHash,
      signingAuthorization: bundle.signingAuthorization,
      signingAuthorizationSha256: bundle.signingAuthorizationSha256,
      typedData: {
        domain: bundle.unsignedArtifact.domain,
        types: bundle.unsignedArtifact.types,
        primaryType: bundle.unsignedArtifact.primary_type,
        message: bundle.unsignedArtifact.message,
      },
    } as unknown as ValidatedBuyerAuthorizationForSigning,
  });
  const authorization = stampAuthorizedSecretEntry({
    authorizedRequest: stamped,
    credentialAccessEnabled: true,
  });
  return { bundle, authorization };
}

describe("B.3.5 production policy", () => {
  it("secret-entry adapter installed with access disabled", () => {
    const policy = loadB31CredentialProviderPolicy();
    expect(policy.secret_entry_adapter_installed).toBe(true);
    expect(policy.transport_adapter_installed).toBe(true);
    expect(policy.credential_access_enabled).toBe(false);
  });
});

describe("B.3.5 production inactive gate", () => {
  it("blocks before prompt / raw mode / reads", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const tty = createSyntheticHiddenTty();
    tty.enqueueHexKeyThenEnter(SYNTHETIC_B33_RUNTIME_KEY);
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
        secretEntryTerminal: tty.terminal,
      }),
    ).rejects.toThrow(BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED);
    expect(tty.rawModeEnableCount.value).toBe(0);
    expect(tty.safeOutput.join("")).not.toContain("Credential entry required");
    expect(provider.acquireCalls).toBe(0);
  });
});

describe("B.3.5 TTY reader adversarial", () => {
  it("non-TTY fails closed with zero raw-mode activations", async () => {
    const { authorization } = authBundle();
    const tty = createSyntheticHiddenTty({ isTTY: false });
    const ledger = new SecretEntryLedger();
    ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
    await expect(
      readHiddenParentTtySecret({
        authorization,
        terminal: tty.terminal,
        ledger,
      }),
    ).rejects.toThrow(BLOCKED_B35_INTERACTIVE_TTY_REQUIRED);
    expect(tty.rawModeEnableCount.value).toBe(0);
  });

  it("Ctrl+C restores TTY and aborts", async () => {
    const { authorization } = authBundle();
    const tty = createSyntheticHiddenTty();
    tty.enqueueCtrlC();
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
    expect(tty.rawModeEnableCount.value).toBe(1);
    expect(tty.rawModeDisableCount.value).toBe(1);
    assertNoSecretLeak(tty.safeOutput.join(""));
  });

  it("Escape after partial secret aborts and restores", async () => {
    const { authorization } = authBundle();
    const tty = createSyntheticHiddenTty();
    tty.enqueueBytes([0x61, 0x62, 0x63]);
    tty.enqueueEscape();
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
  });

  it("timeout / EOF / invalid / oversized restore TTY", async () => {
    for (const setup of [
      (t: ReturnType<typeof createSyntheticHiddenTty>) => t.failNextReadWithTimeout(),
      (t: ReturnType<typeof createSyntheticHiddenTty>) => t.close(),
      (t: ReturnType<typeof createSyntheticHiddenTty>) => {
        t.enqueueBytes([0x20]); // space
        t.enqueueBytes([0x0d]);
      },
      (t: ReturnType<typeof createSyntheticHiddenTty>) => {
        t.enqueueHexKeyThenEnter("0x" + "ab".repeat(34)); // too long
      },
      (t: ReturnType<typeof createSyntheticHiddenTty>) => {
        t.enqueueBytes([0x61, 0x0d]); // too short
      },
    ]) {
      const { authorization } = authBundle();
      const tty = createSyntheticHiddenTty();
      setup(tty);
      const ledger = new SecretEntryLedger();
      ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
      await expect(
        readHiddenParentTtySecret({
          authorization,
          terminal: tty.terminal,
          ledger,
        }),
      ).rejects.toThrow(/BLOCKED_B35_/);
      expect(tty.terminal.getRawMode()).toBe(false);
      expect(tty.rawModeDisableCount.value).toBeGreaterThanOrEqual(1);
    }
  });

  it("valid synthetic key returns 32 bytes and restores TTY", async () => {
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
    expect(result.evidence.raw_mode_restored).toBe(true);
    expect(result.evidence.pasteboard_api_accessed).toBe(false);
    expect(tty.terminal.getRawMode()).toBe(false);
    assertNoSecretLeak(tty.safeOutput.join(""));
  });
});

describe("B.3.5 synthetic end-to-end", () => {
  it("TTY → pipe → runtime-key → send gate", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const tty = createSyntheticHiddenTty();
    tty.enqueueHexKeyThenEnter(SYNTHETIC_B33_RUNTIME_KEY);
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
        secretEntryTerminal: tty.terminal,
      }),
    ).rejects.toThrow(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED);
    expect(tty.rawModeEnableCount.value).toBe(1);
    expect(tty.rawModeDisableCount.value).toBe(1);
    expect(provider.acquireCalls).toBe(1);
    expect(provider.accountDerivations).toBe(1);
    expect(provider.signerCalls).toBe(1);
    const signed = readFileSync(join(dir, "buyer_authorization_signed.json"), "utf8");
    assertNoSecretLeak(signed);
    assertNoSecretLeak(tty.safeOutput.join(""));
  });

  it("wrong key address: signer 0 after entry consumed", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const tty = createSyntheticHiddenTty();
    tty.enqueueHexKeyThenEnter(SYNTHETIC_B33_WRONG_RUNTIME_KEY);
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
        secretEntryTerminal: tty.terminal,
      }),
    ).rejects.toThrow(/BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH/);
    expect(provider.signerCalls).toBe(0);
    expect(tty.terminal.getRawMode()).toBe(false);
  });

  it("T2 expiry after entry: signer 0", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const tty = createSyntheticHiddenTty();
    tty.enqueueHexKeyThenEnter(SYNTHETIC_B33_RUNTIME_KEY);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    const after = new Date(bundle.unsignedArtifact.effective_signing_deadline);
    after.setUTCSeconds(after.getUTCSeconds() + 5);
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: bundle.credentialAccessAuthorization,
        now: SIGNING_TIME,
        nowAtSign: after,
        provider,
        credentialPolicyPath: policyPath,
        secretEntryTerminal: tty.terminal,
      }),
    ).rejects.toThrow();
    expect(provider.acquireCalls).toBe(1);
    expect(provider.signerCalls).toBe(0);
  });

  it("stale OneSource: zero TTY activations", async () => {
    if (!existsSync(REF_ATTEMPT_DIR)) return;
    const unsignedArtifact = JSON.parse(
      readFileSync(join(REF_ATTEMPT_DIR, UNSIGNED_ARTIFACT), "utf8"),
    ) as UnsignedArtifact;
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    const tty = createSyntheticHiddenTty();
    tty.enqueueHexKeyThenEnter(SYNTHETIC_B33_RUNTIME_KEY);
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
          unsignedArtifactSha256: "bb".repeat(32),
          signingAuthorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
        now: new Date(),
        provider,
        credentialPolicyPath: policyPath,
        secretEntryTerminal: tty.terminal,
      }),
    ).rejects.toThrow();
    expect(tty.rawModeEnableCount.value).toBe(0);
    expect(provider.acquireCalls).toBe(0);
  });
});

describe("B.3.5 structural source guards smoke", () => {
  it("productive modules forbid clipboard / shell / env secret paths", () => {
    const src = readFileSync(
      "tools/trustforge/buyer-hidden-tty-secret-entry.ts",
      "utf8",
    );
    expect(src).toMatch(/HIDDEN_PARENT_TTY_ONE_SHOT/);
    expect(src).not.toMatch(/navigator\.clipboard|ClipboardItem|readText\(/);
    expect(src).not.toMatch(/shell:\s*true/);
    expect(src).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(src).not.toMatch(/process\.argv/);
    expect(src).not.toMatch(/let key = ""/);
  });
});

// silence unused import warnings for timeout/oversized constants used in regexes
void BLOCKED_B35_SECRET_ENTRY_INVALID;
void BLOCKED_B35_SECRET_ENTRY_OVERSIZED;
void BLOCKED_B35_SECRET_ENTRY_TIMEOUT;
