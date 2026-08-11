/**
 * B.3.6.3 conditional credential+signing mandate — synthetic/offline only.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED } from "../../tools/trustforge/b3-execution-gates";
import {
  BLOCKED_B363_CONDITIONAL_MANDATE_ALREADY_CONSUMED,
  BLOCKED_B363_CONDITIONAL_MANDATE_EXPIRED,
  BLOCKED_B363_DERIVED_AUTHORITY_NOT_SUBSET,
  BLOCKED_B363_FRESH_REQUIREMENTS_OUTSIDE_CONDITIONAL_MANDATE,
  GUARD_DERIVED_CREDENTIAL_AUTHORITY_SUBSET,
  GUARD_HUMAN_CONDITIONAL_MANDATE_NOT_DIRECTLY_CREDENTIAL_CAPABLE,
  GUARD_HUMAN_CONDITIONAL_MANDATE_NOT_DIRECTLY_SIGNABLE,
  GUARD_SIGNING_DOES_NOT_AUTHORIZE_SEND,
} from "../../tools/trustforge/b363-execution-gates";
import { UNSIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import {
  assertSigningDoesNotAuthorizeSend,
  buildPrepareAuthorizationViewFromConditionalMandate,
  deriveConditionalCredentialSigningArtifacts,
  DERIVED_CREDENTIAL_ACCESS_AUTHORIZATION_ARTIFACT,
  DERIVED_SIGNING_AUTHORIZATION_ARTIFACT,
  runSyntheticConditionalMandateSignToSendGate,
} from "../../tools/trustforge/buyer-conditional-credential-signing-derivation";
import {
  assertNotHumanConditionalMandateForCredential,
  assertNotHumanConditionalMandateForSigner,
  buildSyntheticHumanConditionalCredentialSigningMandate,
  humanConditionalCredentialSigningMandateSha256,
  validateHumanConditionalCredentialSigningMandate,
  type HumanConditionalCredentialSigningMandate,
} from "../../tools/trustforge/buyer-conditional-credential-signing-mandate";
import {
  verifyDerivedCredentialAccessAuthorizationIsSubsetOfConditionalMandate,
  verifyDerivedSigningAuthorizationIsSubsetOfConditionalMandate,
} from "../../tools/trustforge/buyer-conditional-mandate-authority-subset";
import {
  BuyerConditionalMandateLedger,
  evaluateConditionalMandateCrashRecovery,
} from "../../tools/trustforge/buyer-conditional-mandate-lifecycle";
import { assertFreshRequirementsExactMatchConditionalMandate } from "../../tools/trustforge/buyer-mandate-fresh-requirements-gate";
import { createExplicitRuntimeKeyCredentialProvider } from "../../tools/trustforge/explicit-runtime-key-credential-provider";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "../../tools/trustforge/explicit-runtime-key-credential-provider";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";
import {
  canonicalJsonSha256,
  SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS,
  type SellerRequirementsObservation,
} from "../../tools/trustforge/x402-seller-requirements-binding";
import {
  SYNTHETIC_B33_RUNTIME_ADDRESS,
  SYNTHETIC_B33_RUNTIME_KEY,
} from "../support/trustforge-synthetic-runtime-key";
import { createSyntheticHiddenTty } from "../support/trustforge-synthetic-hidden-tty";

const BUYER = SYNTHETIC_B33_RUNTIME_ADDRESS;
const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ENDPOINT = "https://api.onesource.io/api/chain/block-number";
const METHOD = "GET";
const QUERY = [["network", "ethereum"]] as const;
const OBSERVED_AT = "2026-08-11T05:00:00.000Z";
const NOW = new Date("2026-08-11T05:00:05.000Z");
const MANDATE_EXPIRES = "2026-08-11T05:30:00.000Z";
const NONCE = `0x${"ab".repeat(32)}`;

const temporaryDirs: string[] = [];
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b363-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length) {
    const dir = temporaryDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function observation(
  overrides: Partial<SellerRequirementsObservation["binding"]> = {},
): SellerRequirementsObservation {
  const rb = createThinSettlementRequestBinding({
    endpoint: ENDPOINT,
    method: METHOD,
    input_status: "known",
    query: QUERY.map(([k, v]) => [k, v] as [string, string]),
    body: null,
  }).binding_sha256;
  return {
    requirements_observed_at: OBSERVED_AT,
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
      request_binding_sha256: rb,
      canonical_requirements_sha256: "req-sha-b363-exact",
      canonical_envelope_sha256: "env-sha-b363-exact",
      ...overrides,
    },
  };
}

function sealMandate(
  overrides: Partial<{
    decisionId: string;
    amountAtomic: string;
    mandateExpiresAt: string;
    payTo: string;
    buyerWallet: string;
  }> = {},
): HumanConditionalCredentialSigningMandate {
  const rb = createThinSettlementRequestBinding({
    endpoint: ENDPOINT,
    method: METHOD,
    input_status: "known",
    query: QUERY.map(([k, v]) => [k, v] as [string, string]),
    body: null,
  }).binding_sha256;
  const provisional = buildSyntheticHumanConditionalCredentialSigningMandate({
    decisionId: overrides.decisionId ?? "cond-mandate-1",
    endpoint: ENDPOINT,
    method: METHOD,
    requestQuery: QUERY,
    requestBindingSha256: rb,
    sellerNetworkRaw: "eip155:8453",
    canonicalNetworkCaip2: "eip155:8453",
    asset: ASSET,
    payTo: overrides.payTo ?? PAY_TO,
    buyerWallet: overrides.buyerWallet ?? BUYER,
    amountAtomic: overrides.amountAtomic ?? "1000",
    canonicalRequirementsSha256: "req-sha-b363-exact",
    canonicalEnvelopeSha256: "env-sha-b363-exact",
    prepareAuthorizationSha256: "0".repeat(64),
    decidedAt: "2026-08-11T04:55:00.000Z",
    mandateExpiresAt: overrides.mandateExpiresAt ?? MANDATE_EXPIRES,
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
    amountAtomic: provisional.amount_atomic,
    maximumAuthorizedAmountAtomic: provisional.maximum_authorized_amount_atomic,
    canonicalRequirementsSha256: provisional.canonical_requirements_sha256,
    canonicalEnvelopeSha256: provisional.canonical_envelope_sha256,
    prepareAuthorizationSha256: prepareHash,
    decidedAt: provisional.decided_at,
    mandateExpiresAt: provisional.mandate_expires_at,
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
        effect: "b363 synthetic",
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

describe("B.3.6.3 conditional mandate contract", () => {
  it("validates synthetic mandate and blocks direct credential/signer use", () => {
    const mandate = sealMandate();
    expect(validateHumanConditionalCredentialSigningMandate({ mandate, now: NOW })).toBe(mandate);
    expect(() => assertNotHumanConditionalMandateForCredential(mandate)).toThrow(
      GUARD_HUMAN_CONDITIONAL_MANDATE_NOT_DIRECTLY_CREDENTIAL_CAPABLE,
    );
    expect(() => assertNotHumanConditionalMandateForSigner(mandate)).toThrow(
      GUARD_HUMAN_CONDITIONAL_MANDATE_NOT_DIRECTLY_SIGNABLE,
    );
    expect(mandate.credential_provider_id).toBe(EXPLICIT_RUNTIME_KEY_PROVIDER_ID);
    expect(mandate.secret_entry_mechanism).toBe("HIDDEN_PARENT_TTY_ONE_SHOT");
    expect(mandate.payment_bearing_send_authorized).toBe(false);
  });

  it("expiry boundary: == and > block; < valid", () => {
    const mandate = sealMandate({ mandateExpiresAt: "2026-08-11T05:00:05.000Z" });
    expect(() =>
      validateHumanConditionalCredentialSigningMandate({
        mandate,
        now: new Date("2026-08-11T05:00:05.000Z"),
      }),
    ).toThrow(BLOCKED_B363_CONDITIONAL_MANDATE_EXPIRED);
    expect(() =>
      validateHumanConditionalCredentialSigningMandate({
        mandate,
        now: new Date("2026-08-11T05:00:06.000Z"),
      }),
    ).toThrow(BLOCKED_B363_CONDITIONAL_MANDATE_EXPIRED);
    expect(
      validateHumanConditionalCredentialSigningMandate({
        mandate,
        now: new Date("2026-08-11T05:00:04.999Z"),
      }),
    ).toBe(mandate);
  });
});

describe("B.3.6.3 seller-change gate", () => {
  const cases: Array<[string, Partial<SellerRequirementsObservation["binding"]>]> = [
    ["amount", { amount_atomic: "1001" }],
    ["payTo", { pay_to: "0x0000000000000000000000000000000000000001" }],
    ["asset", { asset: "0x0000000000000000000000000000000000000002" }],
    ["network", { canonical_network_caip2: "eip155:84532", seller_network_raw: "eip155:84532" }],
    ["requirements", { canonical_requirements_sha256: "other" }],
    ["envelope", { canonical_envelope_sha256: "other" }],
    ["scheme", { scheme: "upto" }],
    ["request_binding", { request_binding_sha256: "other-rb" }],
  ];
  for (const [label, overrides] of cases) {
    it(`blocks ${label} before attempt`, () => {
      const mandate = sealMandate();
      expect(() =>
        assertFreshRequirementsExactMatchConditionalMandate({
          mandate,
          freshObservation: observation(overrides),
          freshEndpoint: ENDPOINT,
          freshMethod: METHOD,
          freshRequestQuery: QUERY,
          freshRequestBody: null,
        }),
      ).toThrow(BLOCKED_B363_FRESH_REQUIREMENTS_OUTSIDE_CONDITIONAL_MANDATE);
    });
  }
});

describe("B.3.6.3 positive derivation", () => {
  it("derives signing + credential auth with authority subset PASS", () => {
    const dir = workDir();
    const mandate = sealMandate();
    const result = deriveConditionalCredentialSigningArtifacts({
      directory: dir,
      runId: "run_b363",
      attemptId: "attempt_b363",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger: new BuyerConditionalMandateLedger(),
    });
    expect(result.pre_sign_current_validity).toBe("PASS");
    expect(result.authority_subset).toBe("PASS");
    expect(result.local_freshness_cap_seconds).toBe(300);
    expect(SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS).toBe(300);
    expect(existsSync(join(dir, UNSIGNED_ARTIFACT))).toBe(true);
    expect(existsSync(join(dir, DERIVED_SIGNING_AUTHORIZATION_ARTIFACT))).toBe(true);
    expect(existsSync(join(dir, DERIVED_CREDENTIAL_ACCESS_AUTHORIZATION_ARTIFACT))).toBe(true);
    expect(result.derived_signing_authorization.derivation_type).toBe(
      "DETERMINISTIC_FROM_HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE",
    );
    expect(result.derived_credential_access_authorization.derivation_type).toBe(
      "DETERMINISTIC_FROM_HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE",
    );
    expect(result.derived_credential_access_authorization.required_secret_entry_mechanism).toBe(
      "HIDDEN_PARENT_TTY_ONE_SHOT",
    );
    assertSigningDoesNotAuthorizeSend(result.derived_signing_authorization);
    expect(result.lifecycle.state).toBe("MANDATE_CONSUMED");
  });
});

describe("B.3.6.3 authority subset adversarial", () => {
  it("blocks signing and credential amplifications", () => {
    const dir = workDir();
    const mandate = sealMandate();
    const result = deriveConditionalCredentialSigningArtifacts({
      directory: dir,
      runId: "run_sub",
      attemptId: "attempt_sub",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger: new BuyerConditionalMandateLedger(),
    });
    const mandateSha = humanConditionalCredentialSigningMandateSha256(mandate);
    const unsigned = JSON.parse(readFileSync(join(dir, UNSIGNED_ARTIFACT), "utf8"));

    expect(() =>
      verifyDerivedSigningAuthorizationIsSubsetOfConditionalMandate({
        mandate,
        mandateSha256: mandateSha,
        freshRequirements: observation(),
        unsignedArtifact: unsigned,
        unsignedArtifactSha256: result.unsigned_artifact_sha256,
        derivedSigningAuthorization: {
          ...result.derived_signing_authorization,
          amount_atomic: "1001",
        },
      }),
    ).toThrow(BLOCKED_B363_DERIVED_AUTHORITY_NOT_SUBSET);

    expect(() =>
      verifyDerivedSigningAuthorizationIsSubsetOfConditionalMandate({
        mandate,
        mandateSha256: mandateSha,
        freshRequirements: observation(),
        unsignedArtifact: unsigned,
        unsignedArtifactSha256: result.unsigned_artifact_sha256,
        derivedSigningAuthorization: {
          ...result.derived_signing_authorization,
          payment_bearing_send_authorized: true as false,
        },
      }),
    ).toThrow(/GUARD_SIGNING_DOES_NOT_AUTHORIZE_SEND|BLOCKED_B363/);

    expect(() =>
      verifyDerivedCredentialAccessAuthorizationIsSubsetOfConditionalMandate({
        mandate,
        mandateSha256: mandateSha,
        unsignedArtifact: unsigned,
        unsignedArtifactSha256: result.unsigned_artifact_sha256,
        signingAuthorization: result.derived_signing_authorization,
        signingAuthorizationSha256: result.derived_signing_authorization_sha256,
        derivedCredentialAccessAuthorization: {
          ...result.derived_credential_access_authorization,
          max_credential_acquisitions: 2 as 1,
        },
      }),
    ).toThrow(GUARD_DERIVED_CREDENTIAL_AUTHORITY_SUBSET);

    expect(() =>
      verifyDerivedCredentialAccessAuthorizationIsSubsetOfConditionalMandate({
        mandate,
        mandateSha256: mandateSha,
        unsignedArtifact: unsigned,
        unsignedArtifactSha256: result.unsigned_artifact_sha256,
        signingAuthorization: result.derived_signing_authorization,
        signingAuthorizationSha256: result.derived_signing_authorization_sha256,
        derivedCredentialAccessAuthorization: {
          ...result.derived_credential_access_authorization,
          provider_id: "encrypted-local-keystore",
        },
      }),
    ).toThrow(GUARD_DERIVED_CREDENTIAL_AUTHORITY_SUBSET);

    expect(() =>
      verifyDerivedCredentialAccessAuthorizationIsSubsetOfConditionalMandate({
        mandate,
        mandateSha256: mandateSha,
        unsignedArtifact: unsigned,
        unsignedArtifactSha256: result.unsigned_artifact_sha256,
        signingAuthorization: result.derived_signing_authorization,
        signingAuthorizationSha256: result.derived_signing_authorization_sha256,
        derivedCredentialAccessAuthorization: {
          ...result.derived_credential_access_authorization,
          access_expires_at: "2099-01-01T00:00:00.000Z",
        },
      }),
    ).toThrow(GUARD_DERIVED_CREDENTIAL_AUTHORITY_SUBSET);
  });
});

describe("B.3.6.3 duplicate / crash policy", () => {
  it("second derivation blocked", () => {
    const mandate = sealMandate();
    const ledger = new BuyerConditionalMandateLedger();
    deriveConditionalCredentialSigningArtifacts({
      directory: workDir(),
      runId: "r1",
      attemptId: "a1",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger,
    });
    expect(() =>
      deriveConditionalCredentialSigningArtifacts({
        directory: workDir(),
        runId: "r2",
        attemptId: "a2",
        mandate,
        freshObservation: observation(),
        now: NOW,
        nonceSource: () => `0x${"cd".repeat(32)}`,
        ledger,
      }),
    ).toThrow(BLOCKED_B363_CONDITIONAL_MANDATE_ALREADY_CONSUMED);
  });

  it("crash recovery never generates second attempt/credential auth", () => {
    expect(
      evaluateConditionalMandateCrashRecovery({
        schema_version: "trustforge_conditional_mandate_lifecycle.v1",
        mandate_decision_id: "m",
        mandate_sha256: "aa".repeat(32),
        state: "JIT_DERIVATION_RESERVED",
        updated_at: NOW.toISOString(),
        run_id: "r",
        attempt_id: null,
        unsigned_artifact_sha256: null,
        derived_signing_authorization_sha256: null,
        derived_credential_access_authorization_sha256: null,
        max_attempts: 1,
        max_nonces: 1,
        max_unsigned_artifacts: 1,
        max_signing_authorizations: 1,
        max_credential_acquisitions: 1,
        max_signer_invocations: 1,
        notes: null,
      }).action,
    ).toBe("REQUIRE_NEW_HUMAN_MANDATE");

    expect(
      evaluateConditionalMandateCrashRecovery({
        schema_version: "trustforge_conditional_mandate_lifecycle.v1",
        mandate_decision_id: "m",
        mandate_sha256: "bb".repeat(32),
        state: "UNSIGNED_PERSISTED",
        updated_at: NOW.toISOString(),
        run_id: "r",
        attempt_id: "a",
        unsigned_artifact_sha256: "cc".repeat(32),
        derived_signing_authorization_sha256: null,
        derived_credential_access_authorization_sha256: null,
        max_attempts: 1,
        max_nonces: 1,
        max_unsigned_artifacts: 1,
        max_signing_authorizations: 1,
        max_credential_acquisitions: 1,
        max_signer_invocations: 1,
        notes: null,
      }).action,
    ).toBe("COMPLETE_SIGNING_AUTHORIZATION_FOR_EXISTING_UNSIGNED");

    expect(
      evaluateConditionalMandateCrashRecovery({
        schema_version: "trustforge_conditional_mandate_lifecycle.v1",
        mandate_decision_id: "m",
        mandate_sha256: "dd".repeat(32),
        state: "SIGNING_AUTHORIZATION_DERIVED",
        updated_at: NOW.toISOString(),
        run_id: "r",
        attempt_id: "a",
        unsigned_artifact_sha256: "ee".repeat(32),
        derived_signing_authorization_sha256: "ff".repeat(32),
        derived_credential_access_authorization_sha256: null,
        max_attempts: 1,
        max_nonces: 1,
        max_unsigned_artifacts: 1,
        max_signing_authorizations: 1,
        max_credential_acquisitions: 1,
        max_signer_invocations: 1,
        notes: null,
      }).may_derive_second_credential_auth,
    ).toBe(false);
  });
});

describe("B.3.6.3 synthetic e2e to send gate", () => {
  it("TTY → pipe → runtime-key → one signature → SEND GATE", async () => {
    const dir = workDir();
    const mandate = sealMandate();
    const derivation = deriveConditionalCredentialSigningArtifacts({
      directory: dir,
      runId: "run_e2e",
      attemptId: "attempt_e2e",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger: new BuyerConditionalMandateLedger(),
    });
    const policyPath = writeAccessEnabledPolicy(dir);
    const tty = createSyntheticHiddenTty();
    tty.enqueueHexKeyThenEnter(SYNTHETIC_B33_RUNTIME_KEY);
    const provider = createExplicitRuntimeKeyCredentialProvider();
    const terminal = await runSyntheticConditionalMandateSignToSendGate({
      directory: dir,
      derivation,
      mandate,
      now: NOW,
      provider,
      secretEntryTerminal: tty.terminal,
      credentialPolicyPath: policyPath,
    });
    expect(terminal.terminal).toBe(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED);
    expect(terminal.signer_calls).toBe(1);
    expect(terminal.payment_headers).toBe(0);
    expect(tty.rawModeEnableCount.value).toBe(1);
    expect(provider.acquireCalls).toBe(1);
    expect(provider.signerCalls).toBe(1);
    expect(existsSync(join(dir, "buyer_authorization_signed.json"))).toBe(true);
  });
});

describe("B.3.6.3 structural send separation", () => {
  it("GUARD_SIGNING_DOES_NOT_AUTHORIZE_SEND", () => {
    const dir = workDir();
    const result = deriveConditionalCredentialSigningArtifacts({
      directory: dir,
      runId: "run_send",
      attemptId: "attempt_send",
      mandate: sealMandate(),
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger: new BuyerConditionalMandateLedger(),
    });
    expect(() =>
      assertSigningDoesNotAuthorizeSend({
        ...result.derived_signing_authorization,
        payment_bearing_send_authorized: true as false,
      }),
    ).toThrow(GUARD_SIGNING_DOES_NOT_AUTHORIZE_SEND);
  });
});
