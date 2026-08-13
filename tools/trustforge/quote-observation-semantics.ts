/**
 * quote-observation-semantics — distinguish legitimate live price movement from
 * quote identity contradiction (A.2 / B.6).
 *
 * PRE-SELECTION: price movement → reevaluate (not permanent reject).
 * POST-HUMAN-APPROVAL: economic change → REAUTHORIZE (B.52).
 */

export const QUOTE_IDENTITY_CONTRADICTION = "QUOTE_IDENTITY_CONTRADICTION" as const;
export const LIVE_PRICE_MOVEMENT_OBSERVED = "LIVE_PRICE_MOVEMENT_OBSERVED" as const;
export const PRICE_CHANGE_REQUIRES_REEVALUATION =
  "PRICE_CHANGE_REQUIRES_REEVALUATION" as const;
export const QUOTE_UNREADABLE_OR_MALFORMED = "QUOTE_UNREADABLE_OR_MALFORMED" as const;

/** @deprecated Prefer the semantic classifiers above; retained for evidence strings. */
export const REJECTED_QUOTE_SOURCE_DISAGREEMENT = "REJECTED_QUOTE_SOURCE_DISAGREEMENT" as const;

export type QuoteObservationClassification =
  | typeof QUOTE_IDENTITY_CONTRADICTION
  | typeof LIVE_PRICE_MOVEMENT_OBSERVED
  | typeof PRICE_CHANGE_REQUIRES_REEVALUATION
  | typeof QUOTE_UNREADABLE_OR_MALFORMED
  | "QUOTE_AGREEMENT";

export interface QuoteObservationFields {
  readonly amount_atomic: string | null;
  readonly asset?: string | null;
  readonly pay_to?: string | null;
  readonly network?: string | null;
}

function normAddr(v: string | null | undefined): string | null {
  if (v == null || v === "") return null;
  return v.toLowerCase();
}

function isPositiveAtomic(v: string | null): v is string {
  if (v == null || v === "") return false;
  try {
    return BigInt(v) > 0n;
  } catch {
    return false;
  }
}

/**
 * Classify disagreement between a historical/census quote and a fresh live quote
 * for the same service/request identity (pre-selection).
 */
export function classifyHistoricalVsLiveQuote(input: {
  readonly historical: QuoteObservationFields;
  readonly live: QuoteObservationFields;
}): {
  readonly classification: QuoteObservationClassification;
  readonly accept_live_for_selection: boolean;
  readonly reason: string;
} {
  if (!isPositiveAtomic(input.live.amount_atomic)) {
    return {
      classification: QUOTE_UNREADABLE_OR_MALFORMED,
      accept_live_for_selection: false,
      reason: `${QUOTE_UNREADABLE_OR_MALFORMED}: live amount unreadable`,
    };
  }
  if (!isPositiveAtomic(input.historical.amount_atomic)) {
    return {
      classification: LIVE_PRICE_MOVEMENT_OBSERVED,
      accept_live_for_selection: true,
      reason: `${LIVE_PRICE_MOVEMENT_OBSERVED}: historical unreadable; adopt well-formed live quote`,
    };
  }

  const histAsset = normAddr(input.historical.asset);
  const liveAsset = normAddr(input.live.asset);
  const histPay = normAddr(input.historical.pay_to);
  const livePay = normAddr(input.live.pay_to);
  const histNet = input.historical.network ?? null;
  const liveNet = input.live.network ?? null;

  if (histAsset && liveAsset && histAsset !== liveAsset) {
    return {
      classification: QUOTE_IDENTITY_CONTRADICTION,
      accept_live_for_selection: false,
      reason: `${QUOTE_IDENTITY_CONTRADICTION}: asset mismatch historical=${histAsset} live=${liveAsset}`,
    };
  }
  if (histPay && livePay && histPay !== livePay) {
    return {
      classification: QUOTE_IDENTITY_CONTRADICTION,
      accept_live_for_selection: false,
      reason: `${QUOTE_IDENTITY_CONTRADICTION}: payTo mismatch historical=${histPay} live=${livePay}`,
    };
  }
  if (histNet && liveNet && histNet !== liveNet) {
    return {
      classification: QUOTE_IDENTITY_CONTRADICTION,
      accept_live_for_selection: false,
      reason: `${QUOTE_IDENTITY_CONTRADICTION}: network mismatch historical=${histNet} live=${liveNet}`,
    };
  }

  if (input.historical.amount_atomic === input.live.amount_atomic) {
    return {
      classification: "QUOTE_AGREEMENT",
      accept_live_for_selection: true,
      reason: "historical and live amounts agree",
    };
  }

  return {
    classification: PRICE_CHANGE_REQUIRES_REEVALUATION,
    accept_live_for_selection: true,
    reason: `${PRICE_CHANGE_REQUIRES_REEVALUATION}: historical=${input.historical.amount_atomic} live=${input.live.amount_atomic} (${LIVE_PRICE_MOVEMENT_OBSERVED})`,
  };
}

/**
 * Same observation / same supposed quote identity claiming two amounts.
 */
export function classifyIntraObservationContradiction(input: {
  readonly amount_a: string | null;
  readonly amount_b: string | null;
  readonly same_observation: boolean;
}): {
  readonly classification: QuoteObservationClassification;
  readonly fail_closed: boolean;
  readonly reason: string;
} {
  if (!input.same_observation) {
    return {
      classification: LIVE_PRICE_MOVEMENT_OBSERVED,
      fail_closed: false,
      reason: LIVE_PRICE_MOVEMENT_OBSERVED,
    };
  }
  if (!isPositiveAtomic(input.amount_a) || !isPositiveAtomic(input.amount_b)) {
    return {
      classification: QUOTE_UNREADABLE_OR_MALFORMED,
      fail_closed: true,
      reason: QUOTE_UNREADABLE_OR_MALFORMED,
    };
  }
  if (input.amount_a === input.amount_b) {
    return {
      classification: "QUOTE_AGREEMENT",
      fail_closed: false,
      reason: "amounts agree",
    };
  }
  return {
    classification: QUOTE_IDENTITY_CONTRADICTION,
    fail_closed: true,
    reason: `${QUOTE_IDENTITY_CONTRADICTION}: same observation claims ${input.amount_a} and ${input.amount_b}`,
  };
}

export interface PriceMovementEvidence {
  readonly schema_version: "trustforge_price_movement_evidence.v1";
  readonly classification: QuoteObservationClassification;
  readonly previous_amount_atomic: string | null;
  readonly current_amount_atomic: string | null;
  readonly absolute_delta_atomic: string | null;
  readonly relative_delta_bps: number | null;
  readonly price_direction: "up" | "down" | "flat" | "unknown";
  readonly observation_count: number;
  readonly note: string;
}

export function buildPriceMovementEvidence(input: {
  readonly previous_amount_atomic: string | null;
  readonly current_amount_atomic: string | null;
  readonly classification: QuoteObservationClassification;
  readonly observation_count?: number;
}): PriceMovementEvidence {
  const prev = input.previous_amount_atomic;
  const cur = input.current_amount_atomic;
  let absolute: string | null = null;
  let relative: number | null = null;
  let direction: PriceMovementEvidence["price_direction"] = "unknown";
  if (isPositiveAtomic(prev) && isPositiveAtomic(cur)) {
    const p = BigInt(prev);
    const c = BigInt(cur);
    const d = c - p;
    absolute = d.toString();
    direction = d > 0n ? "up" : d < 0n ? "down" : "flat";
    if (p > 0n) {
      relative = Number((d * 10000n) / p);
    }
  }
  return {
    schema_version: "trustforge_price_movement_evidence.v1",
    classification: input.classification,
    previous_amount_atomic: prev,
    current_amount_atomic: cur,
    absolute_delta_atomic: absolute,
    relative_delta_bps: relative,
    price_direction: direction,
    observation_count: input.observation_count ?? 2,
    note:
      (input.observation_count ?? 2) <= 2
        ? "Only two observations; do not invent statistical confidence"
        : "Multiple observations available",
  };
}
