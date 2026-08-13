/**
 * b5-candidate-pipeline — discover → normalize → policy → select → ledger.
 * Stops before human approval / payment.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT,
  GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED,
} from "./b5-execution-gates";
import {
  discoverAndNormalize,
  type PaymentCandidateDiscovery,
} from "./payment-candidate-discovery";
import {
  assessPaymentCandidateEconomics,
} from "./payment-candidate-economics";
import {
  evaluatePaymentCandidatePolicy,
  type B5CandidatePolicyConfig,
} from "./payment-candidate-policy";
import {
  buildB5HumanApprovalPresentation,
  type B5HumanApprovalPresentation,
} from "./payment-candidate-human-view";
import {
  emptyPaymentCandidateLedger,
  persistPaymentCandidateLedger,
  recordNormalizedCandidates,
  recordPolicyAndAssessment,
  recordSelection,
  type PaymentCandidateLedger,
} from "./payment-candidate-ledger";
import {
  selectPaymentCandidate,
  type PaymentCandidateSelection,
} from "./payment-candidate-selection";
import type { PaymentCandidateV1 } from "./payment-candidate-v1";

export interface B5CandidatePipelineResult {
  readonly candidates: readonly PaymentCandidateV1[];
  readonly selection: PaymentCandidateSelection;
  readonly ledger: PaymentCandidateLedger;
  readonly human_presentation: B5HumanApprovalPresentation;
  readonly payment_authorized: false;
}

export async function runB5CandidatePipeline(input: {
  readonly discoveries: readonly PaymentCandidateDiscovery[];
  readonly directory?: string;
  readonly buyer_wallet: string;
  readonly policy?: B5CandidatePolicyConfig;
  readonly now?: Date;
}): Promise<B5CandidatePipelineResult> {
  void GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT;
  void GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED;
  const now = input.now ?? new Date();
  const candidates: PaymentCandidateV1[] = [];
  for (const d of input.discoveries) {
    const batch = await discoverAndNormalize(d);
    candidates.push(...batch);
  }

  let ledger = emptyPaymentCandidateLedger();
  ledger = recordNormalizedCandidates(ledger, candidates, now);
  for (const c of candidates) {
    const verdict = evaluatePaymentCandidatePolicy(c, {
      policy: input.policy,
      now,
    });
    const assessment = assessPaymentCandidateEconomics(c, verdict, { now });
    ledger = recordPolicyAndAssessment(ledger, c, verdict, assessment, now);
  }

  const selection = selectPaymentCandidate(candidates, {
    policy: input.policy,
    now,
  });
  ledger = recordSelection(ledger, selection, now);
  const human_presentation = buildB5HumanApprovalPresentation(
    selection,
    input.buyer_wallet,
  );

  if (input.directory) {
    mkdirSync(input.directory, { recursive: true });
    writeFileSync(
      join(input.directory, "payment_candidates.json"),
      `${JSON.stringify(candidates, null, 2)}\n`,
    );
    writeFileSync(
      join(input.directory, "payment_candidate_selection.json"),
      `${JSON.stringify(
        {
          ...selection,
          selected_candidate: {
            ...selection.selected_candidate,
            execution_selected_candidate: selection.selected_candidate
              .execution_selected_candidate
              ? {
                  schema_version:
                    selection.selected_candidate.execution_selected_candidate
                      .schema_version,
                  service_id:
                    selection.selected_candidate.execution_selected_candidate
                      .service_id,
                  endpoint:
                    selection.selected_candidate.execution_selected_candidate
                      .endpoint,
                }
              : null,
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(input.directory, "b5_human_approval_presentation.json"),
      `${JSON.stringify(human_presentation, null, 2)}\n`,
    );
    persistPaymentCandidateLedger(input.directory, ledger);
  }

  return {
    candidates,
    selection,
    ledger,
    human_presentation,
    payment_authorized: false,
  };
}
