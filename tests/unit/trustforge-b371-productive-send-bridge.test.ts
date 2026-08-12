/**
 * B.3.7.1 productive one-shot payment send bridge — synthetic/loopback only.
 * NO REAL KEY. NO REAL SIGNATURE operational reuse. NO ONESOURCE PAYMENT.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  AMBIGUOUS_SEND_TERMINAL_RECONCILE,
  BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST,
} from "../../tools/trustforge/b37-execution-gates";
import {
  BLOCKED_B371_PAYMENT_SEND_AUTHORIZATION_EXPIRED,
  BLOCKED_B371_PAYMENT_SEND_BINDING_MISMATCH,
  GUARD_B37_OPERATIONAL_PAYMENT_CANNOT_USE_KEY_HELD_LIVE_EXECUTOR,
  GUARD_NO_PAYMENT_HEADER_SECRET_LEAKAGE,
  GUARD_PRODUCTIVE_SEND_BRIDGE_CANNOT_SIGN,
  GUARD_SEND_IMPLEMENTATION_AVAILABLE_NOT_AUTHORIZATION,
} from "../../tools/trustforge/b371-execution-gates";
import {
  SIGNED_ARTIFACT,
  UNSIGNED_ARTIFACT,
} from "../../tools/trustforge/buyer-authorization-artifacts";
import {
  buildPrepareAuthorizationViewFromConditionalMandate,
  deriveConditionalCredentialSigningArtifacts,
  runSyntheticConditionalMandateSignToSendGate,
} from "../../tools/trustforge/buyer-conditional-credential-signing-derivation";
import {
  buildSyntheticHumanConditionalCredentialSigningMandate,
  humanConditionalCredentialSigningMandateSha256,
} from "../../tools/trustforge/buyer-conditional-credential-signing-mandate";
import { BuyerConditionalMandateLedger } from "../../tools/trustforge/buyer-conditional-mandate-lifecycle";
import {
  buildSyntheticHumanConditionalPaymentSendMandate,
  humanConditionalPaymentSendMandateSha256,
} from "../../tools/trustforge/buyer-conditional-payment-send-mandate";
import { derivePaymentSendAuthorization } from "../../tools/trustforge/buyer-conditional-payment-send-derivation";
import {
  createFetchPaymentBearingHttpTransport,
  createInjectedPaymentBearingHttpTransport,
} from "../../tools/trustforge/buyer-payment-bearing-http-transport";
import {
  buildPaymentHeaderFromPersistedSignedArtifact,
  buildX402ExactPaymentPayloadFromPersistedArtifacts,
  encodeX402PaymentSignatureHeaderFromPayload,
  sanitizeBuiltPaymentHeaderEvidence,
  X402_V2_PAYMENT_HEADER_NAME,
} from "../../tools/trustforge/buyer-payment-header-from-signed-artifact";
import { paymentSendAuthorizationSha256 } from "../../tools/trustforge/buyer-payment-send-authorization";
import {
  BuyerPaymentSendLedger,
  evaluatePaymentSendCrashRecovery,
} from "../../tools/trustforge/buyer-payment-send-lifecycle";
import {
  assertB37OperationalPaymentCannotUseKeyHeldLiveExecutor,
  assertProductiveSendBridgeCannotSign,
  assertSendImplementationAvailableIsNotAuthorization,
  sendAuthorizedPaymentOnce,
  sha256WriteOnceBody,
} from "../../tools/trustforge/buyer-productive-one-shot-payment-sender";
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
import { encodePaymentSignatureHeader } from "@x402/core/http";
import {
  SYNTHETIC_B33_RUNTIME_ADDRESS,
  SYNTHETIC_B33_RUNTIME_KEY,
} from "../support/trustforge-synthetic-runtime-key";
import { createSyntheticHiddenTty } from "../support/trustforge-synthetic-hidden-tty";

const BUYER = SYNTHETIC_B33_RUNTIME_ADDRESS;
const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ENDPOINT = "https://api.onesource.io/api/chain/block-number";
const QUERY = [["network", "ethereum"]] as const;
const OBSERVED_AT = "2026-08-11T05:00:00.000Z";
const NOW = new Date("2026-08-11T05:00:05.000Z");
const MANDATE_EXPIRES = "2026-08-11T05:30:00.000Z";
const NONCE = `0x${"ab".repeat(32)}`;

const temporaryDirs: string[] = [];
const servers: Server[] = [];

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b371-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
  while (temporaryDirs.length) {
    const dir = temporaryDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function requestBindingSha(): string {
  return createThinSettlementRequestBinding({
    endpoint: ENDPOINT,
    method: "GET",
    input_status: "known",
    query: QUERY.map(([k, v]) => [k, v] as [string, string]),
    body: null,
  }).binding_sha256;
}

function observation(): SellerRequirementsObservation {
  const selected = {
    scheme: "exact",
    network: "eip155:8453",
    asset: ASSET,
    amount: "1000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 3600,
    extra: { name: "USD Coin", version: "2" },
  };
  const envelope = {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: `${ENDPOINT}?network=ethereum`,
      description: "block number",
      mimeType: "application/json",
    },
    accepts: [selected],
  };
  return {
    requirements_observed_at: OBSERVED_AT,
    selected_requirements: selected,
    payment_required_envelope: envelope,
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
      resource: envelope.resource,
      extra: selected.extra,
      request_binding_sha256: requestBindingSha(),
      canonical_requirements_sha256: canonicalJsonSha256(selected),
      canonical_envelope_sha256: canonicalJsonSha256(envelope),
    },
  };
}

function writeAccessEnabledPolicy(dir: string): string {
  const path = join(dir, "credential_provider_policy.json");
  writeFileSync(
    path,
    `${JSON.stringify({
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
      effect: "b371 synthetic",
    })}\n`,
  );
  return path;
}

async function prepareSignedAttempt(dir: string) {
  const obs = observation();
  const rb = obs.binding.request_binding_sha256;
  const provisional = buildSyntheticHumanConditionalCredentialSigningMandate({
    decisionId: "b371-sign",
    endpoint: ENDPOINT,
    method: "GET",
    requestQuery: QUERY,
    requestBindingSha256: rb,
    sellerNetworkRaw: "eip155:8453",
    canonicalNetworkCaip2: "eip155:8453",
    asset: ASSET,
    payTo: PAY_TO,
    buyerWallet: BUYER,
    amountAtomic: "1000",
    canonicalRequirementsSha256: obs.binding.canonical_requirements_sha256,
    canonicalEnvelopeSha256: obs.binding.canonical_envelope_sha256,
    prepareAuthorizationSha256: "0".repeat(64),
    decidedAt: "2026-08-11T04:55:00.000Z",
    mandateExpiresAt: MANDATE_EXPIRES,
  });
  const prepareHash = canonicalJsonSha256(
    buildPrepareAuthorizationViewFromConditionalMandate(provisional),
  );
  const signingMandate = buildSyntheticHumanConditionalCredentialSigningMandate({
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
  });
  const derivation = deriveConditionalCredentialSigningArtifacts({
    directory: dir,
    runId: "run_b371",
    attemptId: "attempt_b371",
    mandate: signingMandate,
    freshObservation: obs,
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

  const sendMandate = buildSyntheticHumanConditionalPaymentSendMandate({
    decisionId: "b371-send",
    endpoint: ENDPOINT,
    method: "GET",
    requestQuery: QUERY,
    requestBindingSha256: rb,
    sellerNetworkRaw: "eip155:8453",
    canonicalNetworkCaip2: "eip155:8453",
    asset: ASSET,
    payTo: PAY_TO,
    buyerWallet: BUYER,
    amountAtomic: "1000",
    canonicalRequirementsSha256: obs.binding.canonical_requirements_sha256,
    canonicalEnvelopeSha256: obs.binding.canonical_envelope_sha256,
    decidedAt: "2026-08-11T04:55:00.000Z",
    mandateExpiresAt: MANDATE_EXPIRES,
  });

  const psaResult = await derivePaymentSendAuthorization({
    directory: dir,
    sendMandate,
    signingMandate,
    signingAuthorization: derivation.derived_signing_authorization,
    credentialAccessAuthorization: derivation.derived_credential_access_authorization,
    now: NOW,
  });

  const unsigned = JSON.parse(readFileSync(join(dir, UNSIGNED_ARTIFACT), "utf8"));
  const signed = JSON.parse(readFileSync(join(dir, SIGNED_ARTIFACT), "utf8"));

  return {
    obs,
    signingMandate,
    sendMandate,
    derivation,
    psa: psaResult.derived_payment_send_authorization,
    psaSha: psaResult.payment_send_authorization_sha256,
    unsigned,
    signed,
  };
}

async function startLoopback(): Promise<{
  url: string;
  requests: Array<{ method?: string; url?: string; hasPaymentHeader: boolean; headerName?: string }>;
}> {
  const requests: Array<{
    method?: string;
    url?: string;
    hasPaymentHeader: boolean;
    headerName?: string;
  }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    const names = Object.keys(req.headers);
    const paymentName = names.find(
      (n) => n.toLowerCase() === "payment-signature" || n.toLowerCase() === "x-payment",
    );
    requests.push({
      method: req.method,
      url: req.url,
      hasPaymentHeader: Boolean(paymentName),
      headerName: paymentName,
    });
    // Never echo payment header values.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, synthetic: true }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return { url: `http://127.0.0.1:${addr.port}/api/chain/block-number`, requests };
}

describe("B.3.7.1 structural guards", () => {
  it("send bridge cannot sign / key-held executor / availability≠authorization", () => {
    expect(() => assertProductiveSendBridgeCannotSign()).toThrow(
      GUARD_PRODUCTIVE_SEND_BRIDGE_CANNOT_SIGN,
    );
    expect(() => assertB37OperationalPaymentCannotUseKeyHeldLiveExecutor()).toThrow(
      GUARD_B37_OPERATIONAL_PAYMENT_CANNOT_USE_KEY_HELD_LIVE_EXECUTOR,
    );
    expect(() => assertSendImplementationAvailableIsNotAuthorization()).toThrow(
      GUARD_SEND_IMPLEMENTATION_AVAILABLE_NOT_AUTHORIZATION,
    );
  });

  it("productive sender module source forbids signing imports", () => {
    const src = readFileSync(
      join(process.cwd(), "tools/trustforge/buyer-productive-one-shot-payment-sender.ts"),
      "utf8",
    );
    const headerSrc = readFileSync(
      join(process.cwd(), "tools/trustforge/buyer-payment-header-from-signed-artifact.ts"),
      "utf8",
    );
    for (const text of [src, headerSrc]) {
      expect(text).not.toMatch(/privateKeyToAccount/);
      expect(text).not.toMatch(/signTypedData/);
      expect(text).not.toMatch(/wrapFetchWithPayment/);
      expect(text).not.toMatch(/createPaymentPayload/);
      expect(text).not.toMatch(/createWalletClient/);
    }
    expect(headerSrc).toMatch(/encodePaymentSignatureHeader/);
  });
});

describe("B.3.7.1 header from persisted signed artifact", () => {
  it("PAYMENT_HEADER_FROM_PERSISTED_SIGNED_ARTIFACT equivalence PASS", async () => {
    const dir = workDir();
    const prepared = await prepareSignedAttempt(dir);
    const payload = buildX402ExactPaymentPayloadFromPersistedArtifacts({
      unsignedArtifact: prepared.unsigned,
      signedArtifact: prepared.signed,
      sellerObservation: prepared.obs,
    });
    const viaBridge = encodeX402PaymentSignatureHeaderFromPayload(payload);
    const viaLib = encodePaymentSignatureHeader(payload as never);
    expect(viaBridge.header_name).toBe(X402_V2_PAYMENT_HEADER_NAME);
    expect(viaBridge.header_value).toBe(viaLib);
    expect(viaBridge.header_value_sha256).toBe(
      createHash("sha256").update(viaLib, "utf8").digest("hex"),
    );
    const evidence = sanitizeBuiltPaymentHeaderEvidence(viaBridge);
    expect(evidence.header_value).toBe(GUARD_NO_PAYMENT_HEADER_SECRET_LEAKAGE);
    expect(JSON.stringify(evidence)).not.toContain(viaBridge.header_value);
  });
});

function okTransport() {
  return createInjectedPaymentBearingHttpTransport(async () => ({
    kind: "response_observed",
    status: 200,
    redirected: false,
    body_text: "{}",
    observed_at: NOW.toISOString(),
  }));
}

describe("B.3.7.1 binding + temporal negatives", () => {
  it("blocks wrong amount / endpoint / expired validBefore", async () => {
    const dir = workDir();
    const prepared = await prepareSignedAttempt(dir);
    await expect(
      sendAuthorizedPaymentOnce({
        directory: dir,
        paymentSendAuthorization: { ...prepared.psa, amount_atomic: "1001" },
        unsignedArtifact: prepared.unsigned,
        signedArtifact: prepared.signed,
        sellerObservation: prepared.obs,
        now: NOW,
        persistArtifacts: false,
        transport: okTransport(),
      }),
    ).rejects.toThrow(BLOCKED_B371_PAYMENT_SEND_BINDING_MISMATCH);

    await expect(
      sendAuthorizedPaymentOnce({
        directory: dir,
        paymentSendAuthorization: {
          ...prepared.psa,
          endpoint: "https://evil.example/api",
        },
        unsignedArtifact: prepared.unsigned,
        signedArtifact: prepared.signed,
        sellerObservation: prepared.obs,
        now: NOW,
        persistArtifacts: false,
        transport: okTransport(),
      }),
    ).rejects.toThrow(BLOCKED_B371_PAYMENT_SEND_BINDING_MISMATCH);

    await expect(
      sendAuthorizedPaymentOnce({
        directory: dir,
        paymentSendAuthorization: prepared.psa,
        unsignedArtifact: prepared.unsigned,
        signedArtifact: prepared.signed,
        sellerObservation: prepared.obs,
        now: new Date("2099-01-01T00:00:00.000Z"),
        persistArtifacts: false,
        transport: okTransport(),
      }),
    ).rejects.toThrow(BLOCKED_B371_PAYMENT_SEND_AUTHORIZATION_EXPIRED);
  });

  it("blocks missing PSA / wrong buyer / asset / payTo / request-binding / signed hash", async () => {
    const dir = workDir();
    const prepared = await prepareSignedAttempt(dir);
    await expect(
      sendAuthorizedPaymentOnce({
        directory: dir,
        paymentSendAuthorization: null as never,
        unsignedArtifact: prepared.unsigned,
        signedArtifact: prepared.signed,
        sellerObservation: prepared.obs,
        now: NOW,
        persistArtifacts: false,
        transport: okTransport(),
      }),
    ).rejects.toThrow(/BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_MISSING|exact derived/);

    for (const [label, psaPatch] of [
      ["buyer", { buyer_wallet: "0x0000000000000000000000000000000000000001" }],
      ["asset", { asset: "0x0000000000000000000000000000000000000002" }],
      ["payTo", { pay_to: "0x0000000000000000000000000000000000000003" }],
      ["request_binding", { request_binding_sha256: "ff".repeat(32) }],
      ["signed_hash", { signed_artifact_sha256: "aa".repeat(32) }],
    ] as const) {
      await expect(
        sendAuthorizedPaymentOnce({
          directory: dir,
          paymentSendAuthorization: { ...prepared.psa, ...psaPatch },
          unsignedArtifact: prepared.unsigned,
          signedArtifact: prepared.signed,
          sellerObservation: prepared.obs,
          now: NOW,
          persistArtifacts: false,
          transport: okTransport(),
        }),
        label,
      ).rejects.toThrow(BLOCKED_B371_PAYMENT_SEND_BINDING_MISMATCH);
    }
  });

  it("crash after SEND_COMMITTED is terminal ambiguous; no resend", async () => {
    const dir = workDir();
    const prepared = await prepareSignedAttempt(dir);
    const ledger = new BuyerPaymentSendLedger();
    const psaSha = paymentSendAuthorizationSha256(prepared.psa);
    ledger.issueDerived({
      sendAuthorizationSha256: psaSha,
      sendMandateSha256: prepared.psa.parent_human_conditional_payment_send_mandate_sha256,
      attemptId: prepared.psa.attempt_id,
      now: NOW,
    });
    ledger.markValidatedCurrent({ sendAuthorizationSha256: psaSha, now: NOW });
    ledger.commitNoRetry({
      sendAuthorizationSha256: psaSha,
      now: NOW,
      signedArtifactSha256: prepared.psa.signed_artifact_sha256,
      requestBindingSha256: prepared.psa.request_binding_sha256,
    });
    const crash = evaluatePaymentSendCrashRecovery({ record: ledger.get(psaSha)! });
    expect(crash.disposition).toBe(AMBIGUOUS_SEND_TERMINAL_RECONCILE);
    expect(crash.may_resend).toBe(false);
    await expect(
      sendAuthorizedPaymentOnce({
        directory: dir,
        paymentSendAuthorization: prepared.psa,
        unsignedArtifact: prepared.unsigned,
        signedArtifact: prepared.signed,
        sellerObservation: prepared.obs,
        now: NOW,
        ledger,
        persistArtifacts: false,
        transport: okTransport(),
      }),
    ).rejects.toThrow(/GUARD_NO_RESEND_AFTER_SEND_COMMIT/);
    expect(ledger.get(psaSha)!.state).toBe("AMBIGUOUS_SEND_TERMINAL_RECONCILE");
  });
});

describe("B.3.7.1 commit / one-shot / ambiguity", () => {
  it("SEND_COMMITTED_NO_RETRY then one request; second blocked", async () => {
    const dir = workDir();
    const prepared = await prepareSignedAttempt(dir);
    const ledger = new BuyerPaymentSendLedger();
    let calls = 0;
    const transport = createInjectedPaymentBearingHttpTransport(async (req) => {
      calls += 1;
      expect(req.headers[X402_V2_PAYMENT_HEADER_NAME]).toBeTruthy();
      expect(req.method).toBe("GET");
      return {
        kind: "response_observed",
        status: 200,
        redirected: false,
        body_text: '{"ok":true}',
        observed_at: NOW.toISOString(),
      };
    });
    const first = await sendAuthorizedPaymentOnce({
      directory: dir,
      paymentSendAuthorization: prepared.psa,
      unsignedArtifact: prepared.unsigned,
      signedArtifact: prepared.signed,
      sellerObservation: prepared.obs,
      now: NOW,
      ledger,
      transport,
      persistArtifacts: false,
    });
    expect(first.payment_bearing_request_invocations).toBe(1);
    expect(calls).toBe(1);
    expect(first.lifecycle.state).toBe("RESPONSE_OBSERVED");
    expect(first.classification).toBe("RESPONSE_OBSERVED_SUCCESS");

    await expect(
      sendAuthorizedPaymentOnce({
        directory: dir,
        paymentSendAuthorization: prepared.psa,
        unsignedArtifact: prepared.unsigned,
        signedArtifact: prepared.signed,
        sellerObservation: prepared.obs,
        now: NOW,
        ledger,
        transport,
        persistArtifacts: false,
      }),
    ).rejects.toThrow(BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST);
    expect(calls).toBe(1);
  });

  it("timeout → AMBIGUOUS_SEND_TERMINAL_RECONCILE; no resend", async () => {
    const dir = workDir();
    const prepared = await prepareSignedAttempt(dir);
    const ledger = new BuyerPaymentSendLedger();
    const transport = createInjectedPaymentBearingHttpTransport(async () => ({
      kind: "ambiguous",
      reason: "timeout",
      detail: "synthetic timeout",
      disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE,
    }));
    const result = await sendAuthorizedPaymentOnce({
      directory: dir,
      paymentSendAuthorization: prepared.psa,
      unsignedArtifact: prepared.unsigned,
      signedArtifact: prepared.signed,
      sellerObservation: prepared.obs,
      now: NOW,
      ledger,
      transport,
      persistArtifacts: false,
    });
    expect(result.classification).toBe(AMBIGUOUS_SEND_TERMINAL_RECONCILE);
    expect(result.lifecycle.state).toBe("AMBIGUOUS_SEND_TERMINAL_RECONCILE");
    await expect(
      sendAuthorizedPaymentOnce({
        directory: dir,
        paymentSendAuthorization: prepared.psa,
        unsignedArtifact: prepared.unsigned,
        signedArtifact: prepared.signed,
        sellerObservation: prepared.obs,
        now: NOW,
        ledger,
        transport,
        persistArtifacts: false,
      }),
    ).rejects.toThrow(/GUARD_NO_RESEND|BLOCKED_B37|AMBIGUOUS/);
  });

  it("redirect fail-closed", async () => {
    const dir = workDir();
    const prepared = await prepareSignedAttempt(dir);
    const transport = createInjectedPaymentBearingHttpTransport(async () => ({
      kind: "ambiguous",
      reason: "redirect",
      detail: "BLOCKED_B371_REDIRECT_NOT_ALLOWED: status 302",
      disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE,
    }));
    const result = await sendAuthorizedPaymentOnce({
      directory: dir,
      paymentSendAuthorization: prepared.psa,
      unsignedArtifact: prepared.unsigned,
      signedArtifact: prepared.signed,
      sellerObservation: prepared.obs,
      now: NOW,
      transport,
      persistArtifacts: false,
    });
    expect(result.classification).toBe(AMBIGUOUS_SEND_TERMINAL_RECONCILE);
  });
});

describe("B.3.7.1 loopback productive transport", () => {
  it("real fetch bridge hits loopback exactly once with payment header", async () => {
    const loop = await startLoopback();
    const dir = workDir();

    // Full canary economics on loopback host so the productive bridge itself
    // performs the real fetch (no URL rewrite after authorization).
    const loopEndpoint = loop.url.replace(/\?.*$/, "");
    const rb = createThinSettlementRequestBinding({
      endpoint: loopEndpoint,
      method: "GET",
      input_status: "known",
      query: QUERY.map(([k, v]) => [k, v] as [string, string]),
      body: null,
    }).binding_sha256;
    const selected = {
      scheme: "exact",
      network: "eip155:8453",
      asset: ASSET,
      amount: "1000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 3600,
      extra: { name: "USD Coin", version: "2" },
    };
    const envelope = {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: `${loopEndpoint}?network=ethereum`,
        description: "loopback synthetic",
        mimeType: "application/json",
      },
      accepts: [selected],
    };
    const obs: SellerRequirementsObservation = {
      requirements_observed_at: OBSERVED_AT,
      selected_requirements: selected,
      payment_required_envelope: envelope,
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
        resource: envelope.resource,
        extra: selected.extra,
        request_binding_sha256: rb,
        canonical_requirements_sha256: canonicalJsonSha256(selected),
        canonical_envelope_sha256: canonicalJsonSha256(envelope),
      },
    };

    const provisional = buildSyntheticHumanConditionalCredentialSigningMandate({
      decisionId: "b371-loop-sign",
      endpoint: loopEndpoint,
      method: "GET",
      requestQuery: QUERY,
      requestBindingSha256: rb,
      sellerNetworkRaw: "eip155:8453",
      canonicalNetworkCaip2: "eip155:8453",
      asset: ASSET,
      payTo: PAY_TO,
      buyerWallet: BUYER,
      amountAtomic: "1000",
      canonicalRequirementsSha256: obs.binding.canonical_requirements_sha256,
      canonicalEnvelopeSha256: obs.binding.canonical_envelope_sha256,
      prepareAuthorizationSha256: "0".repeat(64),
      decidedAt: "2026-08-11T04:55:00.000Z",
      mandateExpiresAt: MANDATE_EXPIRES,
    });
    const prepareHash = canonicalJsonSha256(
      buildPrepareAuthorizationViewFromConditionalMandate(provisional),
    );
    const signingMandate = buildSyntheticHumanConditionalCredentialSigningMandate({
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
    });
    const derivation = deriveConditionalCredentialSigningArtifacts({
      directory: dir,
      runId: "run_b371_loop",
      attemptId: "attempt_b371_loop",
      mandate: signingMandate,
      freshObservation: obs,
      now: NOW,
      nonceSource: () => `0x${"cd".repeat(32)}`,
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
    const sendMandate = buildSyntheticHumanConditionalPaymentSendMandate({
      decisionId: "b371-loop-send",
      endpoint: loopEndpoint,
      method: "GET",
      requestQuery: QUERY,
      requestBindingSha256: rb,
      sellerNetworkRaw: "eip155:8453",
      canonicalNetworkCaip2: "eip155:8453",
      asset: ASSET,
      payTo: PAY_TO,
      buyerWallet: BUYER,
      amountAtomic: "1000",
      canonicalRequirementsSha256: obs.binding.canonical_requirements_sha256,
      canonicalEnvelopeSha256: obs.binding.canonical_envelope_sha256,
      decidedAt: "2026-08-11T04:55:00.000Z",
      mandateExpiresAt: MANDATE_EXPIRES,
    });
    const psaResult = await derivePaymentSendAuthorization({
      directory: dir,
      sendMandate,
      signingMandate,
      signingAuthorization: derivation.derived_signing_authorization,
      credentialAccessAuthorization: derivation.derived_credential_access_authorization,
      now: NOW,
    });
    const unsigned = JSON.parse(readFileSync(join(dir, UNSIGNED_ARTIFACT), "utf8"));
    const signed = JSON.parse(readFileSync(join(dir, SIGNED_ARTIFACT), "utf8"));

    const transport = createFetchPaymentBearingHttpTransport({ timeoutMs: 5000 });
    const result = await sendAuthorizedPaymentOnce({
      directory: dir,
      paymentSendAuthorization: psaResult.derived_payment_send_authorization,
      unsignedArtifact: unsigned,
      signedArtifact: signed,
      sellerObservation: obs,
      now: NOW,
      transport,
      persistArtifacts: false,
    });

    expect(result.classification).toBe("RESPONSE_OBSERVED_SUCCESS");
    expect(transport.invocationCount).toBe(1);
    expect(loop.requests).toHaveLength(1);
    expect(loop.requests[0]!.method).toBe("GET");
    expect(loop.requests[0]!.hasPaymentHeader).toBe(true);
    expect(loop.requests[0]!.url).toContain("network=ethereum");

    await expect(
      sendAuthorizedPaymentOnce({
        directory: dir,
        paymentSendAuthorization: psaResult.derived_payment_send_authorization,
        unsignedArtifact: unsigned,
        signedArtifact: signed,
        sellerObservation: obs,
        now: NOW,
        transport,
        persistArtifacts: false,
      }),
    ).rejects.toThrow(BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST);
    expect(loop.requests).toHaveLength(1);
  });
});

describe("B.3.7.1 signed hash convention", () => {
  it("PSA signed hash matches write-once file bytes", async () => {
    const dir = workDir();
    const prepared = await prepareSignedAttempt(dir);
    const fileSha = createHash("sha256")
      .update(readFileSync(join(dir, SIGNED_ARTIFACT)))
      .digest("hex");
    expect(prepared.psa.signed_artifact_sha256).toBe(fileSha);
    expect(sha256WriteOnceBody(prepared.signed)).toBe(fileSha);
  });
});
