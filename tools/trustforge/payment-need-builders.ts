/**
 * payment-need-builders — convenience fixtures for human/agent/workflow needs.
 */

import { buildPaymentNeed, type PaymentNeedV1 } from "./payment-need-v1";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function buildHumanCryptoNewsNeed(input: {
  readonly createdAt: string;
  readonly originRef?: string;
  readonly budgetCeiling?: string;
}): PaymentNeedV1 {
  return buildPaymentNeed({
    createdAt: input.createdAt,
    originType: "HUMAN_REQUEST",
    originRef: input.originRef ?? "fixture:human_request:crypto_market_brief",
    parentTaskId: null,
    parentTaskHash: null,
    parentRequestedOutcome: null,
    workflowId: null,
    workflowVersion: null,
    workflowStateHash: null,
    requiredStep: null,
    requestedOutcome: "obtain current crypto news / market brief",
    needEvidence: [
      {
        kind: "human_task_text",
        ref: input.originRef ?? "fixture:human_request:crypto_market_brief",
        detail: "prepare a current crypto market brief",
      },
    ],
    constraints: { notes: [], preferredPriceAtomic: null },
    allowedCapabilities: ["crypto_news"],
    prohibitedCapabilities: ["chain_block_number", "weather_forecast"],
    preferredNetworkConstraints: ["eip155:8453"],
    preferredAssetConstraints: ["USDC", USDC],
    budgetCeiling: input.budgetCeiling ?? "1000",
    budgetAsset: USDC,
    urgency: "medium",
    informationFreshnessNeed: { kind: "max_age_ms", maxAgeMs: 3_600_000 },
    riskConstraints: [],
    needAuthorityClass: "EXPLICIT_HUMAN_NEED",
    lifecycleState: "ACTIVE",
    derivationRationale: null,
  });
}

export function buildHumanBlockNumberNeed(input: {
  readonly createdAt: string;
  readonly originRef?: string;
  readonly budgetCeiling?: string;
}): PaymentNeedV1 {
  return buildPaymentNeed({
    createdAt: input.createdAt,
    originType: "HUMAN_REQUEST",
    originRef: input.originRef ?? "fixture:human_request:ethereum_block_number",
    parentTaskId: null,
    parentTaskHash: null,
    parentRequestedOutcome: null,
    workflowId: null,
    workflowVersion: null,
    workflowStateHash: null,
    requiredStep: null,
    requestedOutcome: "obtain current Ethereum block number",
    needEvidence: [
      {
        kind: "human_task_text",
        ref: input.originRef ?? "fixture:human_request:ethereum_block_number",
        detail: "get current Ethereum block number",
      },
    ],
    constraints: { notes: [], preferredPriceAtomic: null },
    allowedCapabilities: ["chain_block_number"],
    prohibitedCapabilities: ["crypto_news", "weather_forecast"],
    preferredNetworkConstraints: ["eip155:8453"],
    preferredAssetConstraints: ["USDC", USDC],
    budgetCeiling: input.budgetCeiling ?? "1000",
    budgetAsset: USDC,
    urgency: "medium",
    informationFreshnessNeed: { kind: "max_age_ms", maxAgeMs: 120_000 },
    riskConstraints: [],
    needAuthorityClass: "EXPLICIT_HUMAN_NEED",
    lifecycleState: "ACTIVE",
    derivationRationale: null,
  });
}

export function buildDerivedAgentCryptoNewsNeed(input: {
  readonly createdAt: string;
  readonly parentRequestedOutcome?: string;
}): PaymentNeedV1 {
  const parentRequestedOutcome =
    input.parentRequestedOutcome ?? "prepare a current crypto market brief";
  const parentTaskHash = canonicalJsonSha256({
    parent: parentRequestedOutcome,
    createdAt: input.createdAt,
  });
  return buildPaymentNeed({
    createdAt: input.createdAt,
    originType: "AGENT_TASK",
    originRef: "fixture:agent_task:crypto_news_subgoal",
    parentTaskId: `parent_${parentTaskHash.slice(0, 16)}`,
    parentTaskHash,
    parentRequestedOutcome,
    workflowId: null,
    workflowVersion: null,
    workflowStateHash: null,
    requiredStep: null,
    requestedOutcome: "obtain fresh crypto-news information",
    needEvidence: [
      {
        kind: "parent_task",
        ref: parentTaskHash,
        detail: parentRequestedOutcome,
      },
    ],
    constraints: { notes: [], preferredPriceAtomic: null },
    allowedCapabilities: ["crypto_news"],
    prohibitedCapabilities: ["chain_block_number"],
    preferredNetworkConstraints: ["eip155:8453"],
    preferredAssetConstraints: ["USDC", USDC],
    budgetCeiling: "1000",
    budgetAsset: USDC,
    urgency: "medium",
    informationFreshnessNeed: { kind: "max_age_ms", maxAgeMs: 3_600_000 },
    riskConstraints: [],
    needAuthorityClass: "DERIVED_TASK_NEED",
    lifecycleState: "ACTIVE",
    derivationRationale:
      "parent market-brief goal requires fresh crypto-news source as necessary sub-goal",
  });
}

export function buildInvalidDerivedAgentNeed(input: {
  readonly createdAt: string;
}): PaymentNeedV1 {
  const parentRequestedOutcome = "report current Ethereum block number";
  const parentTaskHash = canonicalJsonSha256({
    parent: parentRequestedOutcome,
    createdAt: input.createdAt,
  });
  return buildPaymentNeed({
    createdAt: input.createdAt,
    originType: "AGENT_TASK",
    originRef: "fixture:agent_task:invalid_crypto_from_block",
    parentTaskId: `parent_${parentTaskHash.slice(0, 16)}`,
    parentTaskHash,
    parentRequestedOutcome,
    workflowId: null,
    workflowVersion: null,
    workflowStateHash: null,
    requiredStep: null,
    requestedOutcome: "obtain crypto news",
    needEvidence: [
      { kind: "parent_task", ref: parentTaskHash, detail: parentRequestedOutcome },
    ],
    constraints: { notes: [], preferredPriceAtomic: null },
    allowedCapabilities: ["crypto_news"],
    prohibitedCapabilities: [],
    preferredNetworkConstraints: ["eip155:8453"],
    preferredAssetConstraints: ["USDC", USDC],
    budgetCeiling: "1000",
    budgetAsset: USDC,
    urgency: "medium",
    informationFreshnessNeed: { kind: "none" },
    riskConstraints: [],
    needAuthorityClass: "DERIVED_TASK_NEED",
    lifecycleState: "ACTIVE",
    derivationRationale: "unrelated commercial objective",
  });
}

export function buildSelfJustifiedCandidateNeed(input: {
  readonly createdAt: string;
  readonly candidateId: string;
}): PaymentNeedV1 {
  return buildPaymentNeed({
    createdAt: input.createdAt,
    originType: "AGENT_TASK",
    originRef: `candidate_discovery:${input.candidateId}`,
    parentTaskId: null,
    parentTaskHash: null,
    parentRequestedOutcome: null,
    workflowId: null,
    workflowVersion: null,
    workflowStateHash: null,
    requiredStep: null,
    requestedOutcome: "obtain crypto news",
    needEvidence: [
      {
        kind: "candidate_available",
        ref: input.candidateId,
        detail: "candidate discovered first; need invented after",
      },
    ],
    constraints: { notes: [], preferredPriceAtomic: null },
    allowedCapabilities: ["crypto_news"],
    prohibitedCapabilities: [],
    preferredNetworkConstraints: ["eip155:8453"],
    preferredAssetConstraints: ["USDC", USDC],
    budgetCeiling: "1000",
    budgetAsset: USDC,
    urgency: "medium",
    informationFreshnessNeed: { kind: "none" },
    riskConstraints: [],
    needAuthorityClass: "UNSUPPORTED_NEED",
    lifecycleState: "ACTIVE",
    derivationRationale: null,
  });
}

export function buildWorkflowBoundNeed(input: {
  readonly createdAt: string;
}): PaymentNeedV1 {
  const workflowStateHash = canonicalJsonSha256({
    workflow: "market_brief_v1",
    step: "fetch_crypto_news",
  });
  return buildPaymentNeed({
    createdAt: input.createdAt,
    originType: "WORKFLOW_REQUIREMENT",
    originRef: "workflow:market_brief_v1:fetch_crypto_news",
    parentTaskId: null,
    parentTaskHash: null,
    parentRequestedOutcome: null,
    workflowId: "market_brief_v1",
    workflowVersion: "1",
    workflowStateHash,
    requiredStep: "fetch_crypto_news",
    requestedOutcome: "obtain current crypto news for workflow step",
    needEvidence: [
      {
        kind: "workflow_required_step",
        ref: workflowStateHash,
        detail: "step fetch_crypto_news requires external crypto_news capability",
      },
    ],
    constraints: { notes: [], preferredPriceAtomic: null },
    allowedCapabilities: ["crypto_news"],
    prohibitedCapabilities: ["chain_block_number"],
    preferredNetworkConstraints: ["eip155:8453"],
    preferredAssetConstraints: ["USDC", USDC],
    budgetCeiling: "1000",
    budgetAsset: USDC,
    urgency: "medium",
    informationFreshnessNeed: { kind: "max_age_ms", maxAgeMs: 3_600_000 },
    riskConstraints: [],
    needAuthorityClass: "WORKFLOW_BOUND_NEED",
    lifecycleState: "ACTIVE",
    derivationRationale: null,
  });
}
