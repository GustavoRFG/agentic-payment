/**
 * b5-run-thin-mainnet-from-selection — only allowed B5 → B4 execution entry.
 *
 * B5 modules must not call signer/send/PSA directly.
 */

import {
  GUARD_B5_REQUIRES_HUMAN_DECISION_FOR_REAL_PAYMENT,
  GUARD_B5_REQUIRES_SELECTED_CANDIDATE,
} from "./b5-execution-gates";
import {
  assertB5CannotTouchPaymentCore,
  selectedPaymentCandidateToDiscovered,
} from "./b5-selected-candidate-bridge";
import type { PaymentCandidateSelection } from "./payment-candidate-selection";
import {
  runThinMainnetPayment,
  type ThinMainnetPaymentRunnerInput,
  type ThinMainnetPaymentRunnerResult,
} from "./thin-mainnet-payment-runner";

export async function runThinMainnetPaymentFromB5Selection(
  input: Omit<ThinMainnetPaymentRunnerInput, "selected"> & {
    readonly selection: PaymentCandidateSelection;
  },
): Promise<ThinMainnetPaymentRunnerResult> {
  void GUARD_B5_REQUIRES_SELECTED_CANDIDATE;
  void GUARD_B5_REQUIRES_HUMAN_DECISION_FOR_REAL_PAYMENT;
  assertB5CannotTouchPaymentCore();
  const { selection, ...rest } = input;
  const selected = selectedPaymentCandidateToDiscovered(selection);
  return runThinMainnetPayment({
    ...rest,
    selected,
    b5_selection_id: selection.selection_id,
  });
}
