import { MAX_PAYMENT_ATTEMPTS } from "../../shared/payment-safety";

export interface PaidInvocationGuard {
  assertNext(): number;
  getAttempts(): number;
}

export function createPaidInvocationGuard(
  maxAttempts = MAX_PAYMENT_ATTEMPTS,
): PaidInvocationGuard {
  let attempts = 0;

  return {
    assertNext(): number {
      attempts += 1;

      if (attempts > maxAttempts) {
        throw new Error("refusing more than one controlled payment invocation");
      }

      return attempts;
    },

    getAttempts(): number {
      return attempts;
    },
  };
}
