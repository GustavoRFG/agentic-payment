/**
 * B.4 unified mainnet operationalization — offline / loopback only.
 * NO REAL KEY. NO REAL MAINNET PAYMENT.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BLOCKED_B4_HUMAN_REJECTED,
  BLOCKED_B4_SIGNER_SETUP_ADDRESS_MISMATCH,
  GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_ENV,
  GUARD_THIN_RUNNER_CANNOT_RETRY_SEND,
  B4_PROTECTED_SIGNER_CREDENTIAL_KIND,
  B4_PROTECTED_SIGNER_PROVIDER_ID,
  B4_PROTECTED_VAULT_SECRET_ENTRY,
} from "../../tools/trustforge/b4-execution-gates";
import {
  privateKeyAsciiToCredentialBytes,
  createSyntheticWindowsMaskedSecretDialog,
} from "../../tools/trustforge/buyer-windows-masked-secret-dialog";
import {
  decryptProtectedSignerVault,
  loadProtectedSignerVault,
  writeProtectedSignerVault,
} from "../../tools/trustforge/buyer-protected-signer-vault";
import { runSecureSignerSetup } from "../../tools/trustforge/buyer-secure-signer-setup";
import { createWindowsDpapiLocalSignerProvider } from "../../tools/trustforge/windows-dpapi-local-signer";
import { createSyntheticXorProtectedSecretBackend } from "../../tools/trustforge/windows-dpapi-protect";
import {
  createTestHumanPaymentDecisionProvider,
} from "../../tools/trustforge/human-payment-decision-provider";
import {
  FIRST_REAL_MAINNET_PAYMENT_V1,
  GOLDEN_TRACE_STATUS_CONFIRMED,
  compareRunnerAgainstGoldenTrace,
} from "../../tools/trustforge/first-mainnet-payment-golden-trace";
import {
  createRunnerState,
  evaluateRunnerCrashRecovery,
  persistRunnerState,
  transitionRunnerState,
} from "../../tools/trustforge/thin-mainnet-runner-state";
import { runThinMainnetPayment } from "../../tools/trustforge/thin-mainnet-payment-runner";
import { createFetchPaymentBearingHttpTransport } from "../../tools/trustforge/buyer-payment-bearing-http-transport";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";
import {
  canonicalJsonSha256,
  type SellerRequirementsObservation,
} from "../../tools/trustforge/x402-seller-requirements-binding";
import type { DiscoveredSelectedCandidate } from "../../tools/trustforge/discovered-target-to-selected-candidate";
import {
  SYNTHETIC_B33_RUNTIME_ADDRESS,
  SYNTHETIC_B33_RUNTIME_KEY,
  SYNTHETIC_B33_WRONG_RUNTIME_KEY,
} from "../support/trustforge-synthetic-runtime-key";

const BUYER = SYNTHETIC_B33_RUNTIME_ADDRESS;
const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = new Date("2026-08-12T05:00:05.000Z");
const OBSERVED_AT = "2026-08-12T05:00:00.000Z";
const NONCE = `0x${"cd".repeat(32)}` as `0x${string}`;

const temporaryDirs: string[] = [];
const servers: Server[] = [];

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b4-"));
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
  delete process.env.BUYER_PRIVATE_KEY;
  delete process.env.SEPOLIA_BUYER_PRIVATE_KEY;
});

function observationFor(endpoint: string): SellerRequirementsObservation {
  const binding = createThinSettlementRequestBinding({
    endpoint,
    method: "GET",
    input_status: "known",
    query: [["network", "ethereum"]],
    body: null,
  });
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
      url: `${endpoint}?network=ethereum`,
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
      request_binding_sha256: binding.binding_sha256,
      canonical_requirements_sha256: canonicalJsonSha256(selected),
      canonical_envelope_sha256: canonicalJsonSha256(envelope),
    },
  };
}

function selectedCandidate(endpoint: string): DiscoveredSelectedCandidate {
  const obs = observationFor(endpoint);
  return {
    schema_version: "trustforge_selected_candidate.v3",
    provider: "discovered_x402",
    service_id: "api_onesource_io_api_chain_block_number",
    endpoint,
    method: "GET",
    request_input_status: "known",
    request_query: [["network", "ethereum"]],
    request_body: null,
    request_input_provenance: "policy_generated_request_binding",
    request_binding_sha256: obs.binding.request_binding_sha256,
    protocol_version: 2,
    transport: "payment-required-header",
    scheme: "exact",
    amount_field: "amount",
    max_timeout_seconds: 3600,
    resource: obs.binding.resource,
    extra: obs.binding.extra,
    canonical_requirements_sha256: obs.binding.canonical_requirements_sha256,
    canonical_envelope_sha256: obs.binding.canonical_envelope_sha256,
    selection_requirements_observed_at: OBSERVED_AT,
    ancillary_tempo_evidence: null,
    seller_requirements: obs,
    quote_amount_usdc: "0.001",
    quote_atomic: "1000",
    authorized_pay_to: PAY_TO,
    recommended_max_usdc: "0.001",
    seller_network_raw: "eip155:8453",
    canonical_network_caip2: "eip155:8453",
    network: "eip155:8453",
    asset: ASSET,
    buyer_wallet: BUYER,
    target_selection_audit: {
      selected_resource_url: endpoint,
      handshake_status: "live_402_ok",
      fallback_resource_urls: [],
      scoring_rationale: ["b4_synthetic"],
    },
    selected_at_utc: OBSERVED_AT,
  };
}

function writeDpapiAccessPolicy(dir: string): string {
  const path = join(dir, "credential_provider_policy.json");
  writeFileSync(
    path,
    `${JSON.stringify({
      schema_version: "trustforge_buyer_credential_provider_policy.v2",
      credential_provider_configured: true,
      allowed_provider_ids: [
        "explicit-runtime-key",
        B4_PROTECTED_SIGNER_PROVIDER_ID,
      ],
      selected_productive_provider_id: B4_PROTECTED_SIGNER_PROVIDER_ID,
      provider_id: B4_PROTECTED_SIGNER_PROVIDER_ID,
      credential_kind: B4_PROTECTED_SIGNER_CREDENTIAL_KIND,
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
      effect: "b4 synthetic dpapi",
    })}\n`,
  );
  return path;
}

async function startLoopback(): Promise<{ url: string; requests: number }> {
  const state = { requests: 0 };
  const server = createServer((req: IncomingMessage, res) => {
    state.requests += 1;
    const hasPayment = Object.keys(req.headers).some(
      (n) =>
        n.toLowerCase() === "payment-signature" || n.toLowerCase() === "x-payment",
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, synthetic: true, paid: hasPayment }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    url: `http://127.0.0.1:${addr.port}/api/chain/block-number`,
    get requests() {
      return state.requests;
    },
  };
}

function writeVault(dir: string, keyHex: string, expected: string) {
  const backend = createSyntheticXorProtectedSecretBackend();
  const path = join(dir, `buyer-${expected.toLowerCase()}.vault.json`);
  writeProtectedSignerVault({
    path,
    expectedPublicAddress: expected,
    plaintextKey: privateKeyAsciiToCredentialBytes(keyHex),
    backend,
    now: NOW,
  });
  return { path, backend };
}

describe("B.4 golden trace", () => {
  it("CONFIRMED + structural compare", () => {
    expect(FIRST_REAL_MAINNET_PAYMENT_V1.GOLDEN_TRACE_STATUS).toBe(
      GOLDEN_TRACE_STATUS_CONFIRMED,
    );
    const cmp = compareRunnerAgainstGoldenTrace({
      signatures: 1,
      payment_bearing_requests: 1,
      retry: 0,
      resend: 0,
      authority_sequence: [
        ...FIRST_REAL_MAINNET_PAYMENT_V1.authority_sequence,
      ],
      post_sign_audit_pass: true,
      send_committed: true,
    });
    expect(cmp.ok).toBe(true);
    expect(cmp.mismatches).toEqual([]);
  });
});

describe("B.4 runner state machine", () => {
  it("transitions and crash recovery commit → ambiguous", () => {
    const dir = workDir();
    let record = createRunnerState("run_b4", NOW);
    record = transitionRunnerState(record, "CANDIDATE_READY", NOW);
    record = transitionRunnerState(record, "HUMAN_DECISION_PENDING", NOW);
    record = transitionRunnerState(record, "HUMAN_APPROVED", NOW, {
      human_decision_id: "dec_1",
    });
    persistRunnerState(dir, record);
    expect(evaluateRunnerCrashRecovery({ record }).disposition).toBe("CLEAN_CONTINUE");

    // Fast-forward to send commit.
    const steps = [
      "FRESH_REQUIREMENTS_VALIDATED",
      "ATTEMPT_RESERVED",
      "UNSIGNED_PERSISTED",
      "SIGNING_AUTH_DERIVED",
      "CREDENTIAL_AUTH_DERIVED",
      "SIGNED_PERSISTED",
      "POST_SIGN_AUDIT_PASS",
      "PAYMENT_SEND_AUTH_DERIVED",
      "SEND_COMMITTED_NO_RETRY",
    ] as const;
    for (const s of steps) {
      record = transitionRunnerState(record, s, NOW);
    }
    persistRunnerState(dir, record);
    const crash = evaluateRunnerCrashRecovery({ record });
    expect(crash.disposition).toBe("AMBIGUOUS_RECONCILE_ONLY");
    expect(crash.may_retry_send).toBe(false);
    expect(crash.may_resign).toBe(false);
  });
});

describe("B.4 synthetic vault setup", () => {
  it("wrong address / valid / decrypt", async () => {
    const dir = workDir();
    const backend = createSyntheticXorProtectedSecretBackend();
    const wrongDialog = createSyntheticWindowsMaskedSecretDialog({
      credentialAscii: SYNTHETIC_B33_WRONG_RUNTIME_KEY,
    });
    await expect(
      runSecureSignerSetup({
        expectedWallet: BUYER,
        dialog: wrongDialog,
        backend,
        vaultBaseDir: dir,
        now: NOW,
      }),
    ).rejects.toThrow(BLOCKED_B4_SIGNER_SETUP_ADDRESS_MISMATCH);

    const okDialog = createSyntheticWindowsMaskedSecretDialog({
      credentialAscii: SYNTHETIC_B33_RUNTIME_KEY,
    });
    const setup = await runSecureSignerSetup({
      expectedWallet: BUYER,
      dialog: okDialog,
      backend,
      vaultBaseDir: dir,
      now: NOW,
    });
    expect(setup.vault_ready).toBe(true);
    expect(setup.plaintext_persisted).toBe(false);
    expect(setup.derived_signer_match).toBe(true);

    const loaded = loadProtectedSignerVault(setup.vault_path);
    const plain = decryptProtectedSignerVault({ record: loaded, backend });
    expect(plain.length).toBe(32);
    expect(Buffer.from(plain).equals(Buffer.from(privateKeyAsciiToCredentialBytes(SYNTHETIC_B33_RUNTIME_KEY)))).toBe(
      true,
    );
  });
});

describe("B.4 human decision → mandates", () => {
  it("Approve → mandate pair sharing human_decision_id", async () => {
    const dir = workDir();
    const vaultDir = workDir();
    const { backend } = writeVault(vaultDir, SYNTHETIC_B33_RUNTIME_KEY, BUYER);
    const loop = await startLoopback();
    const selected = selectedCandidate(loop.url);
    const obs = observationFor(loop.url);
    const decisionId = "paydec_approve_shared";

    const result = await runThinMainnetPayment({
      directory: dir,
      selected,
      decisionProvider: createTestHumanPaymentDecisionProvider({
        decision: "APPROVE",
        decision_source: "approve_button",
        explicit_human_decision: true,
        human_decision_id: decisionId,
        decided_at: "2026-08-12T04:55:00.000Z",
        provider_id: "injected-test-decision",
        policy: "manual-approve-reject",
      }),
      credentialProvider: createWindowsDpapiLocalSignerProvider({
        vaultBaseDir: vaultDir,
        backend,
      }),
      freshObservation: obs,
      now: NOW,
      nowAtSign: NOW,
      credentialPolicyPath: writeDpapiAccessPolicy(dir),
      transport: createFetchPaymentBearingHttpTransport(),
      skipOnchainVerify: true,
      nonceSource: () => NONCE,
      mandateTtlMs: 1_800_000,
    });

    expect(result.decision).toBe("APPROVE");
    expect(result.signing_mandate?.decision_id).toBe(decisionId);
    expect(result.send_mandate?.decision_id).toBe(decisionId);
    expect(result.signing_mandate?.credential_provider_id).toBe(
      B4_PROTECTED_SIGNER_PROVIDER_ID,
    );
    expect(result.signing_mandate?.secret_entry_mechanism).toBe(
      B4_PROTECTED_VAULT_SECRET_ENTRY,
    );
    expect(result.golden_compare?.ok).toBe(true);
    expect(result.state.state).toBe("CONFIRMED");
    // B.4.2 closeout durability: response + closeout persisted before return.
    expect(existsSync(join(dir, "payment_http_response_sanitized.json"))).toBe(true);
    expect(existsSync(join(dir, "facilitator_receipt_sanitized.json"))).toBe(true);
    expect(existsSync(join(dir, "thin_mainnet_closeout.json"))).toBe(true);
    const closeout = JSON.parse(
      readFileSync(join(dir, "thin_mainnet_closeout.json"), "utf8"),
    ) as { payment_bearing_requests: number; retry: number; resend: number };
    expect(closeout.payment_bearing_requests).toBe(1);
    expect(closeout.retry).toBe(0);
    expect(closeout.resend).toBe(0);
  });

  it("Reject → no signer / HUMAN_REJECTED", async () => {
    const dir = workDir();
    const selected = selectedCandidate("https://api.onesource.io/api/chain/block-number");
    await expect(
      runThinMainnetPayment({
        directory: dir,
        selected,
        decisionProvider: createTestHumanPaymentDecisionProvider({
          decision: "REJECT",
          decision_source: "reject_button",
          explicit_human_decision: true,
          human_decision_id: "paydec_reject",
          decided_at: "2026-08-12T04:55:00.000Z",
          provider_id: "injected-test-decision",
          policy: "manual-approve-reject",
        }),
        credentialProvider: createWindowsDpapiLocalSignerProvider({
          vaultBaseDir: dir,
          backend: createSyntheticXorProtectedSecretBackend(),
        }),
        now: NOW,
        skipOnchainVerify: true,
      }),
    ).rejects.toThrow(BLOCKED_B4_HUMAN_REJECTED);

    const { loadRunnerState } = await import(
      "../../tools/trustforge/thin-mainnet-runner-state"
    );
    const state = loadRunnerState(dir);
    expect(state?.state).toBe("HUMAN_REJECTED");
  });
});

describe("B.4 loopback E2E thin runner", () => {
  it("synthetic xor vault + injected approve + local http + send path", async () => {
    const dir = workDir();
    const vaultDir = workDir();
    const { backend } = writeVault(vaultDir, SYNTHETIC_B33_RUNTIME_KEY, BUYER);
    const loop = await startLoopback();
    const selected = selectedCandidate(loop.url);
    const obs = observationFor(loop.url);

    const result = await runThinMainnetPayment({
      directory: dir,
      selected,
      decisionProvider: createTestHumanPaymentDecisionProvider({
        decision: "APPROVE",
        decision_source: "approve_button",
        explicit_human_decision: true,
        human_decision_id: "paydec_loopback",
        decided_at: "2026-08-12T04:55:00.000Z",
        provider_id: "injected-test-decision",
        policy: "manual-approve-reject",
      }),
      credentialProvider: createWindowsDpapiLocalSignerProvider({
        vaultBaseDir: vaultDir,
        backend,
      }),
      freshObservation: obs,
      now: NOW,
      credentialPolicyPath: writeDpapiAccessPolicy(dir),
      transport: createFetchPaymentBearingHttpTransport(),
      skipOnchainVerify: true,
      nonceSource: () => NONCE,
      mandateTtlMs: 1_800_000,
    });

    expect(result.signatures).toBe(1);
    expect(result.payment_bearing_requests).toBe(1);
    expect(result.retry).toBe(0);
    expect(result.resend).toBe(0);
    expect(result.http_status).toBe(200);
    expect(loop.requests).toBe(1);
    expect(result.authority_sequence).toContain("PaymentSendAuthorization");
    expect(result.authority_sequence).toContain("SEND_COMMITTED_NO_RETRY");
    expect(result.authority_sequence).toContain("B371_productive_one_shot_send");
    expect(result.golden_compare?.ok).toBe(true);

    // Restart after send-commit must not retry.
    persistRunnerState(dir, {
      ...result.state,
      state: "SEND_COMMITTED_NO_RETRY",
    });
    await expect(
      runThinMainnetPayment({
        directory: dir,
        selected,
        decisionProvider: createTestHumanPaymentDecisionProvider({
          decision: "APPROVE",
          decision_source: "approve_button",
          explicit_human_decision: true,
          human_decision_id: "paydec_retry",
          decided_at: "2026-08-12T04:55:00.000Z",
          provider_id: "injected-test-decision",
          policy: "manual-approve-reject",
        }),
        credentialProvider: createWindowsDpapiLocalSignerProvider({
          vaultBaseDir: vaultDir,
          backend,
        }),
        freshObservation: obs,
        now: NOW,
        credentialPolicyPath: writeDpapiAccessPolicy(dir),
        skipOnchainVerify: true,
      }),
    ).rejects.toThrow(GUARD_THIN_RUNNER_CANNOT_RETRY_SEND);
  });
});

describe("B.4 DPAPI env fallback guard", () => {
  it("refuses env fallback when BUYER_PRIVATE_KEY set", async () => {
    const dir = workDir();
    const { backend, path } = writeVault(dir, SYNTHETIC_B33_RUNTIME_KEY, BUYER);
    const provider = createWindowsDpapiLocalSignerProvider({
      vaultBaseDir: dir,
      backend,
      vaultPathOverride: path,
    });

    const saved = process.env.BUYER_PRIVATE_KEY;
    process.env.BUYER_PRIVATE_KEY = SYNTHETIC_B33_RUNTIME_KEY;
    try {
      await expect(
        provider.acquireSigner({
          __brand: "AuthorizedCredentialAccessRequest",
          accessAuthorization: {
            authorization_schema_version:
              "trustforge_buyer_credential_access_authorization.v1",
            decision: "authorize_one_credential_access",
            decision_id: "cred_env",
            signing_authorization_sha256: "a".repeat(64),
            unsigned_artifact_sha256: "b".repeat(64),
            attempt_id: "a1",
            run_id: "r1",
            provider_id: B4_PROTECTED_SIGNER_PROVIDER_ID,
            credential_kind: B4_PROTECTED_SIGNER_CREDENTIAL_KIND,
            expected_signer_address: BUYER,
            access_expires_at: "2099-01-01T00:00:00.000Z",
            max_credential_acquisitions: 1,
            max_signatures: 1,
            allow_fallback: false,
            allow_resign: false,
            prepare_authorized: true,
            real_signing_authorized: true,
            credential_access_authorized: true,
            payment_bearing_send_authorized: false,
            settlement_authorized: false,
          },
          accessAuthorizationSha256: "c".repeat(64),
          context: {
            expectedSignerAddress: BUYER as `0x${string}`,
            attemptId: "a1",
            runId: "r1",
            unsignedArtifactSha256: "b".repeat(64),
            signingAuthorizationSha256: "a".repeat(64),
          },
          validated: {} as never,
        }),
      ).rejects.toThrow(GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_ENV);
    } finally {
      if (saved === undefined) delete process.env.BUYER_PRIVATE_KEY;
      else process.env.BUYER_PRIVATE_KEY = saved;
    }
  });
});
