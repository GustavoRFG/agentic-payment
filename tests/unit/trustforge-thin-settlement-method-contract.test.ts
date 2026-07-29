import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  isThinRunnerSettleableMethod,
  normalizeThinSettlementMethod,
  REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER,
  THIN_RUNNER_SETTLEABLE_METHODS,
} from "../../tools/trustforge/thin-settlement-method-contract";

describe("thin settlement method contract", () => {
  it("normalizes methods and exposes only POST + GET as settleable", () => {
    expect(THIN_RUNNER_SETTLEABLE_METHODS).toEqual(["POST", "GET"]);
    expect(normalizeThinSettlementMethod(" get ")).toBe("GET");
    expect(normalizeThinSettlementMethod("post")).toBe("POST");
    expect(normalizeThinSettlementMethod("  ")).toBeNull();
    expect(normalizeThinSettlementMethod(null)).toBeNull();
    expect(isThinRunnerSettleableMethod(" POST ")).toBe(true);
    expect(isThinRunnerSettleableMethod("get")).toBe(true);
    for (const method of ["PUT", "PATCH", "DELETE", "HEAD", "", null, undefined]) {
      expect(isThinRunnerSettleableMethod(method)).toBe(false);
    }
    expect(REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER).toBe(
      "REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER",
    );
  });

  it("loads planner and probe without a circular import edge", async () => {
    const contractSource = readFileSync(
      fileURLToPath(
        new URL("../../tools/trustforge/thin-settlement-method-contract.ts", import.meta.url),
      ),
      "utf8",
    );
    const plannerSource = readFileSync(
      fileURLToPath(
        new URL("../../tools/trustforge/thin-settlement-request-plan.ts", import.meta.url),
      ),
      "utf8",
    );
    const probeSource = readFileSync(
      fileURLToPath(
        new URL("../../tools/trustforge/paid-method-honored-probe.ts", import.meta.url),
      ),
      "utf8",
    );

    expect(contractSource).not.toMatch(/\bfrom\s+["']/);
    expect(plannerSource).not.toContain("./paid-method-honored-probe");
    expect(probeSource).not.toContain("./thin-settlement-request-plan");

    const [planner, probe] = await Promise.all([
      import("../../tools/trustforge/thin-settlement-request-plan"),
      import("../../tools/trustforge/paid-method-honored-probe"),
    ]);
    expect(planner.planThinSettleRequest).toBeTypeOf("function");
    expect(probe.probePaidMethodHonored).toBeTypeOf("function");
  });
});
