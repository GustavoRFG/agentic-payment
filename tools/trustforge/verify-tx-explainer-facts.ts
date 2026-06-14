/**
 * verify-tx-explainer-facts — deterministic fact verification vs RPC ground truth.
 */

import type { TxGroundTruth } from "./build-tx-ground-truth";
import type { TxExplainerClaims } from "./extract-tx-explainer-claims";

export const FACT_VERIFICATION_VERSION = "0.1.0";

export const DIMENSION_WEIGHTS = {
  tx_identity: 0.15,
  chain_identity: 0.1,
  execution_status: 0.1,
  block_facts: 0.1,
  address_facts: 0.15,
  token_transfer_facts: 0.2,
  amount_facts: 0.15,
  fee_facts: 0.05,
} as const;

export interface FactVerificationDimensions {
  readonly tx_identity: number;
  readonly chain_identity: number;
  readonly execution_status: number;
  readonly block_facts: number;
  readonly address_facts: number;
  readonly token_transfer_facts: number;
  readonly amount_facts: number;
  readonly fee_facts: number;
  readonly unsupported_or_wrong_claim_penalty: number;
}

export interface FactVerificationResult {
  readonly fact_verification_version: string;
  readonly dimensions: FactVerificationDimensions;
  readonly composite: number;
  readonly passed: boolean;
  readonly matched_claims: readonly string[];
  readonly wrong_claims: readonly string[];
  readonly missing_core_facts: readonly string[];
  readonly unverifiable_claims: readonly string[];
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function scoreBinary(ok: boolean): number {
  return ok ? 1 : 0;
}

function normalizeAmount(value: string): string {
  return value.replace(/\s*(USDC|usdc|USD)\s*/gi, "").trim();
}

export function verifyTxExplainerFacts(input: {
  readonly groundTruth: TxGroundTruth;
  readonly claims: TxExplainerClaims;
}): FactVerificationResult {
  const { groundTruth, claims } = input;
  const matched_claims: string[] = [];
  const wrong_claims: string[] = [];
  const missing_core_facts: string[] = [];
  const unverifiable_claims: string[] = [];

  const txHash = groundTruth.tx_hash.toLowerCase();
  const txClaims = claims.tx_hash_claims.map((v) => v.toLowerCase());
  let tx_identity = 0;
  if (txClaims.length === 0) {
    missing_core_facts.push("tx_hash");
    tx_identity = 0;
  } else if (txClaims.every((v) => v === txHash)) {
    tx_identity = 1;
    matched_claims.push(`tx_hash:${txHash}`);
  } else {
    tx_identity = 0;
    wrong_claims.push(...txClaims.filter((v) => v !== txHash).map((v) => `tx_hash:${v}`));
  }

  const chainStr = String(groundTruth.chain_id);
  let chain_identity = 1;
  if (claims.chain_claims.length === 0) {
    missing_core_facts.push("chain_id");
    chain_identity = 0;
  } else {
    const normalized = claims.chain_claims.map((c) => {
      const lower = c.toLowerCase();
      if (lower === "base" || lower === "eip155:8453") return "8453";
      if (lower === "ethereum" || lower === "eip155:1") return "1";
      return c;
    });
    if (normalized.every((c) => c === chainStr)) {
      matched_claims.push(`chain_id:${chainStr}`);
    } else {
      chain_identity = 0;
      wrong_claims.push(
        ...normalized.filter((c) => c !== chainStr).map((c) => `chain:${c}`),
      );
    }
  }

  let execution_status = 1;
  if (claims.status_claims.length === 0) {
    missing_core_facts.push("status");
    execution_status = 0.5;
  } else if (
    !claims.status_claims.some((s) => s === groundTruth.status || (groundTruth.status === "success" && s === "success"))
  ) {
    execution_status = 0;
    wrong_claims.push(...claims.status_claims.map((s) => `status:${s}`));
  } else {
    matched_claims.push(`status:${groundTruth.status}`);
  }

  let block_facts = 1;
  if (claims.block_number_claims.length === 0) {
    missing_core_facts.push("block_number");
    block_facts = 0.5;
  } else if (!claims.block_number_claims.includes(groundTruth.block_number)) {
    block_facts = 0;
    wrong_claims.push(
      ...claims.block_number_claims.map((b) => `block_number:${b}`),
    );
  } else {
    matched_claims.push(`block_number:${groundTruth.block_number}`);
  }

  const coreAddresses = uniqueLower([
    groundTruth.from,
    groundTruth.to,
    ...groundTruth.erc20_transfers.flatMap((t) => [t.from, t.to, t.token]),
  ]).filter(Boolean);

  let address_facts = 1;
  if (claims.address_claims.length === 0) {
    missing_core_facts.push("addresses");
    address_facts = 0.5;
  } else {
    const matched = claims.address_claims.filter((a) => coreAddresses.includes(a.toLowerCase()));
    if (matched.length === 0) address_facts = 0;
    else address_facts = Math.min(1, matched.length / Math.max(1, coreAddresses.length));
    matched.forEach((a) => matched_claims.push(`address:${a}`));
    claims.address_claims
      .filter((a) => !coreAddresses.includes(a.toLowerCase()))
      .forEach((a) => unverifiable_claims.push(`address:${a}`));
  }

  const usdcTransfers = groundTruth.erc20_transfers.filter((t) => t.symbol === "USDC");
  let token_transfer_facts = 1;
  if (usdcTransfers.length === 0) {
    token_transfer_facts = claims.token_transfer_claims.length === 0 ? 0.5 : 0;
  } else if (claims.token_transfer_claims.length === 0) {
    missing_core_facts.push("token_transfer");
    token_transfer_facts = 0.5;
  } else {
    const gt = usdcTransfers[0];
    const ok = claims.token_transfer_claims.some(
      (c) =>
        (!c.from || c.from === gt.from) &&
        (!c.to || c.to === gt.to) &&
        (!c.token || c.token === gt.token),
    );
    token_transfer_facts = ok ? 1 : 0;
    if (!ok) wrong_claims.push("token_transfer:mismatch");
    else matched_claims.push("token_transfer:usdc");
  }

  let amount_facts = 1;
  const expectedAmounts = usdcTransfers.map((t) => t.amount_decimal);
  if (expectedAmounts.length === 0) {
    amount_facts = claims.amount_claims.length === 0 ? 0.5 : 0;
  } else if (claims.amount_claims.length === 0) {
    missing_core_facts.push("amount");
    amount_facts = 0.5;
  } else {
    const normalizedExpected = expectedAmounts.map(normalizeAmount);
    const normalizedClaims = claims.amount_claims.map(normalizeAmount);
    const ok = normalizedClaims.some((c) => normalizedExpected.includes(c));
    amount_facts = ok ? 1 : 0;
    if (!ok) wrong_claims.push(...claims.amount_claims.map((a) => `amount:${a}`));
    else matched_claims.push(`amount:${expectedAmounts[0]}`);
  }

  let fee_facts = 1;
  if (claims.fee_claims.length === 0) {
    fee_facts = 0.5;
  } else {
    matched_claims.push("fee:mentioned");
  }

  let tokenDim = scoreBinary(token_transfer_facts >= 1);
  let amountDim = scoreBinary(amount_facts >= 1);

  if (wrong_claims.some((c) => c.startsWith("amount:"))) {
    tokenDim = 0;
    amountDim = 0;
  }

  const dimensions: FactVerificationDimensions = {
    tx_identity: scoreBinary(tx_identity >= 1),
    chain_identity: scoreBinary(chain_identity >= 1),
    execution_status: scoreBinary(execution_status >= 1),
    block_facts: scoreBinary(block_facts >= 1),
    address_facts: scoreBinary(address_facts >= 0.8),
    token_transfer_facts: tokenDim,
    amount_facts: amountDim,
    fee_facts: scoreBinary(fee_facts >= 0.5),
    unsupported_or_wrong_claim_penalty: wrong_claims.length > 0 ? 0.1 : 0,
  };

  let composite =
    DIMENSION_WEIGHTS.tx_identity * dimensions.tx_identity +
    DIMENSION_WEIGHTS.chain_identity * dimensions.chain_identity +
    DIMENSION_WEIGHTS.execution_status * dimensions.execution_status +
    DIMENSION_WEIGHTS.block_facts * dimensions.block_facts +
    DIMENSION_WEIGHTS.address_facts * dimensions.address_facts +
    DIMENSION_WEIGHTS.token_transfer_facts * dimensions.token_transfer_facts +
    DIMENSION_WEIGHTS.amount_facts * dimensions.amount_facts +
    DIMENSION_WEIGHTS.fee_facts * dimensions.fee_facts;

  if (wrong_claims.some((c) => c.startsWith("tx_hash:"))) composite = Math.min(composite, 0.2);
  if (wrong_claims.some((c) => c.startsWith("chain:"))) composite = Math.min(composite, 0.4);
  if (wrong_claims.some((c) => c.startsWith("amount:"))) composite = Math.min(composite, 0.5);

  composite = round4(composite);
  const passed = composite >= 0.8 && !wrong_claims.some((c) => c.startsWith("tx_hash:"));

  return {
    fact_verification_version: FACT_VERIFICATION_VERSION,
    dimensions: {
      ...dimensions,
      unsupported_or_wrong_claim_penalty: dimensions.unsupported_or_wrong_claim_penalty,
    },
    composite,
    passed,
    matched_claims,
    wrong_claims,
    missing_core_facts,
    unverifiable_claims,
  };
}

function uniqueLower(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.toLowerCase()))];
}
