import { describe, expect, it } from "vitest";

import type { TrustScore } from "../../tools/trustforge/consolidate-bootstrap-trust-score";
import {
  appendScoreHistory,
  buildPortfolioTrustScore,
  detectHistoryConsistency,
} from "../../tools/trustforge/temporal-score-history";

const fixedNow = () => new Date("2026-06-14T03:30:00.000Z");

function score(overrides: Partial<TrustScore> = {}): TrustScore {
  return {
    schema_name: "trustforge_trust_score",
    schema_version: "0.1.0",
    service_id: "onesource_api_block_number",
    window: { type: "bootstrap", from_utc: null, to_utc: null },
    dimensions: { correctness: 1, reliability: 1, payment_integrity: 1, latency: 0, safety: 1 },
    composite: 1,
    sample_size: 1,
    confidence: "low",
    regression_flag: false,
    methodology_version: "trustforge-bootstrap-v0.1.0",
    commercial_disclosure: {
      evaluated_service_is_customer: false,
      relationship_type: "none",
      seller_funded_probes: false,
      seller_funded_probe_share: 0,
      score_methodology_unchanged: true,
      disclosure_notes: "test",
    },
    evidence_refs: ["evaluation:x", "probe:y"],
    created_at_utc: "2026-06-14T03:00:00.000Z",
    ...overrides,
  };
}

describe("appendScoreHistory", () => {
  it("creates a fresh history with one entry and no regression", () => {
    const history = appendScoreHistory(null, score());
    expect(history.service_id).toBe("onesource_api_block_number");
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].regression_flag).toBe(false);
  });

  it("appends and detects regression against the prior composite", () => {
    const first = appendScoreHistory(null, score({ composite: 1 }));
    const second = appendScoreHistory(
      first,
      score({ composite: 0.8, created_at_utc: "2026-06-14T04:00:00.000Z" }),
    );
    expect(second.entries).toHaveLength(2);
    expect(second.entries[1].regression_flag).toBe(true);
  });

  it("does not flag regression for a small dip within threshold", () => {
    const first = appendScoreHistory(null, score({ composite: 1 }));
    const second = appendScoreHistory(first, score({ composite: 0.98 }));
    expect(second.entries[1].regression_flag).toBe(false);
  });

  it("rejects a service_id mismatch", () => {
    const first = appendScoreHistory(null, score());
    expect(() => appendScoreHistory(first, score({ service_id: "other" }))).toThrow(
      "does not match",
    );
  });
});

describe("detectHistoryConsistency", () => {
  it("reports insufficient_data for a single sample", () => {
    const history = appendScoreHistory(null, score());
    const c = detectHistoryConsistency(history);
    expect(c.consistency).toBe("insufficient_data");
    expect(c.regression_flag).toBe(false);
  });

  it("reports pass for two stable samples", () => {
    const first = appendScoreHistory(null, score({ composite: 1 }));
    const second = appendScoreHistory(first, score({ composite: 1 }));
    expect(detectHistoryConsistency(second).consistency).toBe("pass");
  });

  it("reports regressed when any entry regressed", () => {
    const first = appendScoreHistory(null, score({ composite: 1 }));
    const second = appendScoreHistory(first, score({ composite: 0.5 }));
    expect(detectHistoryConsistency(second).consistency).toBe("regressed");
  });
});

describe("buildPortfolioTrustScore", () => {
  it("rolls up two services into a portfolio score", () => {
    const portfolio = buildPortfolioTrustScore(
      [
        score({ service_id: "onesource_api_chain_id", composite: 1 }),
        score({ service_id: "onesource_api_block_number", composite: 1 }),
      ],
      { now: fixedNow },
    );
    expect(portfolio.service_count).toBe(2);
    expect(portfolio.total_sample_size).toBe(2);
    expect(portfolio.composite).toBe(1);
    expect(portfolio.regression_flag).toBe(false);
    expect(portfolio.services.map((s) => s.service_id)).toEqual([
      "onesource_api_chain_id",
      "onesource_api_block_number",
    ]);
  });

  it("propagates a regression flag from any member service", () => {
    const portfolio = buildPortfolioTrustScore(
      [
        score({ service_id: "a", composite: 1 }),
        score({ service_id: "b", composite: 0.5, regression_flag: true }),
      ],
      { now: fixedNow },
    );
    expect(portfolio.regression_flag).toBe(true);
    expect(portfolio.composite).toBe(0.75);
  });

  it("rejects mixed methodology versions", () => {
    expect(() =>
      buildPortfolioTrustScore([
        score({ methodology_version: "a" }),
        score({ methodology_version: "b" }),
      ]),
    ).toThrow("methodology_version");
  });
});
