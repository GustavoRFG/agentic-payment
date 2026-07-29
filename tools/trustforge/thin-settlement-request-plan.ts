/**
 * thin-settlement-request-plan — A.2 core: method-aware paid-request shaping.
 *
 * Pure, side-effect-free planner (no key, no wallet, no network, no payment) that
 * turns a selected candidate's catalog method into the shape the paid settle
 * request should take. It is the reviewable, tested component of A.2; wiring it
 * into the money-moving executor (x402-thin-settlement-executor.ts) is the
 * deliberate human-review step completed in A.2.
 *
 * Enabled verbs (spec §37): POST and GET only. PUT/PATCH/DELETE/HEAD stay gated
 * until reviewed per-method, so a non-settleable method returns supported:false and
 * the caller must not settle.
 *
 * Verb/body handling (spec §28):
 *   - POST carries the JSON body at the endpoint.
 *   - GET carries no body; required parameters move to the query string (mirroring
 *     the keyless GET handshake).
 */

export {
  isThinRunnerSettleableMethod,
  normalizeThinSettlementMethod,
  planThinSettleRequest,
  REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER,
  THIN_RUNNER_SETTLEABLE_METHODS,
} from "./thin-settlement-method-contract";
export type {
  ThinRunnerSettleableMethod,
  ThinSettleRequestPlan,
} from "./thin-settlement-method-contract";
