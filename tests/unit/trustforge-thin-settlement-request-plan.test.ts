import { describe, expect, it } from "vitest";

import {
  isThinRunnerSettleableMethod,
  planThinSettleRequest,
  THIN_RUNNER_SETTLEABLE_METHODS,
} from "../../tools/trustforge/thin-settlement-request-plan";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";

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
  function binding(method: "GET" | "POST", query: unknown, body: unknown) {
    return createThinSettlementRequestBinding({
      endpoint: ENDPOINT,
      method,
      input_status: "known",
      query,
      body,
    });
  }

  it("fails closed when no persisted request binding is provided", () => {
    expect(() => planThinSettleRequest({} as never)).toThrow(
      "REJECTED_REQUEST_BINDING_NOT_PERSISTED",
    );
  });

  it("POST carries the JSON body at the endpoint unchanged", () => {
    const plan = planThinSettleRequest({ requestBinding: binding("POST", [], BODY) });
    expect(plan).toMatchObject({ supported: true, method: "POST", endpoint: ENDPOINT, body: BODY, sendBody: true });
  });

  it("GET carries no body and moves params to the query string", () => {
    const plan = planThinSettleRequest({ requestBinding: binding("GET", BODY, null) });
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
      requestBinding: createThinSettlementRequestBinding({
        method: "GET",
        endpoint: "https://seller.example/api?v=1",
        input_status: "known",
        query: { tx: "0xabc" },
        body: null,
      }),
    });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    const url = new URL(plan.endpoint);
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get("tx")).toBe("0xabc");
  });

  it("GET with no body params leaves the endpoint unchanged", () => {
    const plan = planThinSettleRequest({ requestBinding: binding("GET", [], null) });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.endpoint).toBe(ENDPOINT);
  });

});
