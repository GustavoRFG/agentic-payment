import { describe, expect, it } from "vitest";

import {
  isThinRunnerSettleableMethod,
  planThinSettleRequest,
  THIN_RUNNER_SETTLEABLE_METHODS,
} from "../../tools/trustforge/thin-settlement-request-plan";
import { REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER } from "../../tools/trustforge/thin-settlement-method-contract";

const ENDPOINT = "https://seller.example/api/upload";
const BODY = { tx: "0xabc", chain: "base" };

describe("isThinRunnerSettleableMethod", () => {
  it("accepts POST and GET (any case); rejects everything else and empty", () => {
    expect(THIN_RUNNER_SETTLEABLE_METHODS).toEqual(["POST", "GET"]);
    expect(isThinRunnerSettleableMethod("POST")).toBe(true);
    expect(isThinRunnerSettleableMethod("get")).toBe(true);
    for (const m of ["PUT", "PATCH", "DELETE", "HEAD", "", null, undefined]) {
      expect(isThinRunnerSettleableMethod(m)).toBe(false);
    }
  });
});

describe("planThinSettleRequest", () => {
  it("defaults to POST when no catalog method (preserves today's behavior exactly)", () => {
    const plan = planThinSettleRequest({ endpoint: ENDPOINT, body: BODY });
    expect(plan).toEqual({
      supported: true,
      method: "POST",
      endpoint: ENDPOINT,
      body: BODY,
      sendBody: true,
    });
  });

  it("POST carries the JSON body at the endpoint unchanged", () => {
    const plan = planThinSettleRequest({ method: " post ", endpoint: ENDPOINT, body: BODY });
    expect(plan).toMatchObject({ supported: true, method: "POST", endpoint: ENDPOINT, body: BODY, sendBody: true });
  });

  it("GET carries no body and moves params to the query string", () => {
    const plan = planThinSettleRequest({ method: "GET", endpoint: ENDPOINT, body: BODY });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.method).toBe("GET");
    expect(plan.sendBody).toBe(false);
    expect(plan.body).toBeUndefined();
    const url = new URL(plan.endpoint);
    expect(url.searchParams.get("tx")).toBe("0xabc");
    expect(url.searchParams.get("chain")).toBe("base");
  });

  it("GET merges into an endpoint that already has a query string", () => {
    const plan = planThinSettleRequest({
      method: "get",
      endpoint: "https://seller.example/api?v=1",
      body: { tx: "0xabc" },
    });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    const url = new URL(plan.endpoint);
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get("tx")).toBe("0xabc");
  });

  it("GET with no body params leaves the endpoint unchanged", () => {
    const plan = planThinSettleRequest({ method: "GET", endpoint: ENDPOINT, body: {} });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.endpoint).toBe(ENDPOINT);
  });

  for (const method of ["PUT", "PATCH", "DELETE", "HEAD"]) {
    it(`gates ${method} as not settleable (no payment)`, () => {
      const plan = planThinSettleRequest({ method, endpoint: ENDPOINT, body: BODY });
      expect(plan.supported).toBe(false);
      if (plan.supported) return;
      expect(plan.method).toBe(method);
      expect(plan.reason).toContain(REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER);
    });
  }
});
