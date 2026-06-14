import { describe, expect, it } from "vitest";
import {
  buildTxGroundTruth,
  ERC20_TRANSFER_TOPIC,
  USDC_BASE_ADDRESS,
} from "../../tools/trustforge/build-tx-ground-truth";

const PHASE2_TX =
  "0xff5ec5e20c42aff2d6d96b7854441a0d0357178a2263f02ea381a00db12d26d4";

function mockFetch(receipt: unknown, tx: unknown): typeof fetch {
  return (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (body.method === "eth_chainId") {
      return new Response(JSON.stringify({ result: "0x2105" }), { status: 200 });
    }
    if (body.method === "eth_getTransactionByHash") {
      return new Response(JSON.stringify({ result: tx }), { status: 200 });
    }
    if (body.method === "eth_getTransactionReceipt") {
      return new Response(JSON.stringify({ result: receipt }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unknown" }), { status: 200 });
  }) as typeof fetch;
}

describe("buildTxGroundTruth", () => {
  it("decodes Base tx receipt and USDC Transfer", async () => {
    const receipt = {
      status: "0x1",
      blockNumber: "0x2d1e804",
      from: "0xb87e1a2cc2b4643f2892768e80e41167f17c5860",
      to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      gasUsed: "0x1511a",
      effectiveGasPrice: "0x989680",
      logs: [
        {
          address: USDC_BASE_ADDRESS,
          topics: [
            ERC20_TRANSFER_TOPIC,
            "0x0000000000000000000000004cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
            "0x00000000000000000000000052e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
          ],
          data: "0x00000000000000000000000000000000000000000000000000000000000003e8",
        },
      ],
    };
    const tx = {
      hash: PHASE2_TX,
      blockNumber: "0x2d1e804",
      from: receipt.from,
      to: receipt.to,
    };

    const gt = await buildTxGroundTruth({
      txHash: PHASE2_TX,
      chain: "base",
      rpcSources: ["https://mock-rpc"],
      fetchImpl: mockFetch(receipt, tx),
      now: () => new Date("2026-06-14T00:00:00.000Z"),
    });

    expect(gt.exists).toBe(true);
    expect(gt.chain_id).toBe(8453);
    expect(gt.status).toBe("success");
    expect(gt.block_number).toBe(0x2d1e804);
    expect(gt.erc20_transfers).toHaveLength(1);
    expect(gt.erc20_transfers[0]?.amount_decimal).toBe("0.001");
    expect(gt.erc20_transfers[0]?.symbol).toBe("USDC");
  });
});
