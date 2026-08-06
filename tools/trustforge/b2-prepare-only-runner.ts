/**
 * b2-prepare-only-runner — productive prepare path behind activation policy.
 *
 * Stops at BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED. Does not read wallet env,
 * create payment headers, fetch live 402, or send.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadB2ActivationPolicy,
  type B2ActivationPolicy,
} from "./b2-activation-policy";
import {
  BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING,
  BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED,
} from "./b2-execution-gates";
import {
  BuyerAttemptRegistry,
  cryptoBuyerNonceSource,
  runBuyerAuthorizationPrepareOnly,
  type BuyerAuthorizationPrepareOnlyResult,
  type BuyerNonceSource,
} from "./buyer-authorization-attempt";
import type { PreparedAuthorizationInput } from "./buyer-eip3009-authorization";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";
import type { SellerRequirementsObservation } from "./x402-seller-requirements-binding";

export interface B2PrepareOnlyRunInput {
  readonly runDir: string;
  readonly attemptDir: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly commitSha?: string | null;
  readonly now?: Date;
  readonly policyPath?: string;
  readonly cwd?: string;
  readonly nonceSource?: BuyerNonceSource;
  /** Injected fresh observation — live unsigned 402 is not performed here. */
  readonly paytimeObservation: SellerRequirementsObservation;
  readonly registry?: BuyerAttemptRegistry;
}

export interface B2PrepareOnlyRunResult {
  readonly ok: false;
  readonly blocker: string;
  readonly detail: string;
  readonly policy: B2ActivationPolicy | null;
  readonly prepare: BuyerAuthorizationPrepareOnlyResult | null;
  readonly payment_bearing_request_count: 0;
  readonly real_signer_invoked: false;
  readonly sent: false;
}

function readJsonFile<T>(path: string, label: string): T {
  if (!existsSync(path)) {
    throw new Error(
      `${BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING}: ${label} missing at ${path}`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function buildPreparedAuthorizationFromRunArtifacts(input: {
  readonly human: HumanPaymentAuthorization;
  readonly selected: DiscoveredSelectedCandidate;
  readonly paytimeObservation: SellerRequirementsObservation;
  readonly signingTime: Date;
}): Omit<PreparedAuthorizationInput, "nonce"> {
  const human = input.human;
  const selected = input.selected;
  const requirementsSha =
    human.canonical_requirements_sha256 ??
    selected.canonical_requirements_sha256 ??
    null;
  const envelopeSha =
    human.canonical_envelope_sha256 ?? selected.canonical_envelope_sha256 ?? null;
  const requestBindingSha =
    human.request_binding_sha256 ?? selected.request_binding_sha256 ?? null;
  if (!requirementsSha || !envelopeSha || !requestBindingSha) {
    throw new Error(
      `${BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING}: authorization/candidate missing exact requirements, envelope, or request-binding hashes`,
    );
  }
  if (!human.method || !selected.method) {
    throw new Error(
      `${BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING}: authorized method is required`,
    );
  }
  if (!human.buyer_wallet && !selected.buyer_wallet) {
    throw new Error(
      `${BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING}: buyer wallet is required`,
    );
  }
  return {
    humanAuthorization: human,
    paytimeObservation: input.paytimeObservation,
    authorizedRequirementsSha256: requirementsSha,
    authorizedEnvelopeSha256: envelopeSha,
    authorizedRequestBindingSha256: requestBindingSha,
    authorizedEndpoint: human.endpoint,
    authorizedMethod: human.method,
    buyerAddress: human.buyer_wallet ?? selected.buyer_wallet,
    signingTime: input.signingTime,
  };
}

/**
 * Productive prepare-only entry. Requires activation policy + concrete human
 * authorization + injected fresh observation. Never signs or sends.
 */
export function runB2PrepareOnly(input: B2PrepareOnlyRunInput): B2PrepareOnlyRunResult {
  let policy: B2ActivationPolicy | null = null;
  try {
    policy = loadB2ActivationPolicy(input.policyPath, input.cwd);
    const human = readJsonFile<HumanPaymentAuthorization>(
      join(input.runDir, "human_payment_authorization.json"),
      "human payment authorization",
    );
    const selected = readJsonFile<DiscoveredSelectedCandidate>(
      join(input.runDir, "selected_candidate.json"),
      "selected candidate",
    );
    const now = input.now ?? new Date();
    const prepared = buildPreparedAuthorizationFromRunArtifacts({
      human,
      selected,
      paytimeObservation: input.paytimeObservation,
      signingTime: now,
    });
    const registry = input.registry ?? new BuyerAttemptRegistry(1);
    const prepare = runBuyerAuthorizationPrepareOnly({
      directory: input.attemptDir,
      runId: input.runId,
      attemptId: input.attemptId,
      commitSha: input.commitSha ?? null,
      registry,
      nonceSource: input.nonceSource ?? cryptoBuyerNonceSource,
      now,
      prepared,
    });
    return {
      ok: false,
      blocker: BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED,
      detail:
        "unsigned buyer authorization persisted; real signer, payment header, and send remain unauthorized",
      policy,
      prepare,
      payment_bearing_request_count: 0,
      real_signer_invoked: false,
      sent: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocker = message.split(":")[0] ?? "BLOCKED_B2_PREPARE_FAILED";
    return {
      ok: false,
      blocker,
      detail: message,
      policy,
      prepare: null,
      payment_bearing_request_count: 0,
      real_signer_invoked: false,
      sent: false,
    };
  }
}
