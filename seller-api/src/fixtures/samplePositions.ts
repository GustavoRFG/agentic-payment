import type { NormalizedPosition } from "../domain/reportTypes";

export const defaultSamplePosition: NormalizedPosition = {
  protocol: "pancakeswap",
  chain: "bsc",
  tokenId: "demo-position-001",
  pair: "CAKE/BNB",
  rangeStatus: "in_range",
  liquidityUsd: 1380.19,
  feesUsd: 3.42,
  impermanentLossEstimatePct: null,
  healthFlags: [],
};
