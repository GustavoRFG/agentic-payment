/**
 * buyer-payment-send-lifecycle — crash-safe one-shot payment send lifecycle.
 *
 * Before network invocation, atomically persist SEND_COMMITTED_NO_RETRY.
 * Once committed: no automatic retry/resend; ambiguous outcomes are terminal.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AMBIGUOUS_SEND_TERMINAL_RECONCILE,
  BLOCKED_B37_RESEND_AFTER_AMBIGUOUS_SEND,
  BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST,
  BLOCKED_B37_SEND_LIFECYCLE_INVALID,
  BLOCKED_B37_SEND_MANDATE_ALREADY_CONSUMED,
  GUARD_NO_RESEND_AFTER_AMBIGUOUS_SEND,
  GUARD_PAYMENT_SEND_ONE_SHOT_NO_RETRY,
} from "./b37-execution-gates";
import { writeArtifactOnce } from "./buyer-authorization-artifacts";

export const PAYMENT_SEND_LIFECYCLE_SCHEMA_VERSION =
  "trustforge_payment_send_lifecycle.v1" as const;

export const PAYMENT_SEND_LIFECYCLE_ARTIFACT = "buyer_payment_send_lifecycle.json" as const;

export type PaymentSendLifecycleState =
  | "SEND_AUTHORIZATION_DERIVED"
  | "SEND_COMMITTED_NO_RETRY"
  | "PAYMENT_REQUEST_INVOKED"
  | "RESPONSE_OBSERVED"
  | "AMBIGUOUS_SEND_TERMINAL_RECONCILE";

const LEGAL: Readonly<
  Record<PaymentSendLifecycleState, readonly PaymentSendLifecycleState[]>
> = {
  SEND_AUTHORIZATION_DERIVED: ["SEND_COMMITTED_NO_RETRY", "AMBIGUOUS_SEND_TERMINAL_RECONCILE"],
  SEND_COMMITTED_NO_RETRY: ["PAYMENT_REQUEST_INVOKED", "AMBIGUOUS_SEND_TERMINAL_RECONCILE"],
  PAYMENT_REQUEST_INVOKED: ["RESPONSE_OBSERVED", "AMBIGUOUS_SEND_TERMINAL_RECONCILE"],
  RESPONSE_OBSERVED: [],
  AMBIGUOUS_SEND_TERMINAL_RECONCILE: [],
};

export interface PaymentSendLifecycleRecord {
  readonly schema_version: typeof PAYMENT_SEND_LIFECYCLE_SCHEMA_VERSION;
  readonly send_authorization_sha256: string;
  readonly send_mandate_sha256: string;
  readonly attempt_id: string;
  readonly state: PaymentSendLifecycleState;
  readonly updated_at: string;
  readonly payment_bearing_request_count: number;
  readonly max_payment_bearing_requests: 1;
  readonly allow_retry: false;
  readonly allow_resend: false;
  readonly notes: string | null;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function assertTransition(from: PaymentSendLifecycleState, to: PaymentSendLifecycleState): void {
  if (!LEGAL[from].includes(to)) {
    fail(BLOCKED_B37_SEND_LIFECYCLE_INVALID, `illegal send lifecycle transition ${from} → ${to}`);
  }
}

export class BuyerPaymentSendLedger {
  private readonly records = new Map<string, PaymentSendLifecycleRecord>();

  constructor(seed?: readonly PaymentSendLifecycleRecord[]) {
    for (const record of seed ?? []) {
      this.records.set(record.send_authorization_sha256, record);
    }
  }

  get(sendAuthorizationSha256: string): PaymentSendLifecycleRecord | undefined {
    return this.records.get(sendAuthorizationSha256);
  }

  issueDerived(input: {
    readonly sendAuthorizationSha256: string;
    readonly sendMandateSha256: string;
    readonly attemptId: string;
    readonly now: Date;
  }): PaymentSendLifecycleRecord {
    if (this.records.has(input.sendAuthorizationSha256)) {
      fail(
        BLOCKED_B37_SEND_MANDATE_ALREADY_CONSUMED,
        "PaymentSendAuthorization lifecycle already exists",
      );
    }
    const record: PaymentSendLifecycleRecord = {
      schema_version: PAYMENT_SEND_LIFECYCLE_SCHEMA_VERSION,
      send_authorization_sha256: input.sendAuthorizationSha256,
      send_mandate_sha256: input.sendMandateSha256,
      attempt_id: input.attemptId,
      state: "SEND_AUTHORIZATION_DERIVED",
      updated_at: input.now.toISOString(),
      payment_bearing_request_count: 0,
      max_payment_bearing_requests: 1,
      allow_retry: false,
      allow_resend: false,
      notes: null,
    };
    this.records.set(input.sendAuthorizationSha256, record);
    return record;
  }

  commitNoRetry(input: {
    readonly sendAuthorizationSha256: string;
    readonly now: Date;
  }): PaymentSendLifecycleRecord {
    const existing = this.require(input.sendAuthorizationSha256);
    assertTransition(existing.state, "SEND_COMMITTED_NO_RETRY");
    const next: PaymentSendLifecycleRecord = {
      ...existing,
      state: "SEND_COMMITTED_NO_RETRY",
      updated_at: input.now.toISOString(),
      notes: "SEND_COMMITTED_NO_RETRY persisted before network invocation",
    };
    this.records.set(input.sendAuthorizationSha256, next);
    return next;
  }

  markInvoked(input: {
    readonly sendAuthorizationSha256: string;
    readonly now: Date;
  }): PaymentSendLifecycleRecord {
    const existing = this.require(input.sendAuthorizationSha256);
    if (existing.state === "AMBIGUOUS_SEND_TERMINAL_RECONCILE") {
      fail(
        GUARD_NO_RESEND_AFTER_AMBIGUOUS_SEND,
        `${BLOCKED_B37_RESEND_AFTER_AMBIGUOUS_SEND}: ambiguous send is terminal`,
      );
    }
    if (existing.state === "PAYMENT_REQUEST_INVOKED" || existing.state === "RESPONSE_OBSERVED") {
      fail(
        GUARD_PAYMENT_SEND_ONE_SHOT_NO_RETRY,
        `${BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST}: second payment-bearing request blocked`,
      );
    }
    assertTransition(existing.state, "PAYMENT_REQUEST_INVOKED");
    if (existing.payment_bearing_request_count >= 1) {
      fail(
        GUARD_PAYMENT_SEND_ONE_SHOT_NO_RETRY,
        `${BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST}: max_payment_bearing_requests=1`,
      );
    }
    const next: PaymentSendLifecycleRecord = {
      ...existing,
      state: "PAYMENT_REQUEST_INVOKED",
      payment_bearing_request_count: 1,
      updated_at: input.now.toISOString(),
    };
    this.records.set(input.sendAuthorizationSha256, next);
    return next;
  }

  markResponseObserved(input: {
    readonly sendAuthorizationSha256: string;
    readonly now: Date;
    readonly notes?: string;
  }): PaymentSendLifecycleRecord {
    const existing = this.require(input.sendAuthorizationSha256);
    assertTransition(existing.state, "RESPONSE_OBSERVED");
    const next: PaymentSendLifecycleRecord = {
      ...existing,
      state: "RESPONSE_OBSERVED",
      updated_at: input.now.toISOString(),
      notes: input.notes ?? existing.notes,
    };
    this.records.set(input.sendAuthorizationSha256, next);
    return next;
  }

  markAmbiguous(input: {
    readonly sendAuthorizationSha256: string;
    readonly now: Date;
    readonly reason: string;
  }): PaymentSendLifecycleRecord {
    const existing = this.require(input.sendAuthorizationSha256);
    if (
      existing.state === "AMBIGUOUS_SEND_TERMINAL_RECONCILE" ||
      existing.state === "RESPONSE_OBSERVED"
    ) {
      fail(
        BLOCKED_B37_SEND_LIFECYCLE_INVALID,
        `cannot mark ambiguous from terminal state ${existing.state}`,
      );
    }
    assertTransition(existing.state, "AMBIGUOUS_SEND_TERMINAL_RECONCILE");
    const next: PaymentSendLifecycleRecord = {
      ...existing,
      state: "AMBIGUOUS_SEND_TERMINAL_RECONCILE",
      updated_at: input.now.toISOString(),
      notes: `${AMBIGUOUS_SEND_TERMINAL_RECONCILE}:${input.reason}`,
    };
    this.records.set(input.sendAuthorizationSha256, next);
    return next;
  }

  assertMayInvoke(sendAuthorizationSha256: string): void {
    const existing = this.require(sendAuthorizationSha256);
    if (existing.state === "AMBIGUOUS_SEND_TERMINAL_RECONCILE") {
      fail(
        GUARD_NO_RESEND_AFTER_AMBIGUOUS_SEND,
        `${BLOCKED_B37_RESEND_AFTER_AMBIGUOUS_SEND}: no resend after ambiguous send`,
      );
    }
    if (existing.state !== "SEND_COMMITTED_NO_RETRY") {
      fail(
        BLOCKED_B37_SEND_LIFECYCLE_INVALID,
        `payment request requires SEND_COMMITTED_NO_RETRY; current=${existing.state}`,
      );
    }
    if (existing.payment_bearing_request_count !== 0) {
      fail(
        GUARD_PAYMENT_SEND_ONE_SHOT_NO_RETRY,
        `${BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST}: already invoked`,
      );
    }
  }

  private require(sendAuthorizationSha256: string): PaymentSendLifecycleRecord {
    const existing = this.get(sendAuthorizationSha256);
    if (!existing) {
      fail(BLOCKED_B37_SEND_LIFECYCLE_INVALID, "send lifecycle record missing");
    }
    return existing;
  }
}

export function persistPaymentSendLifecycle(
  directory: string,
  record: PaymentSendLifecycleRecord,
): { readonly path: string; readonly sha256: string } {
  return writeArtifactOnce(join(directory, PAYMENT_SEND_LIFECYCLE_ARTIFACT), record);
}

export function loadPaymentSendLifecycle(
  directory: string,
): PaymentSendLifecycleRecord | null {
  const path = join(directory, PAYMENT_SEND_LIFECYCLE_ARTIFACT);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as PaymentSendLifecycleRecord;
}

/**
 * Crash/restart evaluation: any intermediate committed/invoked state without
 * RESPONSE_OBSERVED is treated as AMBIGUOUS_SEND_TERMINAL_RECONCILE.
 */
export function evaluatePaymentSendCrashRecovery(input: {
  readonly record: PaymentSendLifecycleRecord | null;
}): {
  readonly disposition: "RESUME_NOT_ALLOWED" | "CLEAN" | typeof AMBIGUOUS_SEND_TERMINAL_RECONCILE;
  readonly may_retry: false;
  readonly may_resend: false;
  readonly reason: string;
} {
  if (!input.record) {
    return {
      disposition: "CLEAN",
      may_retry: false,
      may_resend: false,
      reason: "no send lifecycle persisted",
    };
  }
  const state = input.record.state;
  if (state === "RESPONSE_OBSERVED") {
    return {
      disposition: "RESUME_NOT_ALLOWED",
      may_retry: false,
      may_resend: false,
      reason: "response already observed; one-shot complete",
    };
  }
  if (state === "AMBIGUOUS_SEND_TERMINAL_RECONCILE") {
    return {
      disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE,
      may_retry: false,
      may_resend: false,
      reason: "already terminal ambiguous",
    };
  }
  if (state === "SEND_AUTHORIZATION_DERIVED") {
    return {
      disposition: "CLEAN",
      may_retry: false,
      may_resend: false,
      reason: "derived but not committed; may continue to commit once",
    };
  }
  // SEND_COMMITTED_NO_RETRY or PAYMENT_REQUEST_INVOKED after crash → ambiguous.
  return {
    disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE,
    may_retry: false,
    may_resend: false,
    reason: `crash/restart with state ${state}; no automatic retry`,
  };
}

export type SyntheticPaymentTransportOutcome =
  | { readonly kind: "ok"; readonly status: number; readonly body: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "connection_reset" }
  | { readonly kind: "malformed_response" }
  | { readonly kind: "response_lost_after_possible_receipt" }
  | { readonly kind: "crash_before_fetch" }
  | { readonly kind: "crash_after_invoke" };

/** In-memory synthetic payment transport — never performs live HTTP. */
export class SyntheticPaymentBearingTransport {
  private invocations = 0;

  constructor(
    private readonly outcome: SyntheticPaymentTransportOutcome = {
      kind: "ok",
      status: 200,
      body: '{"synthetic":true}',
    },
  ) {}

  get invocationCount(): number {
    return this.invocations;
  }

  async invokeOnce(input: {
    readonly ledger: BuyerPaymentSendLedger;
    readonly sendAuthorizationSha256: string;
    readonly now: Date;
  }): Promise<{
    readonly outcome: SyntheticPaymentTransportOutcome;
    readonly disposition: "RESPONSE_OBSERVED" | typeof AMBIGUOUS_SEND_TERMINAL_RECONCILE;
  }> {
    input.ledger.assertMayInvoke(input.sendAuthorizationSha256);

    if (this.outcome.kind === "crash_before_fetch") {
      // Committed but never invoked — crash recovery treats as ambiguous if
      // restart sees COMMITTED; here we mark ambiguous immediately for proof.
      input.ledger.markAmbiguous({
        sendAuthorizationSha256: input.sendAuthorizationSha256,
        now: input.now,
        reason: "crash_before_fetch",
      });
      return { outcome: this.outcome, disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE };
    }

    input.ledger.markInvoked({
      sendAuthorizationSha256: input.sendAuthorizationSha256,
      now: input.now,
    });
    this.invocations += 1;

    if (this.outcome.kind === "crash_after_invoke") {
      input.ledger.markAmbiguous({
        sendAuthorizationSha256: input.sendAuthorizationSha256,
        now: input.now,
        reason: "crash_after_invoke",
      });
      return { outcome: this.outcome, disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE };
    }
    if (
      this.outcome.kind === "timeout" ||
      this.outcome.kind === "connection_reset" ||
      this.outcome.kind === "malformed_response" ||
      this.outcome.kind === "response_lost_after_possible_receipt"
    ) {
      input.ledger.markAmbiguous({
        sendAuthorizationSha256: input.sendAuthorizationSha256,
        now: input.now,
        reason: this.outcome.kind,
      });
      return { outcome: this.outcome, disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE };
    }

    input.ledger.markResponseObserved({
      sendAuthorizationSha256: input.sendAuthorizationSha256,
      now: input.now,
      notes: `synthetic_http_${this.outcome.status}`,
    });
    return { outcome: this.outcome, disposition: "RESPONSE_OBSERVED" };
  }
}
