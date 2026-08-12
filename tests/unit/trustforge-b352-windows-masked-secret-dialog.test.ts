/**
 * B.3.5.2 Windows masked secret dialog — synthetic only; no operational keys; no payment.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED } from "../../tools/trustforge/b3-execution-gates";
import {
  BLOCKED_B352_SECRET_DIALOG_CANCELLED,
  BLOCKED_B352_SECRET_DIALOG_CLOSED,
  BLOCKED_B352_SECRET_DIALOG_INVALID,
  BLOCKED_B352_SECRET_DIALOG_SECOND_ATTEMPT,
} from "../../tools/trustforge/b352-execution-gates";
import {
  B352_SECRET_ENTRY_MECHANISM,
  B35_SECRET_ENTRY_MECHANISM,
} from "../../tools/trustforge/buyer-secret-entry-mechanism";
import {
  createSyntheticWindowsMaskedSecretDialog,
  formatSafeKeyMetadata,
  isValidPrivateKeyAscii,
  privateKeyAsciiToCredentialBytes,
  readWindowsMaskedSecretDialog,
} from "../../tools/trustforge/buyer-windows-masked-secret-dialog";
import {
  SecretEntryLedger,
  stampAuthorizedSecretEntry,
} from "../../tools/trustforge/buyer-secret-entry-authorization";
import {
  buildSyntheticHumanConditionalCredentialSigningMandate,
  humanConditionalCredentialSigningMandateSha256,
} from "../../tools/trustforge/buyer-conditional-credential-signing-mandate";
import {
  buildPrepareAuthorizationViewFromConditionalMandate,
  deriveConditionalCredentialSigningArtifacts,
  runSyntheticConditionalMandateSignToSendGate,
} from "../../tools/trustforge/buyer-conditional-credential-signing-derivation";
import { BuyerConditionalMandateLedger } from "../../tools/trustforge/buyer-conditional-mandate-lifecycle";
import { canonicalJsonSha256 } from "../../tools/trustforge/x402-seller-requirements-binding";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import { createExplicitRuntimeKeyCredentialProvider } from "../../tools/trustforge/explicit-runtime-key-credential-provider";
import {
  SYNTHETIC_B33_RUNTIME_ADDRESS,
  SYNTHETIC_B33_RUNTIME_KEY,
} from "../support/trustforge-synthetic-runtime-key";
import { buildSyntheticBuyerCredentialAccessAuthorization } from "../../tools/trustforge/buyer-credential-access-authorization";
import { buildSyntheticBuyerSigningAuthorization } from "../../tools/trustforge/buyer-signing-authorization";
import {
  buildUnsignedBuyerAuthorization,
} from "../../tools/trustforge/buyer-eip3009-authorization";
import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import { stampAuthorizedCredentialAccessRequest } from "../../tools/trustforge/buyer-credential-provider";
import type { ValidatedBuyerAuthorizationForSigning } from "../../tools/trustforge/buyer-validated-signing";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "../../tools/trustforge/explicit-runtime-key-credential-provider";

const BUYER = SYNTHETIC_B33_RUNTIME_ADDRESS;
const PAY_TO = "0x2222222222222222222222222222222222222222";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ENDPOINT = "https://api.onesource.io/api/chain/block-number";
const NOW = new Date("2026-08-11T05:00:00.000Z");
const NONCE = `0x${"33".repeat(32)}`;

/** Deterministic synthetic 64-hex — not operational MetaMask. */
const SYNTHETIC_64 =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0fedcba9876543210";

const temporaryDirs: string[] = [];
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b352-"));
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
  expect(text.includes(SYNTHETIC_64)).toBe(false);
  expect(text.toLowerCase().includes(SYNTHETIC_64)).toBe(false);
  expect(text.toLowerCase().includes(SYNTHETIC_B33_RUNTIME_KEY.slice(2).toLowerCase())).toBe(
    false,
  );
}

function observation(): SellerRequirementsObservation {
  return {
    requirements_observed_at: "2026-08-11T04:59:00.000Z",
    selected_requirements: {},
    payment_required_envelope: {},
    ancillary_tempo_evidence: null,
    binding: {
      protocol_version: 2,
      transport: "payment-required-header",
      scheme: "exact",
      seller_network_raw: "eip155:8453",
      canonical_network_caip2: "eip155:8453",
      asset: ASSET,
      amount_field: "amount",
      amount_atomic: "1000",
      pay_to: PAY_TO,
      max_timeout_seconds: 3600,
      resource: null,
      extra: { name: "USD Coin", version: "2" },
      request_binding_sha256: "rb-b352",
      canonical_requirements_sha256: "req-sha-b352",
      canonical_envelope_sha256: "env-sha-b352",
    },
  };
}

function sealMandateWindows() {
  const provisional = buildSyntheticHumanConditionalCredentialSigningMandate({
    decisionId: "b352-mandate",
    endpoint: ENDPOINT,
    method: "GET",
    requestQuery: [["network", "ethereum"]],
    requestBindingSha256: "rb-b352",
    sellerNetworkRaw: "eip155:8453",
    canonicalNetworkCaip2: "eip155:8453",
    asset: ASSET,
    payTo: PAY_TO,
    buyerWallet: BUYER,
    canonicalRequirementsSha256: "req-sha-b352",
    canonicalEnvelopeSha256: "env-sha-b352",
    prepareAuthorizationSha256: "0".repeat(64),
    decidedAt: "2026-08-11T04:58:00.000Z",
    mandateExpiresAt: "2026-08-11T05:10:00.000Z",
    secretEntryMechanism: B352_SECRET_ENTRY_MECHANISM,
  });
  const prepareHash = canonicalJsonSha256(
    buildPrepareAuthorizationViewFromConditionalMandate(provisional),
  );
  return buildSyntheticHumanConditionalCredentialSigningMandate({
    decisionId: provisional.decision_id,
    endpoint: provisional.endpoint,
    method: provisional.method,
    requestQuery: provisional.request_query,
    requestBindingSha256: provisional.request_binding_sha256,
    sellerNetworkRaw: provisional.seller_network_raw,
    canonicalNetworkCaip2: provisional.canonical_network_caip2,
    asset: provisional.asset,
    payTo: provisional.pay_to,
    buyerWallet: provisional.buyer_wallet,
    canonicalRequirementsSha256: provisional.canonical_requirements_sha256,
    canonicalEnvelopeSha256: provisional.canonical_envelope_sha256,
    prepareAuthorizationSha256: prepareHash,
    decidedAt: provisional.decided_at,
    mandateExpiresAt: provisional.mandate_expires_at,
    secretEntryMechanism: B352_SECRET_ENTRY_MECHANISM,
    x402Version: provisional.x402_version,
    scheme: provisional.scheme,
  });
}

function writeAccessEnabledPolicy(dir: string): string {
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
        effect: "b352 synthetic",
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

describe("B.3.5.2 structural validation", () => {
  it("accepts 64 hex and 0x+64; rejects adversarial shapes", () => {
    expect(isValidPrivateKeyAscii(SYNTHETIC_64)).toBe(true);
    expect(isValidPrivateKeyAscii(`0x${SYNTHETIC_64}`)).toBe(true);
    expect(isValidPrivateKeyAscii(SYNTHETIC_64.slice(0, 63))).toBe(false);
    expect(isValidPrivateKeyAscii(`${SYNTHETIC_64}a`)).toBe(false);
    expect(isValidPrivateKeyAscii(` ${SYNTHETIC_64}`)).toBe(false);
    expect(isValidPrivateKeyAscii(`${SYNTHETIC_64}\n`)).toBe(false);
    expect(isValidPrivateKeyAscii("g".repeat(64))).toBe(false);
    expect(isValidPrivateKeyAscii(SYNTHETIC_64 + SYNTHETIC_64)).toBe(false);
    expect(formatSafeKeyMetadata(SYNTHETIC_64)).toEqual({ length: 64, format: "valid" });
    expect(privateKeyAsciiToCredentialBytes(SYNTHETIC_64).byteLength).toBe(32);
  });
});

describe("B.3.5.2 synthetic dialog adversarial", () => {
  function authForDialog() {
    const h = {
      authorization_schema_version: "v3",
      decision: "approve",
      provider: "fixture",
      service_id: "svc",
      endpoint: ENDPOINT,
      method: "GET",
      canonical_requirements_sha256: "req-sha-b352",
      canonical_envelope_sha256: "env-sha-b352",
      request_binding_sha256: "rb-b352",
      seller_network_raw: "eip155:8453",
      canonical_network_caip2: "eip155:8453",
      asset: ASSET,
      pay_to: PAY_TO,
      amount_atomic: "1000",
      maximum_authorized_amount_atomic: "1000",
      buyer_wallet: BUYER,
      max_usdc: "0.001",
      max_payment_attempts: 1,
      allow_retry: false,
      authorization_expires_at: "2026-08-11T05:10:00.000Z",
    } as const;
    const built = buildUnsignedBuyerAuthorization({
      humanAuthorization: h as never,
      paytimeObservation: observation(),
      authorizedRequirementsSha256: "req-sha-b352",
      authorizedEnvelopeSha256: "env-sha-b352",
      authorizedRequestBindingSha256: "rb-b352",
      authorizedEndpoint: ENDPOINT,
      authorizedMethod: "GET",
      buyerAddress: BUYER,
      signingTime: NOW,
      nonce: NONCE,
    });
    const unsignedArtifact = {
      schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
      run_id: "run",
      attempt_id: "attempt",
      commit_sha: null,
      created_at: NOW.toISOString(),
      state: "UNSIGNED_PERSISTED",
      signing_time: built.signing_time,
      human_authorization_sha256: canonicalJsonSha256(h),
      canonical_requirements_sha256: "req-sha-b352",
      canonical_envelope_sha256: "env-sha-b352",
      request_binding_sha256: "rb-b352",
      endpoint: ENDPOINT,
      method: "GET",
      protocol_version: 2,
      seller_network_raw: "eip155:8453",
      canonical_network_caip2: "eip155:8453",
      chain_id: 8453,
      asset: ASSET,
      pay_to: PAY_TO,
      seller_amount_atomic: built.seller_amount_atomic,
      maximum_authorized_amount_atomic: built.maximum_authorized_amount_atomic,
      buyer_wallet: BUYER,
      paytime_requirements_observed_at: "2026-08-11T04:59:00.000Z",
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
    } as UnsignedArtifact;
    const unsignedHash = canonicalJsonSha256(unsignedArtifact);
    const signingAuthorization = buildSyntheticBuyerSigningAuthorization({
      decisionId: "sign-b352",
      prepareAuthorizationSha256: canonicalJsonSha256(h),
      unsignedArtifact,
      unsignedArtifactSha256: unsignedHash,
      signingAuthorizationExpiresAt: h.authorization_expires_at,
    });
    const signingAuthorizationSha256 = canonicalJsonSha256(signingAuthorization);
    const credentialAccessAuthorization = {
      ...buildSyntheticBuyerCredentialAccessAuthorization({
        decisionId: "cred-b352",
        signingAuthorization,
        signingAuthorizationSha256,
        unsignedArtifact,
        unsignedArtifactSha256: unsignedHash,
        providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
        credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
        expectedSignerAddress: BUYER,
        accessExpiresAt: h.authorization_expires_at,
      }),
      required_secret_entry_mechanism: B352_SECRET_ENTRY_MECHANISM,
    };
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
    return { authorization };
  }

  it("Continue with 64 hex succeeds; clipboard flag false", async () => {
    const { authorization } = authForDialog();
    const dialog = createSyntheticWindowsMaskedSecretDialog({
      credentialAscii: SYNTHETIC_64,
      action: "continue",
    });
    const ledger = new SecretEntryLedger();
    ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
    const result = await readWindowsMaskedSecretDialog({
      authorization,
      dialog,
      ledger,
      expectedWallet: BUYER,
    });
    expect(result.credentialBytes.byteLength).toBe(32);
    expect(result.evidence.programmatic_clipboard_read).toBe(false);
    expect(result.evidence.accepted_ascii_length).toBe(64);
    expect(dialog.openCount.value).toBe(1);
  });

  it("Cancel / close → fail-closed; second open blocked", async () => {
    for (const action of ["cancel", "close"] as const) {
      const { authorization } = authForDialog();
      const dialog = createSyntheticWindowsMaskedSecretDialog({ action });
      const ledger = new SecretEntryLedger();
      ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
      await expect(
        readWindowsMaskedSecretDialog({
          authorization,
          dialog,
          ledger,
          expectedWallet: BUYER,
        }),
      ).rejects.toThrow(
        action === "cancel"
          ? BLOCKED_B352_SECRET_DIALOG_CANCELLED
          : BLOCKED_B352_SECRET_DIALOG_CLOSED,
      );
    }

    const { authorization } = authForDialog();
    const dialog = createSyntheticWindowsMaskedSecretDialog({
      credentialAscii: SYNTHETIC_64,
    });
    const ledger = new SecretEntryLedger();
    ledger.reserve(authorization.decisionId, authorization.unsignedArtifactSha256);
    await readWindowsMaskedSecretDialog({
      authorization,
      dialog,
      ledger,
      expectedWallet: BUYER,
    });
    await expect(dialog.showOnce({ expectedWallet: BUYER })).rejects.toThrow(
      BLOCKED_B352_SECRET_DIALOG_SECOND_ATTEMPT,
    );
  });

  it("invalid lengths rejected without leaking sentinel", async () => {
    for (const bad of [
      SYNTHETIC_64.slice(0, 63),
      `${SYNTHETIC_64}a`,
      ` ${SYNTHETIC_64}`,
      `${SYNTHETIC_64}\n`,
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      SYNTHETIC_64 + SYNTHETIC_64,
    ]) {
      const dialog = createSyntheticWindowsMaskedSecretDialog({
        credentialAscii: bad,
        action: "continue",
      });
      await expect(dialog.showOnce({ expectedWallet: BUYER })).rejects.toThrow(
        BLOCKED_B352_SECRET_DIALOG_INVALID,
      );
      const meta = formatSafeKeyMetadata(bad);
      expect(JSON.stringify(meta)).not.toContain(SYNTHETIC_64);
    }
  });
});

describe("B.3.5.2 B363 + B34 + B33 synthetic E2E", () => {
  it("Windows dialog → pipe → runtime-key → send gate", async () => {
    const dir = workDir();
    const mandate = sealMandateWindows();
    expect(mandate.secret_entry_mechanism).toBe(B352_SECRET_ENTRY_MECHANISM);
    expect(mandate.secret_entry_mechanism).not.toBe(B35_SECRET_ENTRY_MECHANISM);

    const derivation = deriveConditionalCredentialSigningArtifacts({
      directory: dir,
      runId: "run_b352",
      attemptId: "attempt_b352",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger: new BuyerConditionalMandateLedger(),
    });
    expect(derivation.derived_credential_access_authorization.required_secret_entry_mechanism).toBe(
      B352_SECRET_ENTRY_MECHANISM,
    );
    expect(humanConditionalCredentialSigningMandateSha256(mandate)).toHaveLength(64);

    const policyPath = writeAccessEnabledPolicy(dir);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    // Use Anvil #0 key so B33 address matches BUYER when BUYER is Anvil #0.
    // sealMandate uses SYNTHETIC_B33_RUNTIME_ADDRESS — credential must match.
    const dialog = createSyntheticWindowsMaskedSecretDialog({
      credentialAscii: SYNTHETIC_B33_RUNTIME_KEY,
      action: "continue",
    });

    const result = await runSyntheticConditionalMandateSignToSendGate({
      directory: dir,
      derivation,
      mandate,
      now: NOW,
      provider,
      windowsMaskedSecretDialog: dialog,
      credentialPolicyPath: policyPath,
    });
    expect(result.terminal).toBe(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED);
    expect(result.signer_calls).toBe(1);
    expect(provider.signerCalls).toBe(1);
    expect(dialog.openCount.value).toBe(1);
    const signed = readFileSync(join(dir, "buyer_authorization_signed.json"), "utf8");
    assertNoSecretLeak(signed);
    assertNoSecretLeak(JSON.stringify(derivation.derived_credential_access_authorization));
  });
});
