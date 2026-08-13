/**
 * B.5 productive payment generalization — synthetic / loopback only.
 * NO REAL SIGNER. NO REAL PAYMENT.
 */

import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  GUARD_B5_CANNOT_CREATE_PSA_DIRECTLY,
  GUARD_B5_CANNOT_SEND,
  GUARD_B5_CANNOT_SIGN,
  GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT,
  GUARD_SELECTION_CANNOT_DRIFT_AFTER_HUMAN_APPROVAL,
} from "../../tools/trustforge/b5-execution-gates";
import { runB5CandidatePipeline } from "../../tools/trustforge/b5-candidate-pipeline";
import { runThinMainnetPaymentFromB5Selection } from "../../tools/trustforge/b5-run-thin-mainnet-from-selection";
import {
  selectedPaymentCandidateToDiscovered,
} from "../../tools/trustforge/b5-selected-candidate-bridge";
import { createFetchPaymentBearingHttpTransport } from "../../tools/trustforge/buyer-payment-bearing-http-transport";
import {
  writeProtectedSignerVault,
} from "../../tools/trustforge/buyer-protected-signer-vault";
import {
  privateKeyAsciiToCredentialBytes,
} from "../../tools/trustforge/buyer-windows-masked-secret-dialog";
import { createTestHumanPaymentDecisionProvider } from "../../tools/trustforge/human-payment-decision-provider";
import {
  createDiscoveredSelectedCandidateDiscovery,
  createStaticFixtureDiscovery,
} from "../../tools/trustforge/payment-candidate-discovery";
import { normalizeFromDiscoveredSelectedCandidate } from "../../tools/trustforge/payment-candidate-normalize";
import {
  evaluatePaymentCandidatePolicy,
  loadB5CandidatePolicy,
} from "../../tools/trustforge/payment-candidate-policy";
import { selectPaymentCandidate } from "../../tools/trustforge/payment-candidate-selection";
import {
  buildPaymentCandidateIdentityTuple,
  paymentCandidateIdentitySha256,
} from "../../tools/trustforge/payment-candidate-v1";
import { createWindowsDpapiLocalSignerProvider } from "../../tools/trustforge/windows-dpapi-local-signer";
import { createSyntheticXorProtectedSecretBackend } from "../../tools/trustforge/windows-dpapi-protect";
import {
  SYNTHETIC_ALT_ENDPOINT,
  SYNTHETIC_ONESOURCE_ENDPOINT,
  SYNTHETIC_PAY_TO_B,
  syntheticObservation,
} from "../support/trustforge-b5-synthetic-candidates";
import {
  SYNTHETIC_B33_RUNTIME_ADDRESS,
  SYNTHETIC_B33_RUNTIME_KEY,
} from "../support/trustforge-synthetic-runtime-key";

const NOW = new Date("2026-08-13T04:00:05.000Z");
const temporaryDirs: string[] = [];
const servers: Server[] = [];

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b5-"));
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

function writeDpapiAccessPolicy(dir: string): string {
  const path = join(dir, "credential_provider_policy.operational.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schema_version: "trustforge_buyer_credential_provider_policy.v2",
        credential_provider_configured: true,
        allowed_provider_ids: ["windows-dpapi-local-signer"],
        selected_productive_provider_id: "windows-dpapi-local-signer",
        provider_id: "windows-dpapi-local-signer",
        credential_kind: "windows_dpapi_protected_private_key",
        adapter_installed: true,
        transport_adapter_installed: true,
        secret_entry_adapter_installed: true,
        expected_signer_address: SYNTHETIC_B33_RUNTIME_ADDRESS,
        credential_access_enabled: true,
        real_backend_activation: false,
        credential_caching_enabled: false,
        automatic_discovery_enabled: false,
        fallback_provider_enabled: false,
        real_signing_enabled: false,
        payment_bearing_send_enabled: false,
        settlement_enabled: false,
        retry_enabled: false,
        effect: "B5 loopback synthetic",
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

describe("B.5 PaymentCandidate contract + identity", () => {
  it("distinct economics / request produce distinct candidate_id", () => {
    const a = syntheticObservation({
      endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
      service_id: "api_onesource_io_api_chain_block_number",
      amount_atomic: "1000",
      purpose: "block_number",
    });
    const b = syntheticObservation({
      endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
      service_id: "api_onesource_io_api_chain_block_number",
      amount_atomic: "2000",
      purpose: "block_number",
    });
    const c = syntheticObservation({
      endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
      service_id: "api_onesource_io_api_chain_block_number",
      amount_atomic: "1000",
      query: [["network", "base"]],
      purpose: "block_number",
    });
    const na = normalizeFromDiscoveredSelectedCandidate(a.selected!);
    const nb = normalizeFromDiscoveredSelectedCandidate(b.selected!);
    const nc = normalizeFromDiscoveredSelectedCandidate(c.selected!);
    expect(na.candidate_id).not.toBe(nb.candidate_id);
    expect(na.candidate_id).not.toBe(nc.candidate_id);
    // Same identity across re-observation timestamps
    const na2 = normalizeFromDiscoveredSelectedCandidate(a.selected!, {
      discovered_at: "2026-08-14T00:00:00.000Z",
    });
    expect(na2.candidate_id).toBe(na.candidate_id);
    expect(na2.observation_id).not.toBe(na.observation_id);
  });

  it("identity hash is deterministic for tuple", () => {
    const t = buildPaymentCandidateIdentityTuple({
      provider_id: "P",
      service_id: "s",
      endpoint: "https://x.example/a",
      method: "GET",
      query: [
        ["b", "1"],
        ["a", "2"],
      ],
      body_digest: createHash("sha256").update("null").digest("hex"),
      network_canonical: "eip155:8453",
      asset: ASSET_LC(),
      pay_to: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      amount_atomic: "1000",
      protocol: "x402",
      protocol_version: "2",
      scheme: "exact",
    });
    expect(paymentCandidateIdentitySha256(t)).toBe(paymentCandidateIdentitySha256(t));
  });
});

function ASSET_LC(): string {
  return "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
}

describe("B.5 policy matrix", () => {
  it("A–J classification matrix", async () => {
    const policy = loadB5CandidatePolicy();
    const cases = [
      {
        name: "A_onesource_compatible",
        obs: syntheticObservation({
          endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
          service_id: "api_onesource_io_api_chain_block_number",
          amount_atomic: "1000",
          purpose: "ethereum_block_number",
        }),
        expect: "ELIGIBLE",
      },
      {
        name: "B_second_compatible",
        obs: syntheticObservation({
          endpoint: SYNTHETIC_ALT_ENDPOINT,
          service_id: "seller_b_tip",
          amount_atomic: "1000",
          pay_to: SYNTHETIC_PAY_TO_B,
          purpose: "tip",
        }),
        expect: "ELIGIBLE",
      },
      {
        name: "C_unsupported_network",
        obs: syntheticObservation({
          endpoint: "https://x.example/n",
          service_id: "bad_net",
          amount_atomic: "1000",
          network_canonical: "eip155:1",
        }),
        expect: "UNSUPPORTED",
      },
      {
        name: "D_unsupported_scheme",
        obs: syntheticObservation({
          endpoint: "https://x.example/s",
          service_id: "bad_scheme",
          amount_atomic: "1000",
          scheme: "upto",
        }),
        expect: "UNSUPPORTED",
      },
      {
        name: "E_amount_above_cap",
        obs: syntheticObservation({
          endpoint: "https://x.example/hi",
          service_id: "pricey",
          amount_atomic: "10000",
        }),
        expect: "INELIGIBLE",
      },
      {
        name: "F_invalid_payTo",
        obs: syntheticObservation({
          endpoint: "https://x.example/p",
          service_id: "bad_pay",
          amount_atomic: "1000",
          pay_to: "not-an-address",
        }),
        expect: "INELIGIBLE",
      },
      {
        name: "G_stale",
        obs: syntheticObservation({
          endpoint: "https://x.example/old",
          service_id: "stale",
          amount_atomic: "1000",
          discovered_at: "2020-01-01T00:00:00.000Z",
        }),
        expect: "STALE",
      },
      {
        name: "H_duplicate_same_identity",
        obs: syntheticObservation({
          endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
          service_id: "api_onesource_io_api_chain_block_number",
          amount_atomic: "1000",
          discovered_at: "2026-08-13T04:00:00.000Z",
        }),
        expect: "ELIGIBLE",
      },
      {
        name: "I_changed_economics",
        obs: syntheticObservation({
          endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
          service_id: "api_onesource_io_api_chain_block_number",
          amount_atomic: "1500",
        }),
        expect: "ELIGIBLE",
      },
      {
        name: "J_different_query",
        obs: syntheticObservation({
          endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
          service_id: "api_onesource_io_api_chain_block_number",
          amount_atomic: "1000",
          query: [["network", "polygon"]],
        }),
        expect: "ELIGIBLE",
      },
    ] as const;

    for (const c of cases) {
      const candidate = normalizeFromDiscoveredSelectedCandidate(c.obs.selected!);
      const verdict = evaluatePaymentCandidatePolicy(candidate, {
        policy,
        now: NOW,
      });
      expect(verdict.verdict, c.name).toBe(c.expect);
      expect(verdict.payment_authorized).toBe(false);
    }
  });
});

describe("B.5 multi-candidate selection", () => {
  it("selects lowest-cost compatible with rationale; economics change selection", async () => {
    const low = syntheticObservation({
      endpoint: SYNTHETIC_ALT_ENDPOINT,
      service_id: "seller_b_low",
      amount_atomic: "1000",
      pay_to: SYNTHETIC_PAY_TO_B,
      purpose: "tip_low",
    });
    const high = syntheticObservation({
      endpoint: "https://seller-c.example.invalid/api/v1/tip",
      service_id: "seller_c_high",
      amount_atomic: "4000",
      pay_to: "0x2222222222222222222222222222222222222222",
      purpose: "tip_high",
    });
    const bad = syntheticObservation({
      endpoint: "https://bad.example.invalid/x",
      service_id: "bad",
      amount_atomic: "1000",
      network_canonical: "eip155:1",
    });
    const discovery = createStaticFixtureDiscovery([low.raw, high.raw, bad.raw]);
    const pipeline = await runB5CandidatePipeline({
      discoveries: [discovery],
      buyer_wallet: SYNTHETIC_B33_RUNTIME_ADDRESS,
      now: NOW,
    });
    expect(pipeline.selection.selected_candidate.service_id).toBe("seller_b_low");
    expect(pipeline.selection.payment_authorized).toBe(false);
    expect(pipeline.selection.selection_rationale.join(" ")).toMatch(/cost_atomic=1000/);

    const flipped = createStaticFixtureDiscovery([
      { ...low.raw, amount_atomic: "4500" },
      { ...high.raw, amount_atomic: "1000" },
      bad.raw,
    ]);
    const pipeline2 = await runB5CandidatePipeline({
      discoveries: [flipped],
      buyer_wallet: SYNTHETIC_B33_RUNTIME_ADDRESS,
      now: NOW,
    });
    expect(pipeline2.selection.selected_candidate.service_id).toBe("seller_c_high");
  });
});

describe("B.5 productive-core isolation + OneSource generalization", () => {
  it("guards are defined and discovery cannot authorize", () => {
    expect(GUARD_B5_CANNOT_SIGN).toBeTruthy();
    expect(GUARD_B5_CANNOT_SEND).toBeTruthy();
    expect(GUARD_B5_CANNOT_CREATE_PSA_DIRECTLY).toBeTruthy();
    expect(GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT).toBeTruthy();
    expect(GUARD_SELECTION_CANNOT_DRIFT_AFTER_HUMAN_APPROVAL).toBeTruthy();
  });

  it("thin-mainnet-payment-runner source has no OneSource hardcoding", async () => {
    const src = readFileSync(
      join(process.cwd(), "tools/trustforge/thin-mainnet-payment-runner.ts"),
      "utf8",
    );
    expect(src.toLowerCase()).not.toMatch(/onesource/);
  });

  it("OneSource candidate normalizes and bridges to DiscoveredSelectedCandidate", async () => {
    const one = syntheticObservation({
      endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
      service_id: "api_onesource_io_api_chain_block_number",
      amount_atomic: "1000",
      purpose: "ethereum_block_number",
      provider_id: "discovered_x402",
    });
    const pipeline = await runB5CandidatePipeline({
      discoveries: [createDiscoveredSelectedCandidateDiscovery(one.selected!, {
        purpose: "ethereum_block_number",
      })],
      buyer_wallet: SYNTHETIC_B33_RUNTIME_ADDRESS,
      now: NOW,
    });
    const bridged = selectedPaymentCandidateToDiscovered(pipeline.selection);
    expect(bridged.endpoint).toBe(SYNTHETIC_ONESOURCE_ENDPOINT);
    expect(bridged.quote_atomic).toBe("1000");
  });
});

describe("B.5 loopback E2E via generalized runner", () => {
  it("APPROVE → 1 synthetic signature path + 1 loopback request; REJECT → 0", async () => {
    const dir = workDir();
    const vaultDir = join(dir, "vault");
    writeProtectedSignerVault({
      path: join(
        vaultDir,
        `buyer-${SYNTHETIC_B33_RUNTIME_ADDRESS.toLowerCase()}.vault.json`,
      ),
      expectedPublicAddress: SYNTHETIC_B33_RUNTIME_ADDRESS,
      plaintextKey: privateKeyAsciiToCredentialBytes(SYNTHETIC_B33_RUNTIME_KEY),
      backend: createSyntheticXorProtectedSecretBackend(),
      now: NOW,
    });

    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const endpoint = `http://127.0.0.1:${addr.port}/api/chain/block-number`;

    const built = syntheticObservation({
      endpoint,
      service_id: "loopback_block_number",
      amount_atomic: "1000",
      purpose: "loopback",
      discovered_at: "2026-08-13T04:00:00.000Z",
    });

    const pipeline = await runB5CandidatePipeline({
      discoveries: [
        createDiscoveredSelectedCandidateDiscovery(built.selected!, {
          purpose: "loopback",
        }),
      ],
      directory: dir,
      buyer_wallet: SYNTHETIC_B33_RUNTIME_ADDRESS,
      now: NOW,
    });
    expect(pipeline.selection.selected_candidate_id).toBeTruthy();

    const approve = await runThinMainnetPaymentFromB5Selection({
      directory: join(dir, "approve"),
      selection: pipeline.selection,
      decisionProvider: createTestHumanPaymentDecisionProvider({
        decision: "APPROVE",
        decision_source: "approve_button",
        explicit_human_decision: true,
        human_decision_id: "paydec_b5_loop_ok",
        decided_at: "2026-08-13T03:55:00.000Z",
        provider_id: "injected-test-decision",
        policy: "manual-approve-reject",
      }),
      credentialProvider: createWindowsDpapiLocalSignerProvider({
        vaultBaseDir: vaultDir,
        backend: createSyntheticXorProtectedSecretBackend(),
      }),
      freshObservation: built.fresh!,
      now: NOW,
      nowAtSign: NOW,
      credentialPolicyPath: writeDpapiAccessPolicy(dir),
      transport: createFetchPaymentBearingHttpTransport(),
      skipOnchainVerify: true,
      mandateTtlMs: 1_800_000,
      nonceSource: () => `0x${"b5".repeat(32)}` as `0x${string}`,
    });
    expect(approve.state.state).toBe("CONFIRMED");
    expect(approve.signatures).toBe(1);
    expect(approve.payment_bearing_requests).toBe(1);
    expect(approve.retry).toBe(0);
    expect(approve.resend).toBe(0);
    expect(hits).toBe(1);
    expect(existsSync(join(dir, "approve", "b5_selection_link.json"))).toBe(true);

    const hitsBeforeReject = hits;
    await expect(
      runThinMainnetPaymentFromB5Selection({
        directory: join(dir, "reject"),
        selection: pipeline.selection,
        decisionProvider: createTestHumanPaymentDecisionProvider({
          decision: "REJECT",
          decision_source: "reject_button",
          explicit_human_decision: true,
          human_decision_id: "paydec_b5_loop_rej",
          decided_at: "2026-08-13T03:55:00.000Z",
          provider_id: "injected-test-decision",
          policy: "manual-approve-reject",
        }),
        credentialProvider: createWindowsDpapiLocalSignerProvider({
          vaultBaseDir: vaultDir,
          backend: createSyntheticXorProtectedSecretBackend(),
        }),
        now: NOW,
        skipOnchainVerify: true,
      }),
    ).rejects.toThrow(/HUMAN_REJECTED/);
    expect(hits).toBe(hitsBeforeReject);
  });
});
