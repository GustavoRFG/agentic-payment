/**
 * B.3.6.1 JIT one-shot signing mandate — synthetic/offline only.
 * No live HTTP, no operational mandate, no credentials, no payment.
 */

import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED } from "../../tools/trustforge/b31-execution-gates";
import {
  BLOCKED_B361_DERIVED_AUTHORITY_NOT_SUBSET,
  BLOCKED_B361_FRESH_REQUIREMENTS_OUTSIDE_HUMAN_MANDATE,
  BLOCKED_B361_HUMAN_SIGNING_MANDATE_ALREADY_CONSUMED,
  BLOCKED_B361_HUMAN_SIGNING_MANDATE_EXPIRED,
  GUARD_HUMAN_SIGNING_MANDATE_CANNOT_BYPASS_EXACT_SIGNING_AUTHORIZATION,
} from "../../tools/trustforge/b361-execution-gates";
import { UNSIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import {
  buildPrepareAuthorizationViewFromMandate,
  deriveSigningAuthorizationFromOneShotMandate,
  DERIVED_SIGNING_AUTHORIZATION_ARTIFACT,
} from "../../tools/trustforge/buyer-jit-signing-mandate-derivation";
import { assertFreshRequirementsExactMatchMandate } from "../../tools/trustforge/buyer-mandate-fresh-requirements-gate";
import { verifyDerivedSigningAuthorizationIsSubsetOfMandate } from "../../tools/trustforge/buyer-mandate-authority-subset";
import {
  assertNotHumanOneShotSigningMandate,
  buildSyntheticHumanOneShotSigningMandate,
  humanOneShotSigningMandateSha256,
  validateHumanOneShotSigningMandate,
  type HumanOneShotSigningMandate,
} from "../../tools/trustforge/buyer-one-shot-signing-mandate";
import {
  BuyerSigningMandateLedger,
  evaluateMandateCrashRecovery,
  persistSigningMandateLifecycle,
} from "../../tools/trustforge/buyer-signing-mandate-lifecycle";
import {
  buildDerivedBuyerSigningAuthorizationFromMandate,
  buildSyntheticBuyerSigningAuthorization,
  validateBuyerSigningAuthorization,
} from "../../tools/trustforge/buyer-signing-authorization";
import { prepareValidatedBuyerAuthorizationForSigning } from "../../tools/trustforge/buyer-validated-signing";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";
import {
  canonicalJsonSha256,
  SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS,
  type SellerRequirementsObservation,
} from "../../tools/trustforge/x402-seller-requirements-binding";
import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import type { PreSignAttemptArtifact } from "../../tools/trustforge/buyer-pre-sign-validation";

const BUYER = "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1";
const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ENDPOINT = "https://api.onesource.io/api/chain/block-number";
const METHOD = "GET";
const QUERY = [["network", "ethereum"]] as const;
const OBSERVED_AT = "2026-08-11T03:00:00.000Z";
const NOW = new Date("2026-08-11T03:00:05.000Z");
const MANDATE_EXPIRES = "2026-08-11T03:30:00.000Z";
const NONCE = `0x${"ab".repeat(32)}`;

const temporaryDirs: string[] = [];
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b361-jit-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length) {
    const dir = temporaryDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function requestBindingSha(): string {
  return createThinSettlementRequestBinding({
    endpoint: ENDPOINT,
    method: METHOD,
    input_status: "known",
    query: QUERY.map(([k, v]) => [k, v] as [string, string]),
    body: null,
  }).binding_sha256;
}

function observation(
  overrides: Partial<SellerRequirementsObservation["binding"]> = {},
): SellerRequirementsObservation {
  const rb = requestBindingSha();
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
      canonical_requirements_sha256: "req-sha-b361-exact",
      canonical_envelope_sha256: "env-sha-b361-exact",
      ...overrides,
    },
  };
}

function sealMandate(
  overrides: Partial<{
    decisionId: string;
    amountAtomic: string;
    maximumAuthorizedAmountAtomic: string;
    payTo: string;
    asset: string;
    endpoint: string;
    method: string;
    requestQuery: ReadonlyArray<readonly [string, string]>;
    sellerNetworkRaw: string;
    canonicalNetworkCaip2: string;
    chainId: number;
    buyerWallet: string;
    requirementsSha: string;
    envelopeSha: string;
    decidedAt: string;
    mandateExpiresAt: string;
    scheme: string;
  }> = {},
): HumanOneShotSigningMandate {
  const endpoint = overrides.endpoint ?? ENDPOINT;
  const method = overrides.method ?? METHOD;
  const query = overrides.requestQuery ?? QUERY;
  const rb = createThinSettlementRequestBinding({
    endpoint,
    method,
    input_status: "known",
    query: query.map(([k, v]) => [k, v] as [string, string]),
    body: null,
  }).binding_sha256;
  const provisional = buildSyntheticHumanOneShotSigningMandate({
    decisionId: overrides.decisionId ?? "mandate-decision-1",
    endpoint,
    method,
    requestQuery: query,
    requestBindingSha256: rb,
    sellerNetworkRaw: overrides.sellerNetworkRaw ?? "eip155:8453",
    canonicalNetworkCaip2: overrides.canonicalNetworkCaip2 ?? "eip155:8453",
    chainId: overrides.chainId ?? 8453,
    asset: overrides.asset ?? ASSET,
    payTo: overrides.payTo ?? PAY_TO,
    buyerWallet: overrides.buyerWallet ?? BUYER,
    amountAtomic: overrides.amountAtomic ?? "1000",
    maximumAuthorizedAmountAtomic: overrides.maximumAuthorizedAmountAtomic ?? "1000",
    canonicalRequirementsSha256: overrides.requirementsSha ?? "req-sha-b361-exact",
    canonicalEnvelopeSha256: overrides.envelopeSha ?? "env-sha-b361-exact",
    prepareAuthorizationSha256: "0".repeat(64),
    decidedAt: overrides.decidedAt ?? "2026-08-11T02:55:00.000Z",
    mandateExpiresAt: overrides.mandateExpiresAt ?? MANDATE_EXPIRES,
    scheme: overrides.scheme,
  });
  const prepareHash = canonicalJsonSha256(buildPrepareAuthorizationViewFromMandate(provisional));
  return buildSyntheticHumanOneShotSigningMandate({
    decisionId: provisional.decision_id,
    endpoint: provisional.endpoint,
    method: provisional.method,
    requestQuery: provisional.request_query,
    requestBindingSha256: provisional.request_binding_sha256,
    sellerNetworkRaw: provisional.seller_network_raw,
    canonicalNetworkCaip2: provisional.canonical_network_caip2,
    chainId: provisional.chain_id,
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
    scheme: provisional.scheme,
    x402Version: provisional.x402_version,
    provider: provisional.provider,
    serviceId: provisional.service_id,
  });
}

describe("B.3.6.1 human one-shot signing mandate contract", () => {
  it("validates synthetic mandate and is not directly signable", () => {
    const mandate = sealMandate();
    expect(validateHumanOneShotSigningMandate({ mandate, now: NOW })).toBe(mandate);
    expect(() => assertNotHumanOneShotSigningMandate(mandate)).toThrow(
      GUARD_HUMAN_SIGNING_MANDATE_CANNOT_BYPASS_EXACT_SIGNING_AUTHORIZATION,
    );
  });

  it("blocks mandate at expiry boundary and after", () => {
    const mandate = sealMandate({ mandateExpiresAt: "2026-08-11T03:00:05.000Z" });
    expect(() =>
      validateHumanOneShotSigningMandate({
        mandate,
        now: new Date("2026-08-11T03:00:05.000Z"),
      }),
    ).toThrow(BLOCKED_B361_HUMAN_SIGNING_MANDATE_EXPIRED);
    expect(() =>
      validateHumanOneShotSigningMandate({
        mandate,
        now: new Date("2026-08-11T03:00:06.000Z"),
      }),
    ).toThrow(BLOCKED_B361_HUMAN_SIGNING_MANDATE_EXPIRED);
    expect(
      validateHumanOneShotSigningMandate({
        mandate,
        now: new Date("2026-08-11T03:00:04.999Z"),
      }),
    ).toBe(mandate);
  });
});

describe("B.3.6.1 exact fresh requirements gate", () => {
  const cases: Array<[string, Partial<SellerRequirementsObservation["binding"]>]> = [
    ["amount", { amount_atomic: "1001" }],
    ["zero_amount", { amount_atomic: "0" }],
    ["payTo", { pay_to: "0x0000000000000000000000000000000000000001" }],
    ["asset", { asset: "0x0000000000000000000000000000000000000002" }],
    ["network", { canonical_network_caip2: "eip155:84532", seller_network_raw: "eip155:84532" }],
    ["scheme", { scheme: "upto" }],
    ["requirements", { canonical_requirements_sha256: "other-req" }],
    ["envelope", { canonical_envelope_sha256: "other-env" }],
    ["request_binding", { request_binding_sha256: "other-rb" }],
  ];

  for (const [label, bindingOverrides] of cases) {
    it(`blocks before attempt when ${label} changes`, () => {
      const mandate = sealMandate();
      expect(() =>
        assertFreshRequirementsExactMatchMandate({
          mandate,
          freshObservation: observation(bindingOverrides),
          freshEndpoint: ENDPOINT,
          freshMethod: METHOD,
          freshRequestQuery: QUERY,
          freshRequestBody: null,
        }),
      ).toThrow(BLOCKED_B361_FRESH_REQUIREMENTS_OUTSIDE_HUMAN_MANDATE);
    });
  }

  it("blocks endpoint and method changes", () => {
    const mandate = sealMandate();
    expect(() =>
      assertFreshRequirementsExactMatchMandate({
        mandate,
        freshObservation: observation(),
        freshEndpoint: "https://evil.example/api",
        freshMethod: METHOD,
        freshRequestQuery: QUERY,
        freshRequestBody: null,
      }),
    ).toThrow(BLOCKED_B361_FRESH_REQUIREMENTS_OUTSIDE_HUMAN_MANDATE);
    expect(() =>
      assertFreshRequirementsExactMatchMandate({
        mandate,
        freshObservation: observation(),
        freshEndpoint: ENDPOINT,
        freshMethod: "POST",
        freshRequestQuery: QUERY,
        freshRequestBody: null,
      }),
    ).toThrow(BLOCKED_B361_FRESH_REQUIREMENTS_OUTSIDE_HUMAN_MANDATE);
  });

  it("blocks query changes", () => {
    const mandate = sealMandate();
    expect(() =>
      assertFreshRequirementsExactMatchMandate({
        mandate,
        freshObservation: observation(),
        freshEndpoint: ENDPOINT,
        freshMethod: METHOD,
        freshRequestQuery: [["network", "sepolia"]],
        freshRequestBody: null,
      }),
    ).toThrow(BLOCKED_B361_FRESH_REQUIREMENTS_OUTSIDE_HUMAN_MANDATE);
  });
});

describe("B.3.6.1 positive synthetic JIT derivation", () => {
  it("derives one signing authorization, pre-sign PASS, credential BLOCK", () => {
    const dir = workDir();
    const mandate = sealMandate();
    const ledger = new BuyerSigningMandateLedger();
    const result = deriveSigningAuthorizationFromOneShotMandate({
      directory: dir,
      runId: "run_b361_positive",
      attemptId: "attempt_b361_1",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger,
      cwd: process.cwd(),
    });

    expect(result.ok).toBe(true);
    expect(result.pre_sign_current_validity).toBe("PASS");
    expect(result.credential_access).toBe(BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED);
    expect(result.credential_accesses).toBe(0);
    expect(result.signer_calls).toBe(0);
    expect(result.payment_headers).toBe(0);
    expect(result.payments).toBe(0);
    expect(result.local_freshness_cap_seconds).toBe(300);
    expect(SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS).toBe(300);
    expect(result.lifecycle.state).toBe("MANDATE_CONSUMED");
    expect(existsSync(join(dir, UNSIGNED_ARTIFACT))).toBe(true);
    expect(existsSync(join(dir, DERIVED_SIGNING_AUTHORIZATION_ARTIFACT))).toBe(true);

    const derived = result.derived_signing_authorization;
    expect(derived.derivation_type).toBe("DETERMINISTIC_FROM_HUMAN_ONE_SHOT_SIGNING_MANDATE");
    expect(derived.parent_human_one_shot_signing_mandate_sha256).toBe(result.mandate_sha256);
    expect(derived.unsigned_artifact_sha256).toBe(result.unsigned_artifact_sha256);
    expect(derived.max_signatures).toBe(1);
    expect(derived.allow_resign).toBe(false);
    expect(derived.payment_bearing_send_authorized).toBe(false);
    expect(derived.settlement_authorized).toBe(false);
  });
});

describe("B.3.6.1 authority subset", () => {
  it("rejects adversarial amplifications", () => {
    const dir = workDir();
    const mandate = sealMandate();
    const result = deriveSigningAuthorizationFromOneShotMandate({
      directory: dir,
      runId: "run_subset",
      attemptId: "attempt_subset",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger: new BuyerSigningMandateLedger(),
      cwd: process.cwd(),
    });
    const unsigned = JSON.parse(
      readFileSync(join(dir, UNSIGNED_ARTIFACT), "utf8"),
    ) as UnsignedArtifact;
    const mandateSha = humanOneShotSigningMandateSha256(mandate);

    const attacks: Array<[string, BuyerSigningAuthorization]> = [
      [
        "amount 1001",
        { ...result.derived_signing_authorization, amount_atomic: "1001" },
      ],
      [
        "payTo",
        {
          ...result.derived_signing_authorization,
          pay_to: "0x0000000000000000000000000000000000000099",
        },
      ],
      [
        "asset",
        {
          ...result.derived_signing_authorization,
          asset: "0x0000000000000000000000000000000000000098",
        },
      ],
      [
        "endpoint",
        { ...result.derived_signing_authorization, endpoint: "https://evil.example" },
      ],
      [
        "network",
        {
          ...result.derived_signing_authorization,
          canonical_network_caip2: "eip155:84532",
        },
      ],
      [
        "buyer",
        {
          ...result.derived_signing_authorization,
          buyer_wallet: "0x0000000000000000000000000000000000000097",
        },
      ],
      [
        "send true",
        {
          ...result.derived_signing_authorization,
          payment_bearing_send_authorized: true as false,
        },
      ],
      [
        "settlement true",
        {
          ...result.derived_signing_authorization,
          settlement_authorized: true as false,
        },
      ],
      [
        "longer expiry",
        {
          ...result.derived_signing_authorization,
          signing_authorization_expires_at: "2099-01-01T00:00:00.000Z",
        },
      ],
    ];

    for (const [label, derived] of attacks) {
      expect(
        () =>
          verifyDerivedSigningAuthorizationIsSubsetOfMandate({
            mandate,
            mandateSha256: mandateSha,
            freshRequirements: observation(),
            unsignedArtifact: unsigned,
            unsignedArtifactSha256: result.unsigned_artifact_sha256,
            derivedSigningAuthorization: derived,
          }),
        label,
      ).toThrow(BLOCKED_B361_DERIVED_AUTHORITY_NOT_SUBSET);
    }
  });
});

describe("B.3.6.1 duplicate consumption", () => {
  it("second derivation is blocked with no second artifacts", () => {
    const dir1 = workDir();
    const dir2 = workDir();
    const mandate = sealMandate();
    const ledger = new BuyerSigningMandateLedger();
    deriveSigningAuthorizationFromOneShotMandate({
      directory: dir1,
      runId: "run_dup_1",
      attemptId: "attempt_dup_1",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger,
      cwd: process.cwd(),
    });
    expect(() =>
      deriveSigningAuthorizationFromOneShotMandate({
        directory: dir2,
        runId: "run_dup_2",
        attemptId: "attempt_dup_2",
        mandate,
        freshObservation: observation(),
        now: NOW,
        nonceSource: () => `0x${"cd".repeat(32)}`,
        ledger,
        cwd: process.cwd(),
      }),
    ).toThrow(BLOCKED_B361_HUMAN_SIGNING_MANDATE_ALREADY_CONSUMED);
    expect(existsSync(join(dir2, UNSIGNED_ARTIFACT))).toBe(false);
    expect(existsSync(join(dir2, DERIVED_SIGNING_AUTHORIZATION_ARTIFACT))).toBe(false);
  });
});

describe("B.3.6.1 seller change during derivation", () => {
  it("fresh mismatch after reservation does not create attempt/nonce/auth", () => {
    const dir = workDir();
    const mandate = sealMandate();
    const ledger = new BuyerSigningMandateLedger();
    expect(() =>
      deriveSigningAuthorizationFromOneShotMandate({
        directory: dir,
        runId: "run_mismatch",
        attemptId: "attempt_mismatch",
        mandate,
        freshObservation: observation({ amount_atomic: "1001" }),
        now: NOW,
        nonceSource: () => NONCE,
        ledger,
        cwd: process.cwd(),
      }),
    ).toThrow(BLOCKED_B361_FRESH_REQUIREMENTS_OUTSIDE_HUMAN_MANDATE);
    expect(existsSync(join(dir, UNSIGNED_ARTIFACT))).toBe(false);
    expect(existsSync(join(dir, DERIVED_SIGNING_AUTHORIZATION_ARTIFACT))).toBe(false);
    expect(ledger.get(humanOneShotSigningMandateSha256(mandate))?.state).toBe(
      "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE",
    );
  });
});

describe("B.3.6.1 crash/restart policy", () => {
  it("after reservation before fresh — require new mandate", () => {
    const record = {
      schema_version: "trustforge_signing_mandate_lifecycle.v1" as const,
      mandate_decision_id: "m1",
      mandate_sha256: "aa".repeat(32),
      state: "JIT_DERIVATION_RESERVED" as const,
      updated_at: NOW.toISOString(),
      run_id: "run",
      attempt_id: null,
      unsigned_artifact_sha256: null,
      derived_signing_authorization_sha256: null,
      max_attempts: 1 as const,
      max_nonces: 1 as const,
      max_unsigned_artifacts: 1 as const,
      max_derived_signing_authorizations: 1 as const,
      notes: "crash",
    };
    const recovery = evaluateMandateCrashRecovery(record);
    expect(recovery.may_generate_new_attempt).toBe(false);
    expect(recovery.may_generate_new_nonce).toBe(false);
    expect(recovery.action).toBe("REQUIRE_NEW_HUMAN_MANDATE");
  });

  it("after attempt/nonce without unsigned — require new mandate", () => {
    const recovery = evaluateMandateCrashRecovery({
      schema_version: "trustforge_signing_mandate_lifecycle.v1",
      mandate_decision_id: "m1",
      mandate_sha256: "bb".repeat(32),
      state: "ATTEMPT_RESERVED",
      updated_at: NOW.toISOString(),
      run_id: "run",
      attempt_id: "attempt",
      unsigned_artifact_sha256: null,
      derived_signing_authorization_sha256: null,
      max_attempts: 1,
      max_nonces: 1,
      max_unsigned_artifacts: 1,
      max_derived_signing_authorizations: 1,
      notes: null,
    });
    expect(recovery.action).toBe("REQUIRE_NEW_HUMAN_MANDATE");
  });

  it("after unsigned persistence — may complete derived auth only for that unsigned", () => {
    const dir = workDir();
    const mandate = sealMandate();
    const first = deriveSigningAuthorizationFromOneShotMandate({
      directory: dir,
      runId: "run_recover",
      attemptId: "attempt_recover",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger: new BuyerSigningMandateLedger(),
      cwd: process.cwd(),
    });
    // Simulate crash-after-unsigned by evaluating recovery on UNSIGNED_PERSISTED snapshot.
    const mid = {
      ...first.lifecycle,
      state: "UNSIGNED_PERSISTED" as const,
      derived_signing_authorization_sha256: null,
    };
    const recovery = evaluateMandateCrashRecovery(mid);
    expect(recovery.action).toBe("COMPLETE_DERIVED_AUTHORIZATION_FOR_EXISTING_UNSIGNED");
    expect(recovery.may_generate_new_attempt).toBe(false);
    expect(recovery.may_generate_new_nonce).toBe(false);
    expect(recovery.may_generate_new_unsigned).toBe(false);
  });

  it("after derived authorization — already complete", () => {
    const recovery = evaluateMandateCrashRecovery({
      schema_version: "trustforge_signing_mandate_lifecycle.v1",
      mandate_decision_id: "m1",
      mandate_sha256: "cc".repeat(32),
      state: "MANDATE_CONSUMED",
      updated_at: NOW.toISOString(),
      run_id: "run",
      attempt_id: "attempt",
      unsigned_artifact_sha256: "dd".repeat(32),
      derived_signing_authorization_sha256: "ee".repeat(32),
      max_attempts: 1,
      max_nonces: 1,
      max_unsigned_artifacts: 1,
      max_derived_signing_authorizations: 1,
      notes: null,
    });
    expect(recovery.action).toBe("ALREADY_COMPLETE");
  });
});

describe("B.3.6.1 structural signer invariant", () => {
  it("rejects human mandate as signing authorization", () => {
    const mandate = sealMandate();
    const dir = workDir();
    const result = deriveSigningAuthorizationFromOneShotMandate({
      directory: dir,
      runId: "run_guard",
      attemptId: "attempt_guard",
      mandate: sealMandate({ decisionId: "other-for-unsigned" }),
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger: new BuyerSigningMandateLedger(),
      cwd: process.cwd(),
    });
    const unsigned = JSON.parse(
      readFileSync(join(dir, UNSIGNED_ARTIFACT), "utf8"),
    ) as UnsignedArtifact;
    const attempt = JSON.parse(
      readFileSync(join(dir, "buyer_authorization_attempt.json"), "utf8"),
    ) as PreSignAttemptArtifact;
    const prepareView = buildPrepareAuthorizationViewFromMandate(
      sealMandate({ decisionId: "other-for-unsigned" }),
    );
    expect(() =>
      prepareValidatedBuyerAuthorizationForSigning({
        unsignedArtifact: unsigned,
        attempt,
        humanAuthorization: prepareView,
        signingAuthorization: mandate as unknown as ReturnType<
          typeof buildSyntheticBuyerSigningAuthorization
        >,
        now: NOW,
        expectedUnsignedHash: result.unsigned_artifact_sha256,
      }),
    ).toThrow(GUARD_HUMAN_SIGNING_MANDATE_CANNOT_BYPASS_EXACT_SIGNING_AUTHORIZATION);

    expect(() =>
      validateBuyerSigningAuthorization({
        authorization: mandate as unknown as ReturnType<
          typeof buildSyntheticBuyerSigningAuthorization
        >,
        unsignedArtifact: unsigned,
        unsignedArtifactSha256: result.unsigned_artifact_sha256,
        prepareAuthorizationSha256: canonicalJsonSha256(prepareView),
        now: NOW,
      }),
    ).toThrow(GUARD_HUMAN_SIGNING_MANDATE_CANNOT_BYPASS_EXACT_SIGNING_AUTHORIZATION);
  });
});

describe("B.3.6.1 derived authorization builder", () => {
  it("records derivation metadata", () => {
    const mandate = sealMandate();
    const dir = workDir();
    const result = deriveSigningAuthorizationFromOneShotMandate({
      directory: dir,
      runId: "run_meta",
      attemptId: "attempt_meta",
      mandate,
      freshObservation: observation(),
      now: NOW,
      nonceSource: () => NONCE,
      ledger: new BuyerSigningMandateLedger(),
      cwd: process.cwd(),
    });
    const unsigned = JSON.parse(
      readFileSync(join(dir, UNSIGNED_ARTIFACT), "utf8"),
    ) as UnsignedArtifact;
    const rebuilt = buildDerivedBuyerSigningAuthorizationFromMandate({
      decisionId: "rebuild",
      prepareAuthorizationSha256: mandate.prepare_authorization_sha256,
      parentMandateSha256: result.mandate_sha256,
      unsignedArtifact: unsigned,
      unsignedArtifactSha256: result.unsigned_artifact_sha256,
      signingAuthorizationExpiresAt: unsigned.effective_signing_deadline,
    });
    expect(rebuilt.derivation_type).toBe(
      "DETERMINISTIC_FROM_HUMAN_ONE_SHOT_SIGNING_MANDATE",
    );
    expect(rebuilt.parent_human_one_shot_signing_mandate_sha256).toBe(result.mandate_sha256);
  });
});

describe("B.3.6.1 lifecycle persistence helper", () => {
  it("write-once lifecycle artifact", () => {
    const dir = workDir();
    const record = {
      schema_version: "trustforge_signing_mandate_lifecycle.v1" as const,
      mandate_decision_id: "m",
      mandate_sha256: "ff".repeat(32),
      state: "MANDATE_ISSUED" as const,
      updated_at: NOW.toISOString(),
      run_id: null,
      attempt_id: null,
      unsigned_artifact_sha256: null,
      derived_signing_authorization_sha256: null,
      max_attempts: 1 as const,
      max_nonces: 1 as const,
      max_unsigned_artifacts: 1 as const,
      max_derived_signing_authorizations: 1 as const,
      notes: null,
    };
    persistSigningMandateLifecycle(dir, record);
    expect(() => persistSigningMandateLifecycle(dir, record)).toThrow(/BLOCKED_BUYER_ARTIFACT_OVERWRITE/);
  });
});
