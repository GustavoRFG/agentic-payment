/**
 * rich-provider-discovery — Phase 5 unpaid candidate evaluation and selection.
 */

import type { DiscoveryCandidate, DiscoveryReport } from "./rich-tx-explainer-discovery";
import type { RichTxExplainerHandshake } from "./rich-tx-explainer-handshake";
import { ZAPPER_TX_EXPLAINER_POLICY } from "./rich-tx-explainer-policy";

export interface CandidateProviderRecord {
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly supports_unpaid_discovery: boolean | null;
  readonly requires_payment_header_for_discovery: boolean | null;
  readonly quote_observed: boolean | null;
  readonly quote_amount_usdc: string | null;
  readonly settlement_metadata_available: boolean | null;
  readonly semantic_evaluation_possible: boolean | null;
  readonly deterministic_fixture_possible: boolean | null;
  readonly risk_notes: readonly string[];
  readonly recommended: boolean;
  readonly selection_score?: number;
  readonly unpaid_liveness_status?: "pass" | "fail" | "not_executed";
  readonly category?: string;
}

export interface SelectedCandidate {
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly quote_amount_usdc: string;
  readonly recommended_max_usdc: string;
  readonly selection_rationale: readonly string[];
  readonly selection_criteria_met: Record<string, boolean>;
  readonly selected_at_utc: string;
}

export interface HumanPaymentAuthorizationTemplate {
  readonly authorization_schema_version: "trustforge_paid_probe_authorization.v1";
  readonly decision: "PENDING";
  readonly allowed_values: readonly ["reject", "authorize_one_payment"];
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly max_usdc: string;
  readonly max_payment_attempts: 1;
  readonly allow_retry: false;
  readonly allow_wallet_load: false;
  readonly allow_payment_header: false;
  readonly require_dedicated_wallet: true;
  readonly require_balance_cap: true;
  readonly require_no_secret_printing: true;
  readonly require_settlement_evidence: true;
  readonly require_payment_attempt_ledger: true;
  readonly require_payment_integrity_pass_before_trustscore: true;
  readonly require_semantic_evaluation_pass_before_trustscore: true;
  readonly expires_after: string;
  readonly decider: string;
  readonly decided_at: null;
  readonly rationale: string;
}

const SELECTION_CRITERIA = [
  "unpaid_discovery_works",
  "quote_visible_before_payment",
  "settlement_reconcilable",
  "semantic_evaluation_possible",
  "strict_cap_compatible",
  "no_retry_required",
  "phase4_compatible",
] as const;

function scoreCandidate(record: CandidateProviderRecord): number {
  let score = 0;
  if (record.supports_unpaid_discovery) score += 2;
  if (record.quote_observed) score += 2;
  if (record.settlement_metadata_available) score += 2;
  if (record.semantic_evaluation_possible) score += 2;
  if (record.deterministic_fixture_possible) score += 1;
  if (record.requires_payment_header_for_discovery === false) score += 1;
  if (record.unpaid_liveness_status === "pass") score += 3;
  score -= record.risk_notes.length;
  return score;
}

export function candidateFromZapperDiscovery(input: {
  readonly discovery: DiscoveryReport;
  readonly handshake: RichTxExplainerHandshake | null;
  readonly unpaidLivenessStatus: "pass" | "fail" | "not_executed";
}): CandidateProviderRecord {
  const policy = input.discovery.selected_policy ?? ZAPPER_TX_EXPLAINER_POLICY;
  const risks: string[] = [
    "Phase 3 paid attempts missed settlement tx hash in saved headers; chain reconciliation required",
    "Phase 3B semantic evaluation incomplete (missing status/structured amount in seller body)",
    "POST endpoint (not GET-only like bootstrap probes)",
  ];
  if (input.unpaidLivenessStatus !== "pass") {
    risks.push("Unpaid liveness did not pass in this run");
  }

  return {
    provider: policy.provider,
    service_id: policy.serviceId,
    endpoint: policy.endpointUrl,
    supports_unpaid_discovery: input.unpaidLivenessStatus === "pass",
    requires_payment_header_for_discovery: false,
    quote_observed: input.handshake != null,
    quote_amount_usdc: input.handshake?.quoteUsdc ?? null,
    settlement_metadata_available: true,
    semantic_evaluation_possible: true,
    deterministic_fixture_possible: true,
    risk_notes: risks,
    recommended: false,
    selection_score: 0,
    unpaid_liveness_status: input.unpaidLivenessStatus,
    category: "tx_explainer",
  };
}

export function candidateFromRegistryService(service: {
  readonly service_id: string;
  readonly provider: string;
  readonly endpoint_url: string;
  readonly category?: string;
  readonly last_observed_quote_usdc?: string;
  readonly status?: string;
  readonly ground_truth_determinism?: string;
}): CandidateProviderRecord {
  const isRichTx =
    service.service_id.includes("tx_explainer") ||
    service.category === "tx_explainer";
  const isProvenPaid =
    service.service_id === "onesource_api_chain_id" ||
    service.service_id === "onesource_api_block_number";
  const risks: string[] = [];
  if (!isRichTx && !isProvenPaid) {
    risks.push("No rich tx_explainer evaluation pipeline wired for this service");
  }
  if (isProvenPaid) {
    risks.push("Already used for bootstrap/Phase 2 probes; not the next rich target");
  }
  if (service.ground_truth_determinism === "time_sensitive_cross_check") {
    risks.push("Time-sensitive ground truth increases evaluation complexity");
  }
  if (!isRichTx) {
    risks.push("Not a tx_explainer rich probe target for Phase 5");
  }

  return {
    provider: service.provider,
    service_id: service.service_id,
    endpoint: service.endpoint_url,
    supports_unpaid_discovery: service.status === "proven_unpaid_handshake",
    requires_payment_header_for_discovery: false,
    quote_observed: Boolean(service.last_observed_quote_usdc),
    quote_amount_usdc: service.last_observed_quote_usdc ?? null,
    settlement_metadata_available: isProvenPaid,
    semantic_evaluation_possible: isProvenPaid || isRichTx,
    deterministic_fixture_possible: service.ground_truth_determinism === "deterministic",
    risk_notes: risks,
    recommended: false,
    unpaid_liveness_status:
      service.status === "proven_unpaid_handshake" ? "pass" : "not_executed",
    category: service.category ?? "unknown",
  };
}

export function finalizeCandidates(
  candidates: CandidateProviderRecord[],
): CandidateProviderRecord[] {
  return candidates
    .map((c) => ({ ...c, selection_score: scoreCandidate(c) }))
    .sort((a, b) => {
      const richA = cIsRichProbeTarget(a) ? 1 : 0;
      const richB = cIsRichProbeTarget(b) ? 1 : 0;
      if (richB !== richA) return richB - richA;
      return (b.selection_score ?? 0) - (a.selection_score ?? 0);
    });
}

function cIsRichProbeTarget(c: CandidateProviderRecord): boolean {
  return c.category === "tx_explainer" || c.service_id === "zapper_tx_explainer";
}

function meetsSelectionCriteria(best: CandidateProviderRecord): Record<string, boolean> {
  return {
    unpaid_discovery_works: best.supports_unpaid_discovery === true,
    quote_visible_before_payment: best.quote_observed === true,
    settlement_reconcilable: best.settlement_metadata_available === true,
    semantic_evaluation_possible: best.semantic_evaluation_possible === true,
    strict_cap_compatible: Boolean(best.quote_amount_usdc),
    no_retry_required: true,
    phase4_compatible: best.service_id === "zapper_tx_explainer",
    rich_probe_target: cIsRichProbeTarget(best),
  };
}

export function selectBestCandidate(
  candidates: readonly CandidateProviderRecord[],
): SelectedCandidate | null {
  const ranked = finalizeCandidates([...candidates]);

  for (const best of ranked) {
    if ((best.selection_score ?? 0) < 8) continue;
    const criteria = meetsSelectionCriteria(best);
    const allMet = Object.values(criteria).every(Boolean);
    if (!allMet) continue;

    return {
      provider: best.provider,
      service_id: best.service_id,
      endpoint: best.endpoint,
      quote_amount_usdc: best.quote_amount_usdc ?? "0.001125",
      recommended_max_usdc: "0.10",
      selection_rationale: [
        "Highest-ranked rich tx_explainer candidate meeting all selection criteria",
        "Unpaid HTTP 402 discovery confirmed without payment header",
        "Phase 4 SettlementEvidence and PaymentAttemptLedger already integrated",
        "Chain reconciliation path proven in Phase 3B for this provider",
        "Fact verification pipeline exists for tx_explainer responses",
      ],
      selection_criteria_met: criteria,
      selected_at_utc: new Date().toISOString(),
    };
  }

  return null;
}

export function buildHumanAuthorizationTemplate(
  selected: SelectedCandidate,
): HumanPaymentAuthorizationTemplate {
  return {
    authorization_schema_version: "trustforge_paid_probe_authorization.v1",
    decision: "PENDING",
    allowed_values: ["reject", "authorize_one_payment"],
    provider: selected.provider,
    service_id: selected.service_id,
    endpoint: selected.endpoint,
    max_usdc: selected.recommended_max_usdc,
    max_payment_attempts: 1,
    allow_retry: false,
    allow_wallet_load: false,
    allow_payment_header: false,
    require_dedicated_wallet: true,
    require_balance_cap: true,
    require_no_secret_printing: true,
    require_settlement_evidence: true,
    require_payment_attempt_ledger: true,
    require_payment_integrity_pass_before_trustscore: true,
    require_semantic_evaluation_pass_before_trustscore: true,
    expires_after: "Phase 6 single paid probe",
    decider: "Gustavo Gomes",
    decided_at: null,
    rationale: "",
  };
}

export function discoveryCandidateToRecord(
  candidate: DiscoveryCandidate,
): CandidateProviderRecord {
  return {
    provider: candidate.provider,
    service_id: candidate.service_id,
    endpoint: candidate.endpoint_url,
    supports_unpaid_discovery: null,
    requires_payment_header_for_discovery: false,
    quote_observed: candidate.observed_quote_usdc != null,
    quote_amount_usdc: candidate.observed_quote_usdc,
    settlement_metadata_available: null,
    semantic_evaluation_possible: candidate.accepts_tx_hash,
    deterministic_fixture_possible: candidate.accepts_tx_hash,
    risk_notes: candidate.is_oatp
      ? []
      : ["Discovered from offline cache; live unpaid liveness not run for this entry"],
    recommended: false,
    category: "tx_explainer",
    unpaid_liveness_status: "not_executed",
  };
}

export { SELECTION_CRITERIA };
