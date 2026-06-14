import { describe, expect, it, vi } from "vitest";

import {
  normalizeBlockNumber,
  validateGroundTruth,
  verifyProfileSemantics,
  type GroundTruthResult,
  type PaidResponse,
} from "../../tools/trustforge/external-x402-paid-executor";
import {
  ONESOURCE_ETHEREUM_BLOCK_NUMBER_POLICY,
  ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
  resolveExternalX402GetProbePolicy,
  verificationProfileOf,
} from "../../tools/trustforge/external-x402-get-policy";
import {
  extractObservedNumeric,
  verifyEthereumBlockNumber,
} from "../../tools/trustforge/external-x402-live-bindings";
import {
  evaluateBootstrapProbe,
  type EvalTaskLike,
  type ProbeRunLike,
} from "../../tools/trustforge/evaluate-bootstrap-probe";

const BLOCK_POLICY = ONESOURCE_ETHEREUM_BLOCK_NUMBER_POLICY;

function paidResponse(overrides: Partial<PaidResponse> = {}): PaidResponse {
  return {
    httpStatus: 200,
    responseHeadersSanitized: {},
    responseBodySanitized: { data: { result: "0x14a3f2c" } },
    responseBodySha256: "x",
    observedChainId: null,
    actualAmountUsdc: "0.001",
    network: "eip155:8453",
    asset: "USDC",
    ...overrides,
  };
}

function gt(blockNumberDecimal: number): GroundTruthResult {
  return {
    ok: true,
    blockNumberDecimal,
    blockNumberHex: `0x${blockNumberDecimal.toString(16)}`,
    sources: ["a", "b"],
  };
}

describe("policy verification profiles", () => {
  it("defaults to chain-id and exposes the block-number profile", () => {
    expect(verificationProfileOf(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY)).toBe("ethereum_chain_id");
    expect(verificationProfileOf(BLOCK_POLICY)).toBe("ethereum_block_number");
    expect(resolveExternalX402GetProbePolicy(BLOCK_POLICY.policyId).serviceId).toBe(
      "onesource_api_block_number",
    );
  });
});

describe("normalizeBlockNumber", () => {
  it("parses hex and decimal block numbers", () => {
    expect(normalizeBlockNumber("0x10")).toBe(16);
    expect(normalizeBlockNumber("21675820")).toBe(21675820);
    expect(normalizeBlockNumber(21675820)).toBe(21675820);
    expect(normalizeBlockNumber("not-a-number")).toBeNull();
    expect(normalizeBlockNumber(null)).toBeNull();
  });
});

describe("extractObservedNumeric", () => {
  it("digs the block number out of nested response shapes", () => {
    expect(extractObservedNumeric({ data: { result: "0x14a3f2c" } })).toBe("0x14a3f2c");
    expect(extractObservedNumeric({ blockNumber: 21675820 })).toBe(21675820);
    expect(extractObservedNumeric({ data: { blockNumber: "21675820" } })).toBe("21675820");
  });
});

describe("validateGroundTruth (block-number profile)", () => {
  it("accepts a positive integer block number", () => {
    expect(() => validateGroundTruth(gt(21675820), "ethereum_block_number")).not.toThrow();
  });
  it("rejects a missing or non-positive block number", () => {
    expect(() =>
      validateGroundTruth({ ok: true }, "ethereum_block_number"),
    ).toThrow("eth_blockNumber");
    expect(() =>
      validateGroundTruth({ ok: false, blockNumberDecimal: 1 }, "ethereum_block_number"),
    ).toThrow("eth_blockNumber");
  });
});

describe("verifyProfileSemantics (block-number tolerance window)", () => {
  it("passes when observed block is inside the before/after window", () => {
    const r = verifyProfileSemantics(
      BLOCK_POLICY,
      paidResponse({ observedValue: 21675820 }),
      gt(21675819),
      gt(21675821),
    );
    expect(r.profile).toBe("ethereum_block_number");
    expect(r.pass).toBe(true);
  });

  it("passes within tolerance when slightly ahead of the window", () => {
    // window [before, after] = [21672745, 21672746]; tolerance 5 -> [21672740, 21672751]
    const r = verifyProfileSemantics(
      BLOCK_POLICY,
      paidResponse({ observedValue: 21672749 }),
      gt(21672745),
      gt(21672746),
    );
    expect(r.pass).toBe(true);
  });

  it("fails when observed block is far outside the window", () => {
    const r = verifyProfileSemantics(
      BLOCK_POLICY,
      paidResponse({ observedValue: 1 }),
      gt(21675819),
      gt(21675821),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("outside");
  });

  it("fails when the observed value is missing", () => {
    const r = verifyProfileSemantics(
      BLOCK_POLICY,
      paidResponse({ observedValue: null }),
      gt(21675819),
      gt(21675821),
    );
    expect(r.pass).toBe(false);
  });
});

describe("verifyProfileSemantics (chain-id profile, network-info style)", () => {
  it("passes when observed chain id resolves to mainnet", () => {
    const r = verifyProfileSemantics(
      ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
      paidResponse({ observedChainId: "0x1" }),
      { ok: true, chainIdHex: "0x1", chainIdDecimal: 1 },
      { ok: true, chainIdHex: "0x1", chainIdDecimal: 1 },
    );
    expect(r.profile).toBe("ethereum_chain_id");
    expect(r.pass).toBe(true);
  });

  it("fails when observed chain id is not mainnet", () => {
    const r = verifyProfileSemantics(
      ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
      paidResponse({ observedChainId: "0x89" }),
      { ok: true, chainIdHex: "0x1", chainIdDecimal: 1 },
      { ok: true, chainIdHex: "0x1", chainIdDecimal: 1 },
    );
    expect(r.pass).toBe(false);
  });
});

describe("evaluateBootstrapProbe (block-number profile correctness)", () => {
  const TASK: EvalTaskLike = {
    task_id: "onesource_api_block_number__ethereum_block_number_v1",
    service_id: "onesource_api_block_number",
    max_acceptable_latency_ms: 5000,
    methodology_version: "trustforge-bootstrap-v0.1.0",
    verifiers: [
      { name: "ethereum_block_number_within_tolerance", weight: 0.6, dimension: "correctness" },
      { name: "http_200", weight: 0.1, dimension: "reliability" },
      { name: "settlement_verified", weight: 0.2, dimension: "payment_integrity" },
      { name: "one_shot_safety", weight: 0.1, dimension: "safety" },
    ],
  };

  function blockProbe(semantic: "pass" | "fail"): ProbeRunLike {
    return {
      probe_id: "blk_probe_0001",
      service_id: "onesource_api_block_number",
      response: { http_status: 200, latency_ms: 400, observed_chain_id: null },
      verification: {
        verification_profile: "ethereum_block_number",
        ground_truth_before: 21675819,
        ground_truth_after: 21675821,
        observed_value: 21675820,
        observed_chain_id: null,
        semantic_correctness: semantic,
        onchain_transfer_verification: "ONCHAIN_VERIFIED",
      },
      safety: {
        attempt_count: 1,
        payment_bearing_http_request_count: 1,
        retry_used: false,
        fallback_used: false,
      },
    };
  }

  it("derives correctness from the recorded semantic verdict", () => {
    const pass = evaluateBootstrapProbe(blockProbe("pass"), TASK);
    expect(pass.dimensions.correctness).toBe(1);
    expect(pass.composite).toBe(1);
    expect(pass.status).toBe("pass");

    const fail = evaluateBootstrapProbe(blockProbe("fail"), TASK);
    expect(fail.dimensions.correctness).toBe(0);
    expect(fail.status).toBe("fail");
  });
});

describe("verifyEthereumBlockNumber (independent RPC ground truth)", () => {
  it("returns the most advanced block across independent RPC mocks", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "0x14a3f2c" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "0x14a3f2d" }), { status: 200 }),
      ) as unknown as typeof fetch;

    const result = await verifyEthereumBlockNumber({
      fetchImpl,
      sources: ["https://rpc-a.example", "https://rpc-b.example"],
    });
    expect(result.ok).toBe(true);
    expect(result.blockNumberDecimal).toBe(Number.parseInt("0x14a3f2d", 16));
  });

  it("returns ok:false when a source fails", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("err", { status: 500 }),
    ) as unknown as typeof fetch;
    const result = await verifyEthereumBlockNumber({
      fetchImpl,
      sources: ["https://rpc-a.example"],
    });
    expect(result.ok).toBe(false);
  });
});
