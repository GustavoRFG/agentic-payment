/**
 * B.3.7 conditional one-shot payment send mandate — synthetic/offline only.
 * NO LIVE ONESOURCE. NO REAL KEY. NO REAL PAYMENT.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AMBIGUOUS_SEND_TERMINAL_RECONCILE,
  BLOCKED_B37_DERIVED_SEND_AUTHORITY_NOT_SUBSET,
  BLOCKED_B37_SEND_MANDATE_EXPIRED,
  GUARD_HUMAN_SEND_MANDATE_CANNOT_DIRECTLY_REACH_NETWORK,
  GUARD_NO_RESEND_AFTER_AMBIGUOUS_SEND,
  GUARD_PAYMENT_SEND_ONE_SHOT_NO_RETRY,
  GUARD_PAYMENT_SEND_REQUIRES_EXACT_DERIVED_AUTHORIZATION,
  GUARD_SEND_MANDATE_CANNOT_AUTHORIZE_CREDENTIAL_ACCESS,
  GUARD_SEND_MANDATE_CANNOT_AUTHORIZE_SIGNING,
  GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
  POST_SIGN_JIT_AUDIT_PASS,
} from "../../tools/trustforge/b37-execution-gates";
import { UNSIGNED_ARTIFACT, SIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import {
  buildPrepareAuthorizationViewFromConditionalMandate,
  deriveConditionalCredentialSigningArtifacts,
  runSyntheticConditionalMandateSignToSendGate,
} from "../../tools/trustforge/buyer-conditional-credential-signing-derivation";
import {
  buildSyntheticHumanConditionalCredentialSigningMandate,
  humanConditionalCredentialSigningMandateSha256,
  type HumanConditionalCredentialSigningMandate,
} from "../../tools/trustforge/buyer-conditional-credential-signing-mandate";
import { BuyerConditionalMandateLedger } from "../../tools/trustforge/buyer-conditional-mandate-lifecycle";
import {
  assertNotHumanSendMandateForCredential,
  assertNotHumanSendMandateForNetwork,
  assertNotHumanSendMandateForSigner,
  buildSyntheticHumanConditionalPaymentSendMandate,
  humanConditionalPaymentSendMandateSha256,
  validateHumanConditionalPaymentSendMandate,
  type HumanConditionalPaymentSendMandate,
} from "../../tools/trustforge/buyer-conditional-payment-send-mandate";
import { verifyDerivedPaymentSendAuthorizationIsSubsetOfSendMandate } from "../../tools/trustforge/buyer-conditional-payment-send-authority-subset";
import {
  derivePaymentSendAuthorization,
  runSyntheticConditionalPaymentSendE2E,
} from "../../tools/trustforge/buyer-conditional-payment-send-derivation";
import {
  assertExactDerivedPaymentSendAuthorization,
  assertSigningAuthorizationCannotAuthorizeSend,
} from "../../tools/trustforge/buyer-payment-send-authorization";
import {
  BuyerPaymentSendLedger,
  evaluatePaymentSendCrashRecovery,
  SyntheticPaymentBearingTransport,
} from "../../tools/trustforge/buyer-payment-send-lifecycle";
import { createExplicitRuntimeKeyCredentialProvider } from "../../tools/trustforge/explicit-runtime-key-credential-provider";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "../../tools/trustforge/explicit-runtime-key-credential-provider";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";
import {
  canonicalJsonSha256,
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
  const dir = mkdtempSync(join(tmpdir(), "b37-"));
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
      request_binding_sha256: requestBindingSha(),
      canonical_requirements_sha256: "req-sha-b37-exact",
      canonical_envelope_sha256: "env-sha-b37-exact",
      ...overrides,
    },
  };
}

function sealSigningMandate(): HumanConditionalCredentialSigningMandate {
  const rb = requestBindingSha();
  const provisional = buildSyntheticHumanConditionalCredentialSigningMandate({
    decisionId: "b37-sign-mandate-1",
    endpoint: ENDPOINT,
    method: METHOD,
    requestQuery: QUERY,
    requestBindingSha256: rb,
    sellerNetworkRaw: "eip155:8453",
    canonicalNetworkCaip2: "eip155:8453",
    asset: ASSET,
    payTo: PAY_TO,
    buyerWallet: BUYER,
    amountAtomic: "1000",
    canonicalRequirementsSha256: "req-sha-b37-exact",
    canonicalEnvelopeSha256: "env-sha-b37-exact",
    prepareAuthorizationSha256: "0".repeat(64),
    decidedAt: "2026-08-11T04:55:00.000Z",
    mandateExpiresAt: MANDATE_EXPIRES,
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

function sealSendMandate(
  overrides: Partial<{
    decisionId: string;
    amountAtomic: string;
    mandateExpiresAt: string;
    payTo: string;
    asset: string;
    buyerWallet: string;
    endpoint: string;
  }> = {},
): HumanConditionalPaymentSendMandate {
  return buildSyntheticHumanConditionalPaymentSendMandate({
    decisionId: overrides.decisionId ?? "b37-send-mandate-1",
    endpoint: overrides.endpoint ?? ENDPOINT,
    method: METHOD,
    requestQuery: QUERY,
    requestBindingSha256: requestBindingSha(),
    sellerNetworkRaw: "eip155:8453",
    canonicalNetworkCaip2: "eip155:8453",
    asset: overrides.asset ?? ASSET,
    payTo: overrides.payTo ?? PAY_TO,
    buyerWallet: overrides.buyerWallet ?? BUYER,
    amountAtomic: overrides.amountAtomic ?? "1000",
    canonicalRequirementsSha256: "req-sha-b37-exact",
    canonicalEnvelopeSha256: "env-sha-b37-exact",
    decidedAt: "2026-08-11T04:55:00.000Z",
    mandateExpiresAt: overrides.mandateExpiresAt ?? MANDATE_EXPIRES,
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
        effect: "b37 synthetic",
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

async function signSyntheticAttempt(dir: string): Promise<{
  signingMandate: HumanConditionalCredentialSigningMandate;
  derivation: ReturnType<typeof deriveConditionalCredentialSigningArtifacts>;
}> {
  const signingMandate = sealSigningMandate();
  const derivation = deriveConditionalCredentialSigningArtifacts({
    directory: dir,
    runId: "run_b37",
    attemptId: "attempt_b37",
    mandate: signingMandate,
    freshObservation: observation(),
    now: NOW,
    nonceSource: () => NONCE,
    ledger: new BuyerConditionalMandateLedger(),
  });
  const tty = createSyntheticHiddenTty();
  tty.enqueueHexKeyThenEnter(SYNTHETIC_B33_RUNTIME_KEY);
  await runSyntheticConditionalMandateSignToSendGate({
    directory: dir,
    derivation,
    mandate: signingMandate,
    now: NOW,
    provider: createExplicitRuntimeKeyCredentialProvider(),
    secretEntryTerminal: tty.terminal,
    credentialPolicyPath: writeAccessEnabledPolicy(dir),
  });
  expect(existsSync(join(dir, SIGNED_ARTIFACT))).toBe(true);
  return { signingMandate, derivation };
}

describe("B.3.7 human send mandate contract", () => {
  it("validates synthetic send mandate and blocks direct network/signing/credential use", () => {
    const mandate = sealSendMandate();
    expect(validateHumanConditionalPaymentSendMandate({ mandate, now: NOW })).toBe(mandate);
    expect(() => assertNotHumanSendMandateForNetwork(mandate)).toThrow(
      GUARD_HUMAN_SEND_MANDATE_CANNOT_DIRECTLY_REACH_NETWORK,
    );
    expect(() => assertNotHumanSendMandateForSigner(mandate)).toThrow(
      GUARD_SEND_MANDATE_CANNOT_AUTHORIZE_SIGNING,
    );
    expect(() => assertNotHumanSendMandateForCredential(mandate)).toThrow(
      GUARD_SEND_MANDATE_CANNOT_AUTHORIZE_CREDENTIAL_ACCESS,
    );
    expect(mandate.payment_bearing_send_conditionally_authorized).toBe(true);
    expect(mandate.credential_access_authorized).toBe(false);
    expect(mandate.real_signing_authorized).toBe(false);
    expect(mandate.max_payment_bearing_requests).toBe(1);
    expect(mandate.allow_retry).toBe(false);
    expect(mandate.allow_resend).toBe(false);
  });

  it("expiry boundary: == and > block", () => {
    const mandate = sealSendMandate({ mandateExpiresAt: "2026-08-11T05:00:05.000Z" });
    expect(() =>
      validateHumanConditionalPaymentSendMandate({
        mandate,
        now: new Date("2026-08-11T05:00:05.000Z"),
      }),
    ).toThrow(BLOCKED_B37_SEND_MANDATE_EXPIRED);
  });
});

describe("B.3.7 authority separation guards", () => {
  it("signing authorization cannot authorize send", async () => {
    const dir = workDir();
    const { derivation } = await signSyntheticAttempt(dir);
    expect(() =>
      assertSigningAuthorizationCannotAuthorizeSend(derivation.derived_signing_authorization),
    ).toThrow(GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND);
    expect(() =>
      assertExactDerivedPaymentSendAuthorization(derivation.derived_signing_authorization),
    ).toThrow(GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND);
    expect(() => assertExactDerivedPaymentSendAuthorization(sealSendMandate())).toThrow(
      GUARD_PAYMENT_SEND_REQUIRES_EXACT_DERIVED_AUTHORIZATION,
    );
  });
});

describe("B.3.7 post-sign audit + derived PaymentSendAuthorization", () => {
  it("derives PSA after synthetic sign with subset PASS", async () => {
    const dir = workDir();
    const { signingMandate, derivation } = await signSyntheticAttempt(dir);
    const sendMandate = sealSendMandate();
    const result = await derivePaymentSendAuthorization({
      directory: dir,
      sendMandate,
      signingMandate,
      signingAuthorization: derivation.derived_signing_authorization,
      credentialAccessAuthorization: derivation.derived_credential_access_authorization,
      now: NOW,
    });
    expect(result.post_sign_jit_audit).toBe(POST_SIGN_JIT_AUDIT_PASS);
    expect(result.derived_payment_send_authorization.payment_bearing_send_authorized).toBe(true);
    expect(result.derived_payment_send_authorization.max_payment_bearing_requests).toBe(1);
    expect(result.derived_payment_send_authorization.allow_retry).toBe(false);
    expect(result.derived_payment_send_authorization.amount_atomic).toBe("1000");
    expect(result.recovered_signer.toLowerCase()).toBe(BUYER.toLowerCase());
  });
});

describe("B.3.7 authority subset adversarial", () => {
  it("rejects amplified derivations", async () => {
    const dir = workDir();
    const { signingMandate, derivation } = await signSyntheticAttempt(dir);
    const sendMandate = sealSendMandate();
    const result = await derivePaymentSendAuthorization({
      directory: dir,
      sendMandate,
      signingMandate,
      signingAuthorization: derivation.derived_signing_authorization,
      credentialAccessAuthorization: derivation.derived_credential_access_authorization,
      now: NOW,
    });
    const sendSha = humanConditionalPaymentSendMandateSha256(sendMandate);
    const signSha = humanConditionalCredentialSigningMandateSha256(signingMandate);
    const base = {
      sendMandate,
      sendMandateSha256: sendSha,
      signingMandateSha256: signSha,
      unsignedArtifactSha256: result.derived_payment_send_authorization.unsigned_artifact_sha256,
      signedArtifactSha256: result.derived_payment_send_authorization.signed_artifact_sha256,
      signingAuthorizationSha256:
        result.derived_payment_send_authorization.signing_authorization_sha256,
      credentialAccessAuthorizationSha256:
        result.derived_payment_send_authorization.credential_access_authorization_sha256,
      attemptId: result.derived_payment_send_authorization.attempt_id,
    };

    const cases: Array<[string, Partial<typeof result.derived_payment_send_authorization>]> = [
      ["amount", { amount_atomic: "1001" }],
      ["asset", { asset: "0x0000000000000000000000000000000000000002" }],
      ["payTo", { pay_to: "0x0000000000000000000000000000000000000001" }],
      ["buyer", { buyer_wallet: "0x0000000000000000000000000000000000000003" }],
      ["endpoint", { endpoint: "https://evil.example/api" }],
      ["query", { request_query: [["network", "sepolia"]] }],
      ["network", { canonical_network_caip2: "eip155:84532" }],
      ["retry", { allow_retry: true as false }],
      ["resend", { allow_resend: true as false }],
      ["expiry", { send_authorization_expires_at: "2099-01-01T00:00:00.000Z" }],
      ["signed", { signed_artifact_sha256: "ff".repeat(32) }],
      ["second_max", { max_payment_bearing_requests: 2 as 1 }],
    ];
    for (const [label, patch] of cases) {
      expect(
        () =>
          verifyDerivedPaymentSendAuthorizationIsSubsetOfSendMandate({
            ...base,
            derived: { ...result.derived_payment_send_authorization, ...patch },
          }),
        label,
      ).toThrow(BLOCKED_B37_DERIVED_SEND_AUTHORITY_NOT_SUBSET);
    }
  });
});

describe("B.3.7 one-shot send lifecycle + ambiguous policy", () => {
  it("crash recovery and ambiguous outcomes are terminal with no resend", () => {
    expect(
      evaluatePaymentSendCrashRecovery({
        record: {
          schema_version: "trustforge_payment_send_lifecycle.v1",
          send_authorization_sha256: "aa".repeat(32),
          send_mandate_sha256: "bb".repeat(32),
          attempt_id: "a",
          state: "SEND_COMMITTED_NO_RETRY",
          updated_at: NOW.toISOString(),
          payment_bearing_request_count: 0,
          max_payment_bearing_requests: 1,
          allow_retry: false,
          allow_resend: false,
          notes: null,
        },
      }).disposition,
    ).toBe(AMBIGUOUS_SEND_TERMINAL_RECONCILE);

    expect(
      evaluatePaymentSendCrashRecovery({
        record: {
          schema_version: "trustforge_payment_send_lifecycle.v1",
          send_authorization_sha256: "aa".repeat(32),
          send_mandate_sha256: "bb".repeat(32),
          attempt_id: "a",
          state: "PAYMENT_REQUEST_INVOKED",
          updated_at: NOW.toISOString(),
          payment_bearing_request_count: 1,
          max_payment_bearing_requests: 1,
          allow_retry: false,
          allow_resend: false,
          notes: null,
        },
      }).disposition,
    ).toBe(AMBIGUOUS_SEND_TERMINAL_RECONCILE);
  });

  it.each([
    "timeout",
    "connection_reset",
    "malformed_response",
    "response_lost_after_possible_receipt",
    "crash_after_invoke",
    "crash_before_fetch",
  ] as const)("synthetic %s → AMBIGUOUS_SEND_TERMINAL_RECONCILE / no resend", async (kind) => {
    const ledger = new BuyerPaymentSendLedger();
    const sha = "cc".repeat(32);
    ledger.issueDerived({
      sendAuthorizationSha256: sha,
      sendMandateSha256: "dd".repeat(32),
      attemptId: "a",
      now: NOW,
    });
    ledger.commitNoRetry({ sendAuthorizationSha256: sha, now: NOW });
    const transport = new SyntheticPaymentBearingTransport({ kind } as never);
    const result = await transport.invokeOnce({
      ledger,
      sendAuthorizationSha256: sha,
      now: NOW,
    });
    expect(result.disposition).toBe(AMBIGUOUS_SEND_TERMINAL_RECONCILE);
    expect(() => ledger.assertMayInvoke(sha)).toThrow(
      /GUARD_NO_RESEND_AFTER_AMBIGUOUS_SEND|BLOCKED_B37_RESEND/,
    );
  });
});

describe("B.3.7 synthetic E2E sign+send", () => {
  it("runs full synthetic path with exactly one payment-bearing request", async () => {
    const dir = workDir();
    const { signingMandate, derivation } = await signSyntheticAttempt(dir);
    const sendMandate = sealSendMandate();
    const e2e = await runSyntheticConditionalPaymentSendE2E({
      directory: dir,
      sendMandate,
      signingMandate,
      signingAuthorization: derivation.derived_signing_authorization,
      credentialAccessAuthorization: derivation.derived_credential_access_authorization,
      now: NOW,
    });
    expect(e2e.payment_bearing_request_invocations).toBe(1);
    expect(e2e.second_invocation_blocked).toBe(true);
    expect(e2e.retry).toBe("none");
    expect(e2e.resend).toBe("none");
    expect(e2e.live_http).toBe(0);
    expect(e2e.post_sign_jit_audit).toBe(POST_SIGN_JIT_AUDIT_PASS);
    expect(e2e.disposition).toBe("RESPONSE_OBSERVED");
    expect(existsSync(join(dir, UNSIGNED_ARTIFACT))).toBe(true);
    expect(existsSync(join(dir, SIGNED_ARTIFACT))).toBe(true);
  });
});
