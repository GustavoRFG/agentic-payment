/**
 * capability-match-assessment — structured objective↔candidate match (B.6.1).
 * The structured match is authoritative; rationale explains it.
 */

import {
  capabilityMaySatisfy,
  normalizeCapabilityId,
} from "./capability-taxonomy-v1";
import type { PaymentDecisionObjectiveV1 } from "./payment-decision-objective-v1";
import type { PaymentCandidateV1 } from "./payment-candidate-v1";
import type { CandidateEconomicAssessmentV2 } from "./economic-assessment-v2";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const CAPABILITY_MATCH_ASSESSMENT_SCHEMA =
  "trustforge_capability_match_assessment.v1" as const;

export type CapabilityMatchKind =
  | "EXACT"
  | "COMPATIBLE"
  | "PARTIAL"
  | "UNKNOWN"
  | "MISMATCH";

export type CapabilityEvidenceClass =
  | "ADVERTISED"
  | "OBSERVED"
  | "INFERRED"
  | "UNKNOWN";

export interface CandidateCapabilityEvidence {
  readonly advertisedCapabilities: readonly string[];
  readonly observedCapabilities: readonly string[];
  readonly inferredCapabilities: readonly string[];
  readonly unknownCapabilities: readonly string[];
}

export interface CapabilityMatchAssessment {
  readonly schemaVersion: typeof CAPABILITY_MATCH_ASSESSMENT_SCHEMA;
  readonly objectiveId: string;
  readonly objectiveHash: string;
  readonly candidateId: string;
  readonly observationId: string;
  readonly requestedCapability: string;
  readonly match: CapabilityMatchKind;
  readonly evidenceClass: CapabilityEvidenceClass;
  readonly matchedProperties: readonly string[];
  readonly missingRequiredProperties: readonly string[];
  readonly conflictingProperties: readonly string[];
  readonly rationale: string;
  readonly assessmentHash: string;
  readonly candidateCapabilities: CandidateCapabilityEvidence;
}

function assessmentHashBody(
  a: Omit<CapabilityMatchAssessment, "assessmentHash">,
): Record<string, unknown> {
  return {
    schemaVersion: a.schemaVersion,
    objectiveId: a.objectiveId,
    objectiveHash: a.objectiveHash,
    candidateId: a.candidateId,
    observationId: a.observationId,
    requestedCapability: a.requestedCapability,
    match: a.match,
    evidenceClass: a.evidenceClass,
    matchedProperties: [...a.matchedProperties],
    missingRequiredProperties: [...a.missingRequiredProperties],
    conflictingProperties: [...a.conflictingProperties],
    rationale: a.rationale,
    candidateCapabilities: a.candidateCapabilities,
  };
}

export function capabilityMatchAssessmentHash(
  a: Omit<CapabilityMatchAssessment, "assessmentHash"> | CapabilityMatchAssessment,
): string {
  const { assessmentHash: _h, ...rest } = a as CapabilityMatchAssessment & {
    assessmentHash?: string;
  };
  void _h;
  return canonicalJsonSha256(
    assessmentHashBody(rest as Omit<CapabilityMatchAssessment, "assessmentHash">),
  );
}

/**
 * Derive capability evidence from candidate purpose/endpoint/history.
 * Does not invent capabilities from provider brand names alone.
 */
export function deriveCandidateCapabilityEvidence(input: {
  readonly candidate: PaymentCandidateV1;
  readonly economics?: CandidateEconomicAssessmentV2;
}): CandidateCapabilityEvidence {
  const advertised: string[] = [];
  const observed: string[] = [];
  const inferred: string[] = [];
  const unknown: string[] = [];

  const purpose = normalizeCapabilityId(
    typeof input.candidate.expected_utility.purpose === "string"
      ? input.candidate.expected_utility.purpose
      : "unknown",
  );
  const endpoint = input.candidate.endpoint.toLowerCase();
  const evidence =
    typeof input.candidate.expected_utility.evidence === "string"
      ? input.candidate.expected_utility.evidence.toLowerCase()
      : "";

  if (purpose !== "unknown" && purpose !== "") {
    advertised.push(purpose);
  }

  if (
    endpoint.includes("block-number") ||
    endpoint.includes("block_number") ||
    purpose === "chain_block_number"
  ) {
    if (!observed.includes("chain_block_number")) {
      observed.push("chain_block_number");
    }
    if (!advertised.includes("chain_block_number")) {
      advertised.push("chain_block_number");
    }
  }

  if (
    endpoint.includes("crypto-news") ||
    endpoint.includes("crypto_news") ||
    purpose === "crypto_news"
  ) {
    if (!advertised.includes("crypto_news")) {
      advertised.push("crypto_news");
    }
  }

  if (
    input.economics?.priorDeliveredUtilityEvidence ||
    /delivered_|observed_.*news|market_brief|crypto.news/i.test(evidence)
  ) {
    if (advertised.includes("crypto_news") || purpose === "crypto_news") {
      if (!observed.includes("crypto_news")) observed.push("crypto_news");
      if (!observed.includes("market_brief")) observed.push("market_brief");
    }
    if (advertised.includes("chain_block_number") || purpose === "chain_block_number") {
      if (!observed.includes("chain_block_number")) {
        observed.push("chain_block_number");
      }
    }
  }

  if (
    input.economics?.priorSuccessfulExecutionEvidence &&
    advertised.length > 0
  ) {
    for (const c of advertised) {
      if (!inferred.includes(c) && !observed.includes(c)) {
        inferred.push(c);
      }
    }
  }

  if (
    advertised.length === 0 &&
    observed.length === 0 &&
    inferred.length === 0
  ) {
    unknown.push("unknown");
  }

  return {
    advertisedCapabilities: [...new Set(advertised)],
    observedCapabilities: [...new Set(observed)],
    inferredCapabilities: [...new Set(inferred)],
    unknownCapabilities: [...new Set(unknown)],
  };
}

function unionCapabilities(ev: CandidateCapabilityEvidence): string[] {
  return [
    ...new Set([
      ...ev.advertisedCapabilities,
      ...ev.observedCapabilities,
      ...ev.inferredCapabilities,
    ]),
  ];
}

export function assessCapabilityMatch(input: {
  readonly objective: PaymentDecisionObjectiveV1;
  readonly candidate: PaymentCandidateV1;
  readonly economics?: CandidateEconomicAssessmentV2;
  readonly capabilityEvidence?: CandidateCapabilityEvidence;
}): CapabilityMatchAssessment {
  const requested = normalizeCapabilityId(input.objective.requestedCapability);
  const acceptable = [
    requested,
    ...input.objective.acceptableOutputClasses.map(normalizeCapabilityId),
  ];
  const caps =
    input.capabilityEvidence ??
    deriveCandidateCapabilityEvidence({
      candidate: input.candidate,
      economics: input.economics,
    });
  const known = unionCapabilities(caps);

  const matchedProperties: string[] = [];
  const missingRequired: string[] = [];
  const conflicting: string[] = [];

  for (const req of input.objective.requiredProperties) {
    // Required properties are soft-checked against purpose/endpoint strings.
    const hay = `${input.candidate.endpoint} ${JSON.stringify(input.candidate.request_query ?? [])} ${input.candidate.expected_utility.purpose}`;
    if (!hay.toLowerCase().includes(req.toLowerCase().replace(/^network=/, ""))) {
      // network=ethereum → check for ethereum in query/endpoint
      const token = req.includes("=") ? req.split("=")[1]! : req;
      if (!hay.toLowerCase().includes(token.toLowerCase())) {
        missingRequired.push(req);
      } else {
        matchedProperties.push(req);
      }
    } else {
      matchedProperties.push(req);
    }
  }

  let match: CapabilityMatchKind = "UNKNOWN";
  let evidenceClass: CapabilityEvidenceClass = "UNKNOWN";
  let rationale = "";

  if (known.length === 0 || caps.unknownCapabilities.includes("unknown")) {
    match = "UNKNOWN";
    evidenceClass = "UNKNOWN";
    rationale = `No inspectable capability evidence for requested=${requested}`;
  } else {
    const exactHit = known.find((c) => c === requested);
    const acceptableHit = known.find((c) => acceptable.includes(c));
    const compatibleHit = known.find((c) =>
      acceptable.some((a) => capabilityMaySatisfy(c, a)),
    );

    if (exactHit && caps.observedCapabilities.includes(exactHit)) {
      match = "EXACT";
      evidenceClass = "OBSERVED";
      matchedProperties.push(`capability:${exactHit}`);
      rationale = `Observed capability ${exactHit} exactly matches requested ${requested}`;
    } else if (exactHit && caps.advertisedCapabilities.includes(exactHit)) {
      match = "EXACT";
      evidenceClass = "ADVERTISED";
      matchedProperties.push(`capability:${exactHit}`);
      rationale = `Advertised capability ${exactHit} exactly matches requested ${requested}`;
    } else if (acceptableHit) {
      match = "COMPATIBLE";
      evidenceClass = caps.observedCapabilities.includes(acceptableHit)
        ? "OBSERVED"
        : caps.advertisedCapabilities.includes(acceptableHit)
          ? "ADVERTISED"
          : "INFERRED";
      matchedProperties.push(`capability:${acceptableHit}`);
      rationale = `Capability ${acceptableHit} is in acceptableOutputClasses for ${requested}`;
    } else if (compatibleHit) {
      match = "COMPATIBLE";
      evidenceClass = "INFERRED";
      matchedProperties.push(`capability:${compatibleHit}`);
      rationale = `Capability ${compatibleHit} maySatisfy acceptable class for ${requested} via explicit taxonomy`;
    } else {
      match = "MISMATCH";
      evidenceClass =
        caps.observedCapabilities.length > 0
          ? "OBSERVED"
          : caps.advertisedCapabilities.length > 0
            ? "ADVERTISED"
            : "INFERRED";
      for (const c of known) {
        conflicting.push(`capability:${c}`);
      }
      rationale = `Known capabilities [${known.join(",")}] do not satisfy requested=${requested}; not least-unrelated selection`;
    }
  }

  if (match !== "MISMATCH" && match !== "UNKNOWN" && missingRequired.length > 0) {
    match = "PARTIAL";
    rationale = `${rationale}; missing required properties: ${missingRequired.join(",")}`;
  }

  const partial: Omit<CapabilityMatchAssessment, "assessmentHash"> = {
    schemaVersion: CAPABILITY_MATCH_ASSESSMENT_SCHEMA,
    objectiveId: input.objective.objectiveId,
    objectiveHash: input.objective.objectiveHash,
    candidateId: input.candidate.candidate_id,
    observationId: input.candidate.observation_id,
    requestedCapability: requested,
    match,
    evidenceClass,
    matchedProperties: [...new Set(matchedProperties)],
    missingRequiredProperties: missingRequired,
    conflictingProperties: conflicting,
    rationale,
    candidateCapabilities: caps,
  };
  return {
    ...partial,
    assessmentHash: capabilityMatchAssessmentHash(partial),
  };
}

export function isSufficientObjectiveMatch(
  match: CapabilityMatchKind,
): boolean {
  return match === "EXACT" || match === "COMPATIBLE";
}
