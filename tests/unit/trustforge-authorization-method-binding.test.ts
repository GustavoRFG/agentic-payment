/**
 * Pre-live gate: authorization.method == selected_candidate.method == planned.method
 * == intent-bound method.
 *
 * Pure unit tests. No key is loaded, nothing is signed, no payment header is built,
 * and no live endpoint is contacted.
 */
import { describe, expect, it } from "vitest";

import {
  assertAuthorizationMethodBinding,
  checkAuthorizationMethodBinding,
  BLOCKED_AUTHORIZATION_METHOD_MISMATCH,
  BLOCKED_AUTHORIZATION_METHOD_MISSING,
  BLOCKED_AUTHORIZATION_METHOD_UNSUPPORTED,
  BLOCKED_INTENT_METHOD_MISMATCH,
} from "../../tools/trustforge/authorization-method-binding";

describe("authorization method binding", () => {
  it.each(["POST", "GET"])("binds %s when every method in the chain agrees", (method) => {
    const result = checkAuthorizationMethodBinding({
      authorizationMethod: method,
      candidateMethod: method,
      plannedMethod: method,
      intentMethod: method,
    });
    expect(result.bound).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.evidence).toMatchObject({
      authorization_method: method,
      selected_candidate_method: method,
      planned_method: method,
      intent_method: method,
      bound_method: method,
    });
  });

  it("normalizes case and whitespace before comparing", () => {
    expect(
      checkAuthorizationMethodBinding({
        authorizationMethod: " get ",
        candidateMethod: "GET",
        plannedMethod: "GET",
        intentMethod: "GET",
      }).bound,
    ).toBe(true);
  });

  it("blocks a missing authorization method instead of assuming POST", () => {
    for (const missing of [undefined, null, "", "   "]) {
      const result = checkAuthorizationMethodBinding({
        authorizationMethod: missing,
        candidateMethod: "POST",
      });
      expect(result.bound).toBe(false);
      expect(result.reasons.join(" ")).toContain(BLOCKED_AUTHORIZATION_METHOD_MISSING);
    }
  });

  it.each(["PUT", "PATCH", "DELETE", "HEAD"])("blocks unsupported authorized %s", (method) => {
    const result = checkAuthorizationMethodBinding({
      authorizationMethod: method,
      candidateMethod: method,
    });
    expect(result.bound).toBe(false);
    expect(result.reasons.join(" ")).toContain(BLOCKED_AUTHORIZATION_METHOD_UNSUPPORTED);
  });

  it.each([
    ["POST", "GET"],
    ["GET", "POST"],
  ])("blocks authorization %s against candidate %s", (authorized, candidate) => {
    const result = checkAuthorizationMethodBinding({
      authorizationMethod: authorized,
      candidateMethod: candidate,
    });
    expect(result.bound).toBe(false);
    expect(result.reasons.join(" ")).toContain(BLOCKED_AUTHORIZATION_METHOD_MISMATCH);
  });

  it("blocks when the planner disagrees with the authorization", () => {
    const result = checkAuthorizationMethodBinding({
      authorizationMethod: "GET",
      candidateMethod: "GET",
      plannedMethod: "POST",
    });
    expect(result.bound).toBe(false);
    expect(result.reasons.join(" ")).toContain("!= planned method POST");
  });

  it("blocks when the persisted intent disagrees with the authorization", () => {
    const result = checkAuthorizationMethodBinding({
      authorizationMethod: "GET",
      candidateMethod: "GET",
      plannedMethod: "GET",
      intentMethod: "POST",
    });
    expect(result.bound).toBe(false);
    expect(result.reasons.join(" ")).toContain(BLOCKED_INTENT_METHOD_MISMATCH);
  });

  it("keeps the historical POST default for a candidate with no declared method", () => {
    expect(
      checkAuthorizationMethodBinding({ authorizationMethod: "POST", candidateMethod: null }).bound,
    ).toBe(true);
    const wrong = checkAuthorizationMethodBinding({
      authorizationMethod: "GET",
      candidateMethod: null,
    });
    expect(wrong.bound).toBe(false);
    expect(wrong.reasons.join(" ")).toContain(BLOCKED_AUTHORIZATION_METHOD_MISMATCH);
  });

  it("throws on the asserting form and returns evidence when bound", () => {
    expect(() =>
      assertAuthorizationMethodBinding({ authorizationMethod: "POST", candidateMethod: "GET" }),
    ).toThrow(BLOCKED_AUTHORIZATION_METHOD_MISMATCH);
    expect(
      assertAuthorizationMethodBinding({
        authorizationMethod: "GET",
        candidateMethod: "GET",
        plannedMethod: "GET",
      }).bound_method,
    ).toBe("GET");
  });
});
