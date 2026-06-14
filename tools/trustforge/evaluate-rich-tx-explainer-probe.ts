/**
 * evaluate-rich-tx-explainer-probe — LLM-free rich evaluation dimensions.
 */

import type { FactVerificationResult } from "./verify-tx-explainer-facts";
import type { OnchainPaymentVerification } from "./verify-base-usdc-payment";

export interface RichProbeRunLike {
  readonly probe_id: string;
  readonly service_id: string;
  readonly response?: {
    readonly http_status?: number | null;
    readonly body_sha256?: string | null;
  };
  readonly payment?: {
    readonly attempt_count?: number;
    readonly payment_bearing_http_request_count?: number;
    readonly actual_amount_usdc?: string | null;
    readonly transaction_hash?: string | null;
    readonly retry_used?: boolean;
    readonly fallback_used?: boolean;
  };
  readonly fact_verification?: {
    readonly composite?: number;
    readonly passed?: boolean;
  };
}

export interface RichEvalTaskLike {
  readonly task_id: string;
  readonly service_id: string;
  readonly methodology_version: string;
}

export interface RichEvaluationDimensions {
  readonly payment_integrity: number;
  readonly response_integrity: number;
  readonly tx_identity: number;
  readonly chain_identity: number;
  readonly execution_status: number;
  readonly block_facts: number;
  readonly address_facts: number;
  readonly token_transfer_facts: number;
  readonly amount_facts: number;
  readonly fee_facts: number;
  readonly safety: number;
}

export interface RichEvaluationResult {
  readonly schema_name: "trustforge_evaluation_result";
  readonly schema_version: string;
  readonly evaluation_id: string;
  readonly probe_id: string;
  readonly task_id: string;
  readonly service_id: string;
  readonly dimensions: RichEvaluationDimensions;
  readonly composite: number;
  readonly status: "pass" | "fail";
  readonly methodology_version: string;
  readonly semantic_richness: "high";
  readonly created_at_utc: string;
}

export const RICH_EVALUATION_SCHEMA_VERSION = "0.2.0";

const WEIGHTS = {
  payment_integrity: 0.1,
  response_integrity: 0.05,
  tx_identity: 0.12,
  chain_identity: 0.08,
  execution_status: 0.08,
  block_facts: 0.08,
  address_facts: 0.12,
  token_transfer_facts: 0.15,
  amount_facts: 0.12,
  fee_facts: 0.05,
  safety: 0.05,
} as const;

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function evaluateRichTxExplainerProbe(input: {
  readonly probe: RichProbeRunLike;
  readonly task: RichEvalTaskLike;
  readonly factVerification: FactVerificationResult;
  readonly onchainPayment: OnchainPaymentVerification;
  readonly now?: () => Date;
}): RichEvaluationResult {
  const { probe, task, factVerification, onchainPayment } = input;
  const now = input.now ?? (() => new Date());
  const dims = factVerification.dimensions;

  const payment_integrity =
    onchainPayment.status === "ONCHAIN_VERIFIED" ? 1 : 0;
  const response_integrity = probe.response?.http_status === 200 ? 1 : 0;
  const safety =
    probe.payment?.attempt_count === 1 &&
    probe.payment?.payment_bearing_http_request_count === 1 &&
    probe.payment?.retry_used !== true &&
    probe.payment?.fallback_used !== true
      ? 1
      : 0;

  const dimensions: RichEvaluationDimensions = {
    payment_integrity,
    response_integrity,
    tx_identity: dims.tx_identity,
    chain_identity: dims.chain_identity,
    execution_status: dims.execution_status,
    block_facts: dims.block_facts,
    address_facts: dims.address_facts,
    token_transfer_facts: dims.token_transfer_facts,
    amount_facts: dims.amount_facts,
    fee_facts: dims.fee_facts,
    safety,
  };

  let composite = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    composite += weight * dimensions[key as keyof RichEvaluationDimensions];
  }
  composite = round6(composite);

  const status =
    composite >= 0.8 &&
    factVerification.passed &&
    payment_integrity === 1 &&
    response_integrity === 1 &&
    safety === 1
      ? "pass"
      : "fail";

  return {
    schema_name: "trustforge_evaluation_result",
    schema_version: RICH_EVALUATION_SCHEMA_VERSION,
    evaluation_id: `${probe.probe_id}__eval`,
    probe_id: probe.probe_id,
    task_id: task.task_id,
    service_id: task.service_id,
    dimensions,
    composite,
    status,
    methodology_version: task.methodology_version,
    semantic_richness: "high",
    created_at_utc: now().toISOString(),
  };
}

export function richEvaluationToTrustScoreInput(
  evaluation: RichEvaluationResult,
): {
  readonly service_id: string;
  readonly composite: number;
  readonly dimensions: Record<string, number>;
  readonly methodology_version: string;
  readonly status: "pass" | "fail";
} {
  return {
    service_id: evaluation.service_id,
    composite: evaluation.composite,
    dimensions: evaluation.dimensions as unknown as Record<string, number>,
    methodology_version: evaluation.methodology_version,
    status: evaluation.status,
  };
}
