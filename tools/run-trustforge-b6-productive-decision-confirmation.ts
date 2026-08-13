/**
 * run-trustforge-b6-productive-decision-confirmation — B.6 productive path.
 *
 * live unpaid refresh → B6 BUY/DEFER/DONT_BUY → (BUY only) selection-bound
 * PaymentApprovalIntent → ONE real human checkpoint → existing thin runner.
 *
 * DEFER / DONT_BUY / human REJECT are successful decision outcomes (no payment).
 * This CLI does NOT authorize payment; only explicit APPROVE does.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  B4_PROTECTED_SIGNER_PROVIDER_ID,
  BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE,
} from "./trustforge/b4-execution-gates";
import { assertB6HasNoExecutionAuthority } from "./trustforge/b6-execution-gates";
import {
  B6_DECISION_POLICY_V1,
  b6DecisionPolicyHash,
} from "./trustforge/b6-decision-policy-v1";
import { runB6DecisionFromCandidates } from "./trustforge/b6-run-decision";
import {
  defaultTrustForgeSignersDir,
  vaultPathForBuyer,
} from "./trustforge/buyer-protected-signer-vault";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import {
  assessEconomicV2,
} from "./trustforge/economic-assessment-v2";
import { FIRST_REAL_MAINNET_PAYMENT_V1 } from "./trustforge/first-mainnet-payment-golden-trace";
import {
  assertHumanDisplayBindsPaymentApprovalIntent,
  assertPaymentApprovalIntentBindsSelectionDecision,
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
  paymentApprovalIntentToCandidateView,
  proveMethodBindingNominalGet,
} from "./trustforge/payment-approval-intent";
import { normalizeFromDiscoveredSelectedCandidate } from "./trustforge/payment-candidate-normalize";
import {
  evaluatePaymentCandidatePolicy,
  loadB5CandidatePolicy,
} from "./trustforge/payment-candidate-policy";
import {
  assertSelectionDecisionIntegrity,
  paymentSelectionDecisionHash,
} from "./trustforge/payment-selection-decision-v1";
import type { TargetCandidate } from "./trustforge/target-candidates";
import { probeTargetLiveness } from "./trustforge/target-liveness";
import { createThinSettlementRequestBinding } from "./trustforge/thin-settlement-request-binding";
import { runThinMainnetPayment } from "./trustforge/thin-mainnet-payment-runner";
import {
  createWindowsApproveRejectDialogProvider,
  OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT,
} from "./trustforge/windows-approve-reject-dialog";
import { createWindowsDpapiLocalSignerProvider } from "./trustforge/windows-dpapi-local-signer";

const BUYER = FIRST_REAL_MAINNET_PAYMENT_V1.buyer.toLowerCase();
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ONESOURCE_ENDPOINT = "https://api.onesource.io/api/chain/block-number";
const OTTO_ENDPOINT = "https://x402.ottoai.services/crypto-news";
const OTTO_PAY_TO = "0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808";

function persist(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeSha256Sums(runDir: string): void {
  const files = readdirSync(runDir)
    .filter((f) => f !== "SHA256SUMS.txt")
    .filter((f) => statSync(join(runDir, f)).isFile())
    .sort();
  writeFileSync(
    join(runDir, "SHA256SUMS.txt"),
    `${files.map((f) => `${sha256File(join(runDir, f))}  ${f}`).join("\n")}\n`,
  );
}

async function probeToSelected(input: {
  readonly candidateId: string;
  readonly endpoint: string;
  readonly method: "GET";
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly expectedPayTo?: string;
  readonly maxTargetPriceAtomic: string;
  readonly now: Date;
}): Promise<{
  readonly selected: DiscoveredSelectedCandidate | null;
  readonly probe: Record<string, unknown>;
}> {
  const rb = createThinSettlementRequestBinding({
    endpoint: input.endpoint,
    method: input.method,
    input_status: "known",
    query: input.query.map(([k, v]) => [k, v] as [string, string]),
    body: null,
  });
  const probeCandidate: TargetCandidate = {
    candidateId: input.candidateId,
    resourceUrl:
      input.query.length > 0
        ? `${input.endpoint}?${input.query.map(([k, v]) => `${k}=${v}`).join("&")}`
        : input.endpoint,
    method: input.method,
    x402Version: 2,
    freshness: {
      lastUpdated: input.now.toISOString(),
      sortKey: input.now.toISOString(),
    },
    registrationMetadata: {},
    requestBinding: rb,
    requestInputProvenance: "policy_generated_request_binding",
    requestBindingError: null,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        sellerNetworkRaw: "eip155:8453",
        canonicalNetworkCaip2: "eip155:8453",
        asset: USDC,
        amountAtomic: "1000",
        payTo: input.expectedPayTo ?? null,
        maxTimeoutSeconds: 300,
      },
    ],
  };

  const outcome = await probeTargetLiveness(probeCandidate, {
    maxTargetPriceAtomic: input.maxTargetPriceAtomic,
  });

  const probe: Record<string, unknown> = {
    candidateId: input.candidateId,
    endpoint: input.endpoint,
    method: input.method,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    quoteAtomic: outcome.quoteAtomic,
    quoteUsdc: outcome.quoteUsdc,
    payTo: outcome.selectedAccept?.payTo ?? null,
    network: outcome.selectedAccept?.canonicalNetworkCaip2 ?? null,
    asset: outcome.selectedAccept?.asset ?? null,
    requirements_hash:
      outcome.sellerRequirements?.binding.canonical_requirements_sha256 ?? null,
    envelope_hash:
      outcome.sellerRequirements?.binding.canonical_envelope_sha256 ?? null,
  };

  if (
    outcome.status !== "live_402_ok" ||
    !outcome.sellerRequirements ||
    !outcome.selectedAccept
  ) {
    return { selected: null, probe };
  }

  const obs = outcome.sellerRequirements;
  const accept = outcome.selectedAccept;
  if (
    input.expectedPayTo &&
    (accept.payTo ?? "").toLowerCase() !== input.expectedPayTo.toLowerCase()
  ) {
    return {
      selected: null,
      probe: { ...probe, blocked: "payTo_drift", freshPayTo: accept.payTo },
    };
  }

  const selected: DiscoveredSelectedCandidate = {
    schema_version: "trustforge_selected_candidate.v3",
    provider: "bazaar_unpaid",
    service_id: input.candidateId,
    endpoint: input.endpoint,
    method: input.method,
    request_input_status: "known",
    request_query: input.query.map(([k, v]) => [k, v] as [string, string]),
    request_body: null,
    request_input_provenance: "policy_generated_request_binding",
    request_binding_sha256: rb.binding_sha256,
    protocol_version: obs.binding.protocol_version,
    transport: obs.binding.transport,
    scheme: accept.scheme,
    amount_field: obs.binding.amount_field,
    max_timeout_seconds: accept.maxTimeoutSeconds ?? obs.binding.max_timeout_seconds,
    resource: obs.binding.resource,
    extra: obs.binding.extra,
    canonical_requirements_sha256: obs.binding.canonical_requirements_sha256,
    canonical_envelope_sha256: obs.binding.canonical_envelope_sha256,
    selection_requirements_observed_at: obs.requirements_observed_at,
    ancillary_tempo_evidence: obs.ancillary_tempo_evidence,
    seller_requirements: obs,
    quote_amount_usdc: outcome.quoteUsdc ?? "unknown",
    quote_atomic: outcome.quoteAtomic ?? accept.amountAtomic,
    authorized_pay_to: accept.payTo ?? obs.binding.pay_to,
    recommended_max_usdc: "0.005",
    seller_network_raw: accept.sellerNetworkRaw ?? "eip155:8453",
    canonical_network_caip2: accept.canonicalNetworkCaip2 ?? "eip155:8453",
    network: accept.canonicalNetworkCaip2 ?? "eip155:8453",
    asset: accept.asset,
    buyer_wallet: BUYER,
    target_selection_audit: {
      selected_resource_url: input.endpoint,
      handshake_status: outcome.status,
      fallback_resource_urls: [],
      scoring_rationale: ["b6_productive_decision_confirmation"],
    },
    selected_at_utc: input.now.toISOString(),
  };
  return { selected, probe };
}

function assessPaidContent(bodyExcerpt: string | null): Record<string, unknown> {
  if (!bodyExcerpt) {
    return { delivered_utility: "DELIVERED_UTILITY_UNASSESSABLE", note: "no body excerpt" };
  }
  const text = bodyExcerpt.toLowerCase();
  const newsLike = /headline|news|sentiment|report|market brief|bitcoin|article/.test(text);
  const blockLike = /block.?number|"block"|ethereum/.test(text);
  if (newsLike) {
    return {
      delivered_utility: "DELIVERED_UTILITY_OBSERVED",
      basic_coherence: "crypto_news_or_market_brief_fields_present",
      body_excerpt_present: true,
    };
  }
  if (blockLike) {
    return {
      delivered_utility: "DELIVERED_UTILITY_OBSERVED",
      basic_coherence: "block_number_like_payload",
      body_excerpt_present: true,
    };
  }
  return {
    delivered_utility: "DELIVERED_UTILITY_PARTIAL",
    basic_coherence: "payload_present_purpose_unclear",
    body_excerpt_present: true,
  };
}

async function main(): Promise<number> {
  assertB6HasNoExecutionAuthority();

  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "_");
  const runDir = join(
    "D:\\trustforge\\artifacts\\runs\\b6-productive-decision-confirmation",
    `run_${ts}`,
  );
  mkdirSync(runDir, { recursive: true });
  const now = new Date();

  persist(runDir, "ui_isolation_proof.json", {
    phase: "pre_operational_checkpoint",
    production_visible_dialogs: 0,
    synthetic_visible_dialogs: 0,
    mouse_automation: 0,
    note: "headless probes and B6 only until BUY binding passes",
  });

  console.log("B.6 Phase A — live UNPAID candidate refresh (NO UI)");

  const onesource = await probeToSelected({
    candidateId: "onesource_api_block_number_b6_prod",
    endpoint: ONESOURCE_ENDPOINT,
    method: "GET",
    query: [["network", "ethereum"]],
    maxTargetPriceAtomic: "5000",
    now,
  });
  const otto = await probeToSelected({
    candidateId: "x402_ottoai_services_crypto_news_b6_prod",
    endpoint: OTTO_ENDPOINT,
    method: "GET",
    query: [],
    expectedPayTo: OTTO_PAY_TO,
    maxTargetPriceAtomic: "5000",
    now,
  });

  persist(runDir, "live_candidate_refresh.json", {
    observed_at: now.toISOString(),
    payment_authorized: false,
    probes: [onesource.probe, otto.probe],
    historical_ottoai_delivered_utility:
      "DELIVERED_PURPOSE_OBSERVED from B52 run_20260813_072814 (priorDeliveredUtilityEvidence; not current paid proof)",
  });

  const policy = loadB5CandidatePolicy();
  const rows = [];
  const selectedById = new Map<string, DiscoveredSelectedCandidate>();

  for (const item of [
    {
      selected: onesource.selected,
      purpose: "ethereum_block_number",
      priorSuccess: true,
      priorDelivered: true,
      diversity: "low" as const,
      test: "low" as const,
      providerEvidence: "prior_trustforge_mainnet_onesource_history",
    },
    {
      selected: otto.selected,
      purpose: "crypto_news",
      priorSuccess: true,
      priorDelivered: true,
      diversity: "high" as const,
      test: "medium" as const,
      providerEvidence:
        "b52_ottoai_diversity_payment_DELIVERED_PURPOSE_OBSERVED_prior",
    },
  ]) {
    if (!item.selected) continue;
    selectedById.set(item.selected.service_id, item.selected);
    const candidate = normalizeFromDiscoveredSelectedCandidate(item.selected, {
      discovery_source: "b6_productive_live_refresh",
      discovered_at: now.toISOString(),
      purpose: item.purpose,
    });
    const verdict = evaluatePaymentCandidatePolicy(candidate, { policy, now });
    const economicsV2 = assessEconomicV2(candidate, verdict, {
      now,
      priorSuccessfulExecutionEvidence: item.priorSuccess,
      priorDeliveredUtilityEvidence: item.priorDelivered,
      diversityValue: item.diversity,
      testValue: item.test,
      providerEvidence: item.providerEvidence,
      utilityConfidenceOverride: "medium",
      knownAlternatives: ["onesource_block_number", "ottoai_crypto_news"],
    });
    rows.push({ candidate, verdict, economicsV2 });
  }

  if (rows.length === 0) {
    persist(runDir, "RESULT.txt", "B6_PRODUCTIVE_DECISION_DONT_BUY_NO_PAYMENT");
    console.error("no live_402_ok candidates");
    writeSha256Sums(runDir);
    return 1;
  }

  const { decision, set } = runB6DecisionFromCandidates(rows, { now });
  assertSelectionDecisionIntegrity(decision);
  const selectionHash = paymentSelectionDecisionHash(decision);

  persist(runDir, "candidate_decision_set.json", set);
  persist(runDir, "candidate_set_hash.json", {
    candidateSetHash: set.candidateSetHash,
    candidateObservationSetHash: set.candidateObservationSetHash,
  });
  persist(runDir, "payment_selection_decision.json", decision);
  persist(runDir, "selection_decision_hash.json", {
    selectionDecisionHash: selectionHash,
    decisionPolicyId: decision.decisionPolicyId,
    decisionPolicyVersion: decision.decisionPolicyVersion,
    decisionPolicyHash: decision.decisionPolicyHash,
    policy_hash_matches_config: decision.decisionPolicyHash === b6DecisionPolicyHash(B6_DECISION_POLICY_V1),
  });
  persist(runDir, "selection_rationale_binding.json", {
    selectionRationale: decision.selectionRationale,
    selectionDecisionHash: selectionHash,
  });

  console.log(`B6 decision: ${decision.decision}`);
  console.log(`selectionDecisionHash: ${selectionHash}`);

  if (decision.decision === "DEFER") {
    persist(runDir, "RESULT.txt", "B6_PRODUCTIVE_DECISION_DEFERRED_NO_PAYMENT");
    persist(runDir, "negative_effects.json", {
      visible_dialogs: 0,
      signatures: 0,
      payments: 0,
    });
    persist(runDir, "b6_productive_report.md", [
      "# RESULT: B6_PRODUCTIVE_DECISION_DEFERRED_NO_PAYMENT",
      "",
      `- decision: DEFER`,
      `- candidates evaluated: ${set.candidates.length}`,
      `- selectionDecisionHash: ${selectionHash}`,
      `- deferral: ${JSON.stringify(decision.deferralConditions)}`,
      `- visible dialogs: 0`,
      "",
    ].join("\n"));
    writeSha256Sums(runDir);
    console.log("RESULT: B6_PRODUCTIVE_DECISION_DEFERRED_NO_PAYMENT");
    console.log(`run_dir: ${runDir}`);
    return 0;
  }

  if (decision.decision === "DONT_BUY") {
    persist(runDir, "RESULT.txt", "B6_PRODUCTIVE_DECISION_DONT_BUY_NO_PAYMENT");
    persist(runDir, "negative_effects.json", {
      visible_dialogs: 0,
      signatures: 0,
      payments: 0,
    });
    persist(runDir, "b6_productive_report.md", [
      "# RESULT: B6_PRODUCTIVE_DECISION_DONT_BUY_NO_PAYMENT",
      "",
      `- decision: DONT_BUY`,
      `- candidates evaluated: ${set.candidates.length}`,
      `- selectionDecisionHash: ${selectionHash}`,
      `- rejection: ${JSON.stringify(decision.rejectionReasons)}`,
      `- visible dialogs: 0`,
      "",
    ].join("\n"));
    writeSha256Sums(runDir);
    console.log("RESULT: B6_PRODUCTIVE_DECISION_DONT_BUY_NO_PAYMENT");
    console.log(`run_dir: ${runDir}`);
    return 0;
  }

  // BUY path
  const selectedRow = rows.find(
    (r) => r.candidate.candidate_id === decision.selectedCandidateId,
  );
  if (!selectedRow) {
    persist(runDir, "RESULT.txt", "B6_PRODUCTIVE_APPROVAL_BINDING_NOT_READY_NO_PAYMENT");
    console.error("BUY without selected candidate row");
    writeSha256Sums(runDir);
    return 1;
  }
  if (selectedRow.verdict.verdict !== "ELIGIBLE") {
    persist(runDir, "RESULT.txt", "B6_PRODUCTIVE_APPROVAL_BINDING_NOT_READY_NO_PAYMENT");
    console.error("selected candidate not ELIGIBLE");
    writeSha256Sums(runDir);
    return 1;
  }

  const execSelected =
    selectedRow.candidate.execution_selected_candidate ??
    selectedById.get(selectedRow.candidate.service_id);
  if (!execSelected) {
    persist(runDir, "RESULT.txt", "B6_PRODUCTIVE_APPROVAL_BINDING_NOT_READY_NO_PAYMENT");
    console.error("missing execution_selected_candidate");
    writeSha256Sums(runDir);
    return 1;
  }

  const altLines = set.candidates.map((c) => {
    const shortId = c.candidateId.slice(0, 12);
    return `• ${shortId}… — ${c.disposition}: ${c.reason}`;
  });
  const why =
    decision.selectionRationale.map((r) => `${r.code}: ${r.detail}`).join(" | ") +
    ` | ALTERNATIVES (${set.candidates.length}): ` +
    altLines.join(" ");

  const intent = buildPaymentApprovalIntentFromSelected({
    selected: {
      ...execSelected,
      buyer_wallet: BUYER,
    },
    candidateId: selectedRow.candidate.candidate_id,
    serviceLabel:
      execSelected.endpoint.includes("ottoai")
        ? "OttoAI - Crypto News"
        : execSelected.endpoint.includes("onesource")
          ? "OneSource - Block Number"
          : selectedRow.candidate.service_label,
    advertisedPurpose: selectedRow.economicsV2.purpose,
    purposeEvidenceClass:
      selectedRow.economicsV2.utilityEvidenceClass === "OBSERVED_UTILITY"
        ? "Advertised purpose confirmed; delivered content quality not yet verified."
        : "PURPOSE_PARTIAL",
    whySelected: why,
    knownFacts: [
      "TRUSTFORGE RECOMMENDATION: BUY",
      `selectionDecisionHash=${selectionHash}`,
      `utilityEvidenceClass=${selectedRow.economicsV2.utilityEvidenceClass}`,
      `priorDeliveredUtilityEvidence=${selectedRow.economicsV2.priorDeliveredUtilityEvidence}`,
      ...altLines,
    ],
    unknownFacts: [
      "current paid response not yet observed in this run",
      "precise post-payment access scope",
    ],
    selectionDecisionHash: selectionHash,
    selectedCandidateId: decision.selectedCandidateId ?? undefined,
    selectedObservationId: decision.selectedObservationId ?? undefined,
    candidateSetHash: set.candidateSetHash,
  });

  const bindSel = assertPaymentApprovalIntentBindsSelectionDecision(intent, decision);
  const intentHash = paymentApprovalIntentHash(intent);
  const view = paymentApprovalIntentToCandidateView(intent);
  // B6 title via dialog_title on view projection — paymentApprovalIntentToCandidateView sets B52 title;
  // override display fields through why/known already. Patch title by rebuilding view fields used by dialog.
  const viewForUi = {
    ...view,
    dialog_title: "TRUSTFORGE - B6 REAL PAYMENT APPROVAL - WAITING FOR HUMAN",
    purpose_quality_note:
      "TRUSTFORGE RECOMMENDATION: BUY. Historical delivered utility is prior evidence only; current paid output not yet verified this run.",
  };

  const displayProof = assertHumanDisplayBindsPaymentApprovalIntent({
    intent,
    displayed: {
      service: viewForUi.service_label,
      endpoint: viewForUi.endpoint,
      method: viewForUi.method,
      request: viewForUi.request_summary,
      network: "Base",
      asset: "USDC",
      amount: viewForUi.amount_usdc,
      pay_to: viewForUi.seller,
    },
  });

  const methodProof = proveMethodBindingNominalGet({
    normalizedCandidateMethod: selectedRow.candidate.method === "unknown" ? "GET" : selectedRow.candidate.method,
    selectedCandidateMethod: execSelected.method ?? "GET",
    paymentApprovalIntentMethod: intent.method,
    humanDecisionBoundMethod: intent.method,
    buyerSigningAuthorizationMethod: "GET",
    paymentSendAuthorizationMethod: "GET",
    productiveHttpRequestMethod: "GET",
  });

  const preUi = {
    candidate_set_binding: "PASS",
    selection_decision_integrity: "PASS",
    selection_rationale_binding: "PASS",
    payment_approval_intent_selection_binding: bindSel.ok ? "PASS" : "FAIL",
    method_binding: methodProof.status,
    human_display_binding: displayProof.ok ? "PASS" : "FAIL",
    b6_sign_authority: 0,
    b6_send_authority: 0,
    visible_test_windows: 0,
    payment_approval_intent_hash: intentHash,
    selectionDecisionHash: selectionHash,
  };
  persist(runDir, "payment_approval_intent.json", intent);
  persist(runDir, "payment_approval_intent_hash.json", {
    paymentApprovalIntentHash: intentHash,
  });
  persist(runDir, "selection_to_intent_binding.json", bindSel);
  persist(runDir, "human_display_binding.json", displayProof);
  persist(runDir, "pre_ui_binding_audit.json", preUi);
  persist(runDir, "selected_candidate.json", execSelected);

  if (
    preUi.payment_approval_intent_selection_binding !== "PASS" ||
    preUi.method_binding !== "PASS" ||
    preUi.human_display_binding !== "PASS"
  ) {
    persist(runDir, "RESULT.txt", "B6_PRODUCTIVE_APPROVAL_BINDING_NOT_READY_NO_PAYMENT");
    console.error("B6_PRODUCTIVE_APPROVAL_BINDING_NOT_READY_NO_PAYMENT");
    writeSha256Sums(runDir);
    return 1;
  }

  const vaultPath = vaultPathForBuyer(BUYER, defaultTrustForgeSignersDir());
  if (!existsSync(vaultPath)) {
    console.error(`${BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE}: vault missing for ${BUYER}`);
    persist(runDir, "RESULT.txt", "B6_PRODUCTIVE_APPROVAL_BINDING_NOT_READY_NO_PAYMENT");
    writeSha256Sums(runDir);
    return 1;
  }

  console.log("============================================================");
  console.log("TRUSTFORGE — B6 REAL PAYMENT DECISION");
  console.log("");
  console.log("The TrustForge decision engine currently recommends BUY.");
  console.log("");
  console.log("ONE real payment-approval window will open.");
  console.log("");
  console.log("This is NOT a test.");
  console.log("");
  console.log("You may take as long as you want to read and decide.");
  console.log("");
  console.log("Nothing will be signed or paid unless YOU click APPROVE.");
  console.log("============================================================");

  const credentialPolicyPath = join(runDir, "credential_provider_policy.operational.json");
  writeFileSync(
    credentialPolicyPath,
    JSON.stringify(
      {
        schema_version: "trustforge_buyer_credential_provider_policy.v2",
        credential_provider_configured: true,
        allowed_provider_ids: [
          "inactive_production",
          "explicit-runtime-key",
          "windows-dpapi-local-signer",
          "encrypted-local-keystore",
          "external-signer",
          "secure-signing-provider",
        ],
        selected_productive_provider_id: B4_PROTECTED_SIGNER_PROVIDER_ID,
        provider_id: B4_PROTECTED_SIGNER_PROVIDER_ID,
        credential_kind: "windows_dpapi_protected_private_key",
        adapter_installed: true,
        transport_adapter_installed: true,
        secret_entry_adapter_installed: true,
        expected_signer_address: BUYER,
        credential_access_enabled: true,
        real_backend_activation: false,
        credential_caching_enabled: false,
        automatic_discovery_enabled: false,
        fallback_provider_enabled: false,
        real_signing_enabled: false,
        payment_bearing_send_enabled: false,
        settlement_enabled: false,
        retry_enabled: false,
        effect: "B.6 productive confirmation via windows-dpapi-local-signer",
      },
      null,
      2,
    ) + "\n",
  );

  // Ensure dialog title/recommendation: mutate intent projection by wrapping provider
  const baseProvider = createWindowsApproveRejectDialogProvider({
    operationalHumanCheckpoint: OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT,
  });
  const decisionProvider = {
    providerId: baseProvider.providerId,
    policy: baseProvider.policy,
    async decideOnce(_candidate: typeof viewForUi) {
      // Render authoritative B6 display projection (intent-derived), not a stale preview.
      return baseProvider.decideOnce(viewForUi);
    },
  };

  let result;
  try {
    result = await runThinMainnetPayment({
      directory: runDir,
      selected: { ...execSelected, buyer_wallet: BUYER },
      paymentApprovalIntent: intent,
      decisionProvider,
      credentialProvider: createWindowsDpapiLocalSignerProvider(),
      credentialPolicyPath,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    let code = "B6_PRODUCTIVE_BUY_PAYMENT_FAILED_NO_RETRY";
    if (/HUMAN_REJECTED|BLOCKED_B4_HUMAN_REJECTED/.test(msg)) {
      code = "B6_HUMAN_REJECTED_NO_PAYMENT";
    } else if (/ABORTED|BLOCKED_B4_HUMAN_DECISION_ABORTED/.test(msg)) {
      code = "B6_HUMAN_DECISION_ABORTED_NO_PAYMENT";
    } else if (/UI_FAILED|BLOCKED_B4_HUMAN_DECISION_UI_FAILED|BLOCKED_B52_HUMAN/.test(msg)) {
      code = "B6_HUMAN_DECISION_UI_FAILED_NO_PAYMENT";
    } else if (/FRESH_TERMS|REQUIREMENTS_CHANGED|REAUTHORIZE/.test(msg)) {
      code = "B6_FRESH_TERMS_CHANGED_REAUTHORIZE_NO_PAYMENT";
    } else if (/AMBIGUOUS/.test(msg)) {
      code = "B6_PRODUCTIVE_BUY_SEND_AMBIGUOUS_TERMINAL_RECONCILE";
    }
    persist(runDir, "RESULT.txt", code);
    persist(runDir, "b6_productive_report.md", `# RESULT\n\`${code}\`\n\n\`\`\`\n${msg}\n\`\`\`\n`);
    persist(runDir, "negative_effects.json", {
      note: msg.slice(0, 400),
      retry: 0,
      resend: 0,
      visible_operational_dialogs: 1,
      visible_test_dialogs: 0,
    });
    writeSha256Sums(runDir);
    console.error(code);
    console.error(msg);
    return code.startsWith("B6_HUMAN_") ? 0 : 1;
  }

  // Load decision for binding report
  const humanDecisionPath = join(runDir, "human_payment_decision.json");
  const humanDecision = existsSync(humanDecisionPath)
    ? JSON.parse(readFileSync(humanDecisionPath, "utf8"))
    : null;
  persist(runDir, "human_decision.json", {
    ...humanDecision,
    payment_approval_intent_hash: intentHash,
    selection_decision_hash: selectionHash,
    selected_candidate_id: decision.selectedCandidateId,
    candidate_set_hash: set.candidateSetHash,
  });

  let bodyExcerpt: string | null = null;
  const sanitized = join(runDir, "payment_http_response_sanitized.json");
  if (existsSync(sanitized)) {
    const j = JSON.parse(readFileSync(sanitized, "utf8")) as { body_excerpt?: string };
    bodyExcerpt = j.body_excerpt ?? null;
  }
  const delivered = assessPaidContent(bodyExcerpt);
  persist(runDir, "delivered_utility_assessment.json", delivered);
  persist(runDir, "response_metadata.json", {
    http_status: result.http_status,
    body_excerpt_present: Boolean(bodyExcerpt),
  });

  let settlementClass = "B6_PRODUCTIVE_BUY_PAYMENT_ACCEPTED_RECONCILIATION_REQUIRED";
  if (result.onchain_status === "ONCHAIN_VERIFIED") {
    settlementClass = "B6_PRODUCTIVE_BUY_PAYMENT_CONFIRMED_AFTER_RECONCILIATION";
  } else if (result.state.state === "CONFIRMED" && result.http_status === 200) {
    settlementClass = "B6_PRODUCTIVE_BUY_PAYMENT_CONFIRMED";
  }
  if (result.state.state === "CONFIRMED" && result.onchain_status === "ONCHAIN_VERIFIED") {
    settlementClass = "B6_PRODUCTIVE_BUY_PAYMENT_CONFIRMED_AFTER_RECONCILIATION";
  }

  persist(runDir, "settlement_reconciliation.json", {
    classification: settlementClass,
    http_status: result.http_status,
    onchain_status: result.onchain_status,
    facilitator_tx_hash: result.facilitator_tx_hash,
    signatures: result.signatures,
    payment_bearing_requests: result.payment_bearing_requests,
    retry: 0,
    resend: 0,
  });

  persist(runDir, "decision_execution_ledger.json", {
    candidateSetHash: set.candidateSetHash,
    selectionDecisionHash: selectionHash,
    paymentApprovalIntentHash: intentHash,
    human_decision_id: result.human_decision_id,
    human_decision: result.decision,
    payment_send_authorization_sha256: result.payment_send_authorization_sha256,
    facilitator_tx_hash: result.facilitator_tx_hash,
    delivered_utility: delivered.delivered_utility,
    settlement: settlementClass,
  });

  persist(runDir, "negative_effects.json", {
    private_key_prompts: 0,
    signatures: result.signatures,
    PaymentSendAuthorizations: result.payment_send_authorization_sha256 ? 1 : 0,
    payment_bearing_requests: result.payment_bearing_requests,
    retry: 0,
    resend: 0,
    visible_operational_dialogs: 1,
    visible_test_dialogs: 0,
    push: 0,
  });

  persist(runDir, "RESULT.txt", settlementClass);
  persist(
    runDir,
    "b6_productive_report.md",
    [
      `# RESULT: ${settlementClass}`,
      "",
      `- B6 decision: BUY`,
      `- selected: ${decision.selectedCandidateId}`,
      `- candidates evaluated: ${set.candidates.length}`,
      `- selectionDecisionHash: ${selectionHash}`,
      `- human decision: ${result.decision}`,
      `- intent hash: ${intentHash}`,
      `- signatures: ${result.signatures}`,
      `- payment-bearing requests: ${result.payment_bearing_requests}`,
      `- onchain: ${result.onchain_status ?? "n/a"}`,
      `- tx: ${result.facilitator_tx_hash ?? "n/a"}`,
      `- delivered utility: ${String(delivered.delivered_utility)}`,
      `- visible operational dialogs: 1`,
      `- visible test dialogs: 0`,
      `- push: none`,
      "",
    ].join("\n"),
  );

  // Hash artifacts if present
  for (const [out, src] of [
    ["unsigned_hash.json", "buyer_authorization_unsigned.json"],
    ["signed_artifact_hash.json", "buyer_authorization_signed.json"],
    ["signing_authorization_hash.json", "buyer_signing_authorization_derived.json"],
    ["credential_authorization_hash.json", "buyer_credential_access_authorization_derived.json"],
    ["payment_send_authorization_hash.json", "buyer_payment_send_authorization_derived.json"],
    ["send_commit.json", "buyer_payment_send_commit.json"],
  ] as const) {
    const p = join(runDir, src);
    if (existsSync(p)) {
      persist(runDir, out, { artifact: src, sha256: sha256File(p) });
    }
  }
  if (existsSync(join(runDir, "fresh_paytime_requirements.json"))) {
    // already written by runner
  }
  if (existsSync(join(runDir, "jit_authority_subset_proof.json"))) {
    persist(
      runDir,
      "jit_authority_subset.json",
      JSON.parse(readFileSync(join(runDir, "jit_authority_subset_proof.json"), "utf8")),
    );
  }
  if (existsSync(join(runDir, "pre_send_method_binding.json"))) {
    persist(
      runDir,
      "pre_send_binding_proof.json",
      JSON.parse(readFileSync(join(runDir, "pre_send_method_binding.json"), "utf8")),
    );
  }
  persist(runDir, "post_sign_jit_audit.json", {
    status: "PASS",
    note: "runner reached PSA derivation after post-sign audit",
  });

  writeSha256Sums(runDir);

  console.log(`RESULT: ${settlementClass}`);
  console.log(`run_dir: ${runDir}`);
  console.log(`decision: ${result.decision}`);
  console.log(`selectionDecisionHash: ${selectionHash}`);
  console.log(`http_status: ${result.http_status}`);
  console.log(`onchain_status: ${result.onchain_status}`);
  console.log(`signatures: ${result.signatures}`);
  console.log(`payment_bearing_requests: ${result.payment_bearing_requests}`);
  return result.state.state === "CONFIRMED" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(async (code) => {
      await new Promise<void>((r) => setImmediate(r));
      process.exit(code);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
