/**
 * buyer-authorization-state-machine — the legal order of a single buyer
 * authorization attempt.
 *
 * The order is the safety property. An unsigned payload must be on disk before a
 * signer is ever called, so a crash can never leave a signature whose attempt was
 * never recorded; and once a signature exists, the only way out without a send is
 * abandonment, because a signature that can be picked up later is a second
 * payment waiting to happen.
 *
 * B.2 implements up to SIGNED_PERSISTED. The send states exist so the shape is
 * complete and so tests can assert that nothing reaches them yet.
 */

export const BUYER_AUTHORIZATION_STATE_SCHEMA_VERSION =
  "trustforge_buyer_authorization_state_v0.1.0" as const;

export const BUYER_AUTHORIZATION_STATES = [
  "RESERVED",
  "UNSIGNED_PERSISTED",
  "SIGNED_PERSISTED",
  "TERMINAL_ABANDONED_REAUTHORIZE",
  "SEND_COMMITTED_NO_RETRY",
  "RESPONSE_PERSISTED",
] as const;

export type BuyerAuthorizationState = (typeof BUYER_AUTHORIZATION_STATES)[number];

/** States B.2 is allowed to reach. Anything else is a later, separate phase. */
export const B2_REACHABLE_STATES: readonly BuyerAuthorizationState[] = [
  "RESERVED",
  "UNSIGNED_PERSISTED",
  "SIGNED_PERSISTED",
  "TERMINAL_ABANDONED_REAUTHORIZE",
];

export const B2_FORBIDDEN_STATES: readonly BuyerAuthorizationState[] = [
  "SEND_COMMITTED_NO_RETRY",
  "RESPONSE_PERSISTED",
];

export const BLOCKED_BUYER_AUTHORIZATION_ILLEGAL_TRANSITION =
  "BLOCKED_BUYER_AUTHORIZATION_ILLEGAL_TRANSITION" as const;
export const BLOCKED_BUYER_AUTHORIZATION_SEND_NOT_IMPLEMENTED =
  "BLOCKED_BUYER_AUTHORIZATION_SEND_NOT_IMPLEMENTED" as const;
export const BLOCKED_BUYER_AUTHORIZATION_RESUME_FORBIDDEN =
  "BLOCKED_BUYER_AUTHORIZATION_RESUME_FORBIDDEN" as const;

const LEGAL_TRANSITIONS: Readonly<Record<BuyerAuthorizationState, readonly BuyerAuthorizationState[]>> = {
  RESERVED: ["UNSIGNED_PERSISTED", "TERMINAL_ABANDONED_REAUTHORIZE"],
  UNSIGNED_PERSISTED: ["SIGNED_PERSISTED", "TERMINAL_ABANDONED_REAUTHORIZE"],
  // A signed attempt may only be sent once, or abandoned. It may never be
  // resumed later: the signature is already a bearer instrument.
  SIGNED_PERSISTED: ["SEND_COMMITTED_NO_RETRY", "TERMINAL_ABANDONED_REAUTHORIZE"],
  SEND_COMMITTED_NO_RETRY: ["RESPONSE_PERSISTED", "TERMINAL_ABANDONED_REAUTHORIZE"],
  RESPONSE_PERSISTED: [],
  TERMINAL_ABANDONED_REAUTHORIZE: [],
};

export function isTerminalState(state: BuyerAuthorizationState): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}

export function legalNextStates(
  state: BuyerAuthorizationState,
): readonly BuyerAuthorizationState[] {
  return LEGAL_TRANSITIONS[state];
}

export function assertLegalTransition(
  from: BuyerAuthorizationState,
  to: BuyerAuthorizationState,
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(
      `${BLOCKED_BUYER_AUTHORIZATION_ILLEGAL_TRANSITION}: ${from} -> ${to} is not a legal buyer authorization transition`,
    );
  }
}

/**
 * B.2 may not enter a send state. Kept as an explicit gate rather than an
 * omission, so a later phase has to remove something deliberately.
 */
export function assertReachableInB2(state: BuyerAuthorizationState): void {
  if (B2_FORBIDDEN_STATES.includes(state)) {
    throw new Error(
      `${BLOCKED_BUYER_AUTHORIZATION_SEND_NOT_IMPLEMENTED}: state ${state} belongs to the send phase, which B.2 does not implement`,
    );
  }
}

/**
 * Anything that ends after SIGNED_PERSISTED without a committed send abandons.
 * There is no "resume and send later".
 */
export function terminalStateForUnsentAttempt(
  state: BuyerAuthorizationState,
): BuyerAuthorizationState {
  if (state === "SEND_COMMITTED_NO_RETRY" || state === "RESPONSE_PERSISTED") {
    return state;
  }
  return "TERMINAL_ABANDONED_REAUTHORIZE";
}

export function assertNotResumableForSend(state: BuyerAuthorizationState): never {
  throw new Error(
    `${BLOCKED_BUYER_AUTHORIZATION_RESUME_FORBIDDEN}: a ${state} attempt cannot be resumed for send; reauthorization, a new attempt id, a new nonce, a fresh observation and a new signature are required`,
  );
}

/**
 * The future send seam. Declared so the shape is agreed; deliberately not
 * implemented and deliberately not wired to any runner in this phase.
 */
export interface PaymentBearingSender {
  sendSignedAttempt(input: {
    readonly attemptId: string;
    readonly signedArtifactPath: string;
  }): Promise<never>;
}
