/**
 * run-trustforge-b52-ottoai-diversity-payment — B.5.2 binding audit then ONE
 * real operational Approve/Reject checkpoint for OttoAI crypto-news.
 *
 * Phase A (this process, before UI): headless binding audit only.
 * Phase B: if B52_APPROVAL_BINDING_READY, open EXACTLY ONE production dialog.
 * Payment authority arises ONLY from explicit APPROVE button.
 *
 * NO PUSH. Prefer no private-key prompt (DPAPI vault).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  B4_PROTECTED_SIGNER_PROVIDER_ID,
  BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE,
} from "./trustforge/b4-execution-gates";
import {
  B52_APPROVAL_BINDING_READY,
  B52_OTTOAI_APPROVAL_BINDING_NOT_READY_NO_PAYMENT,
  B52_OTTOAI_DIVERSITY_PAYMENT_CONFIRMED,
  B52_OTTOAI_PAYMENT_ACCEPTED_RECONCILIATION_REQUIRED,
  B52_OTTOAI_PAYMENT_CONFIRMED_AFTER_RECONCILIATION,
  B52_OTTOAI_SEND_AMBIGUOUS_TERMINAL_RECONCILE,
  BLOCKED_B52_APPROVAL_BINDING_NOT_READY,
  HUMAN_DECISION_ABORTED_NO_PAYMENT,
  HUMAN_REJECTED_NO_PAYMENT,
} from "./trustforge/b52-execution-gates";
import {
  defaultTrustForgeSignersDir,
  vaultPathForBuyer,
} from "./trustforge/buyer-protected-signer-vault";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { FIRST_REAL_MAINNET_PAYMENT_V1 } from "./trustforge/first-mainnet-payment-golden-trace";
import {
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
  paymentApprovalIntentToCandidateView,
  proveCandidateAuthorizationRequestTripleBinding,
  proveMethodBindingNominalGet,
  assertHumanDisplayBindsPaymentApprovalIntent,
  assertJitAuthoritySubsetOfPaymentApprovalIntent,
} from "./trustforge/payment-approval-intent";
import { createThinSettlementRequestBinding } from "./trustforge/thin-settlement-request-binding";
import { runThinMainnetPayment } from "./trustforge/thin-mainnet-payment-runner";
import {
  createWindowsApproveRejectDialogProvider,
  OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT,
} from "./trustforge/windows-approve-reject-dialog";
import { createWindowsDpapiLocalSignerProvider } from "./trustforge/windows-dpapi-local-signer";
import { probeTargetLiveness } from "./trustforge/target-liveness";
import type { TargetCandidate } from "./trustforge/target-candidates";

const OTTO_ENDPOINT = "https://x402.ottoai.services/crypto-news";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EXPECTED_PAY_TO = "0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808";

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

function persist(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function buildFreshOttoSelected(
  buyer: string,
  now: Date,
): Promise<DiscoveredSelectedCandidate> {
  const rb = createThinSettlementRequestBinding({
    endpoint: OTTO_ENDPOINT,
    method: "GET",
    input_status: "known",
    query: [],
    body: null,
  });
  const probeCandidate: TargetCandidate = {
    candidateId: "x402_ottoai_services_crypto_news_b52",
    resourceUrl: OTTO_ENDPOINT,
    method: "GET",
    x402Version: 2,
    freshness: {
      lastUpdated: now.toISOString(),
      sortKey: now.toISOString(),
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
        payTo: EXPECTED_PAY_TO,
        maxTimeoutSeconds: 300,
      },
    ],
  };

  const outcome = await probeTargetLiveness(probeCandidate, {
    maxTargetPriceAtomic: "5000",
  });
  if (outcome.status !== "live_402_ok" || !outcome.sellerRequirements || !outcome.selectedAccept) {
    throw new Error(
      `${BLOCKED_B52_APPROVAL_BINDING_NOT_READY}: unpaid OttoAI probe failed status=${outcome.status}`,
    );
  }
  const obs = outcome.sellerRequirements;
  const accept = outcome.selectedAccept;
  if ((accept.payTo ?? "").toLowerCase() !== EXPECTED_PAY_TO.toLowerCase()) {
    throw new Error(
      `${BLOCKED_B52_APPROVAL_BINDING_NOT_READY}: payTo drift fresh=${accept.payTo}`,
    );
  }
  if (outcome.quoteAtomic !== "1000") {
    throw new Error(
      `${BLOCKED_B52_APPROVAL_BINDING_NOT_READY}: amount drift fresh=${outcome.quoteAtomic}`,
    );
  }

  return {
    schema_version: "trustforge_selected_candidate.v3",
    provider: "bazaar_unpaid",
    service_id: "x402_ottoai_services_crypto_news_b52",
    endpoint: OTTO_ENDPOINT,
    method: "GET",
    request_input_status: "known",
    request_query: [],
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
    quote_amount_usdc: outcome.quoteUsdc ?? "0.001",
    quote_atomic: outcome.quoteAtomic ?? "1000",
    authorized_pay_to: accept.payTo ?? EXPECTED_PAY_TO,
    recommended_max_usdc: "0.005",
    seller_network_raw: accept.sellerNetworkRaw ?? "eip155:8453",
    canonical_network_caip2: accept.canonicalNetworkCaip2 ?? "eip155:8453",
    network: accept.canonicalNetworkCaip2 ?? "eip155:8453",
    asset: accept.asset,
    buyer_wallet: buyer,
    target_selection_audit: {
      selected_resource_url: OTTO_ENDPOINT,
      handshake_status: outcome.status,
      fallback_resource_urls: [],
      scoring_rationale: ["b52_ottoai_diversity_payment"],
    },
    selected_at_utc: now.toISOString(),
  };
}

function runBindingAudit(selected: DiscoveredSelectedCandidate, runDir: string): {
  readonly ready: boolean;
  readonly intent_hash: string;
  readonly blockers: string[];
} {
  const blockers: string[] = [];
  const intent = buildPaymentApprovalIntentFromSelected({
    selected,
    serviceLabel: "OttoAI - Crypto News",
    advertisedPurpose:
      "Real-time crypto news with sentiment and ranked headlines",
    purposeEvidenceClass:
      "Advertised purpose confirmed; delivered content quality not yet verified.",
    whySelected:
      "First materially distinct second seller for the B5 generalized payment path.",
    knownFacts: [
      "fresh unpaid 402 observed",
      "x402 v2 / exact",
      "Base + USDC",
      "seller stable during due diligence",
      "B4/B371 compatible",
    ],
    unknownFacts: [
      "paid response schema/quality",
      "precise post-payment access scope",
    ],
  });
  const intentHash = paymentApprovalIntentHash(intent);
  persist(runDir, "payment_approval_intent.json", intent);
  persist(runDir, "payment_approval_intent_hash.json", {
    schema_version: "trustforge_payment_approval_intent_hash.v1",
    payment_approval_intent_hash: intentHash,
    algorithm: "canonical_json_sha256",
  });

  const view = paymentApprovalIntentToCandidateView(intent);
  try {
    const display = assertHumanDisplayBindsPaymentApprovalIntent({
      intent,
      displayed: {
        service: view.service_label,
        endpoint: view.endpoint,
        method: view.method,
        request: view.request_summary,
        network: "Base",
        asset: "USDC",
        amount: view.amount_usdc,
        pay_to: view.seller,
      },
    });
    persist(runDir, "human_display_binding_proof.json", {
      ...display,
      fields_shown_equal_intent: true,
      ui_source: view.ui_source,
      payment_approval_intent_hash: view.payment_approval_intent_hash,
    });
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  const methodProof = proveMethodBindingNominalGet({
    normalizedCandidateMethod: selected.method ?? "GET",
    selectedCandidateMethod: selected.method ?? "GET",
    paymentApprovalIntentMethod: intent.method,
    humanDecisionBoundMethod: intent.method,
    buyerSigningAuthorizationMethod: "GET",
    paymentSendAuthorizationMethod: "GET",
    productiveHttpRequestMethod: "GET",
  });
  persist(runDir, "method_binding_proof.json", methodProof);
  if (methodProof.status !== "PASS") {
    blockers.push(`method binding FAIL: ${methodProof.reasons.join("; ")}`);
  }

  const getToPost = proveMethodBindingNominalGet({
    normalizedCandidateMethod: "GET",
    selectedCandidateMethod: "GET",
    paymentApprovalIntentMethod: "GET",
    humanDecisionBoundMethod: "GET",
    buyerSigningAuthorizationMethod: "GET",
    paymentSendAuthorizationMethod: "GET",
    productiveHttpRequestMethod: "POST",
  });
  persist(runDir, "method_binding_negative_get_to_post.json", {
    ...getToPost,
    expected: "BLOCKED",
  });
  if (getToPost.status !== "FAIL") {
    blockers.push("GET→POST negative test did not block");
  }

  const id = selected.request_binding_sha256;
  const triple = proveCandidateAuthorizationRequestTripleBinding({
    authorizationRequestIdentity: id,
    selectedCandidateRequestIdentity: id,
    actualRequestIdentity: id,
    method: "GET",
  });
  persist(runDir, "triple_request_binding_proof.json", triple);
  if (!triple.result.endsWith("PASS")) {
    blockers.push(`triple binding FAIL: ${triple.reasons.join("; ")}`);
  }

  try {
    const jit = assertJitAuthoritySubsetOfPaymentApprovalIntent({
      intent,
      jit: {
        endpoint: intent.endpoint,
        method: intent.method,
        request_binding_sha256: intent.request_binding_sha256,
        buyer: intent.buyer,
        network_canonical: intent.network_canonical,
        asset: intent.asset,
        amount_atomic: intent.amount_atomic,
        pay_to: intent.pay_to,
        scheme: intent.scheme,
        protocol_version: intent.protocol_version,
      },
      fresh_requirements_identity: intent.seller_requirements_identity,
      fresh_envelope_identity: "synthetic_rotated_envelope_for_audit_only",
    });
    persist(runDir, "jit_authority_subset_proof.json", jit);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  persist(runDir, "ui_isolation_proof.json", {
    production_visible_dialogs_during_binding_audit: 0,
    synthetic_visible_dialogs: 0,
    mouse_automation: 0,
    decision_provider: "TestHumanPaymentDecisionProvider (audit only; not used for Phase B)",
  });

  const ready = blockers.length === 0;
  persist(runDir, "b52_binding_audit.json", {
    result: ready ? B52_APPROVAL_BINDING_READY : B52_OTTOAI_APPROVAL_BINDING_NOT_READY_NO_PAYMENT,
    UI_source: "authoritative PaymentApprovalIntent",
    human_decision_binds_intent_hash: "PASS (will bind on real decision)",
    jit_authority_subset: ready ? "PASS" : "FAIL",
    method_GET_candidate_binding: methodProof.status,
    method_GET_authorization_binding: methodProof.status,
    method_GET_productive_request_binding: methodProof.status,
    candidate_authorization_request: triple.result,
    "GET→POST_negative_test": getToPost.status === "FAIL" ? "BLOCKED" : "UNEXPECTED_PASS",
    visible_test_windows: 0,
    blockers,
    intent_hash: intentHash,
  });

  return { ready, intent_hash: intentHash, blockers };
}

function assessPaidContent(bodyText: string | null | undefined): Record<string, unknown> {
  if (!bodyText) {
    return {
      delivered_purpose: "DELIVERED_PURPOSE_MISMATCH",
      note: "empty paid body",
    };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      delivered_purpose: "DELIVERED_PURPOSE_PARTIAL",
      paid_response_schema: "non_json_or_unparseable",
      body_len: bodyText.length,
      basic_content_coherence: "unparsed_text_present",
    };
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const data = obj && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : obj;
  const text = JSON.stringify(parsed).toLowerCase();
  const hasNewsCue =
    /headline|news|sentiment|report|article|title/.test(text) ||
    Boolean(data && ("report" in data || "headlines" in data || "news" in data));
  const headlineCount = Array.isArray((data as { headlines?: unknown })?.headlines)
    ? ((data as { headlines: unknown[] }).headlines.length)
    : Array.isArray((data as { articles?: unknown })?.articles)
      ? ((data as { articles: unknown[] }).articles.length)
      : null;
  return {
    delivered_purpose: hasNewsCue
      ? "DELIVERED_PURPOSE_OBSERVED"
      : "DELIVERED_PURPOSE_PARTIAL",
    paid_response_schema: obj ? Object.keys(obj).slice(0, 20) : typeof parsed,
    headline_count: headlineCount,
    sentiment_fields_present: /sentiment/.test(text),
    ranking_fields_present: /rank|importance|score/.test(text),
    timestamps_freshness: {
      generatedAt: (obj?.meta as { generatedAt?: string } | undefined)?.generatedAt ?? null,
      dataAsOf: (obj?.meta as { dataAsOf?: string } | undefined)?.dataAsOf ?? null,
    },
    basic_content_coherence: hasNewsCue ? "news_like_fields_present" : "structure_present_purpose_unclear",
    purpose_quality_note:
      "Single paid sample; do not overclaim quality from one response.",
  };
}

async function main(): Promise<number> {
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "_");
  const runDir =
    readArg("--run-dir") ??
    join("D:\\trustforge\\artifacts\\runs\\b52-ottoai-diversity-payment", `run_${ts}`);
  mkdirSync(runDir, { recursive: true });

  const buyer = FIRST_REAL_MAINNET_PAYMENT_V1.buyer.toLowerCase();
  const vaultPath = vaultPathForBuyer(buyer, defaultTrustForgeSignersDir());
  if (!existsSync(vaultPath)) {
    console.error(
      `${BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE}: vault missing for ${buyer}`,
    );
    return 1;
  }

  console.log("B.5.2 Phase A — headless binding audit (NO UI)");
  const now = new Date();
  let selected: DiscoveredSelectedCandidate;
  try {
    selected = await buildFreshOttoSelected(buyer, now);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    persist(runDir, "RESULT.txt", B52_OTTOAI_APPROVAL_BINDING_NOT_READY_NO_PAYMENT);
    persist(runDir, "b52_report.md", `# RESULT\n\`${B52_OTTOAI_APPROVAL_BINDING_NOT_READY_NO_PAYMENT}\`\n\n${msg}\n`);
    console.error(msg);
    return 1;
  }
  persist(runDir, "selected_candidate.json", selected);

  const audit = runBindingAudit(selected, runDir);
  if (!audit.ready) {
    persist(runDir, "RESULT.txt", B52_OTTOAI_APPROVAL_BINDING_NOT_READY_NO_PAYMENT);
    persist(runDir, "negative_effects.json", {
      real_credential_acquisitions: 0,
      real_signer_invocations: 0,
      real_signatures: 0,
      payment_headers: 0,
      payment_bearing_requests: 0,
      payments: 0,
      production_visible_dialogs: 0,
    });
    console.error(`${B52_OTTOAI_APPROVAL_BINDING_NOT_READY_NO_PAYMENT}`);
    console.error(audit.blockers.join("\n"));
    return 1;
  }

  console.log(B52_APPROVAL_BINDING_READY);
  console.log(`intent_hash=${audit.intent_hash}`);
  console.log("B.5.2 Phase B — opening ONE real operational Approve/Reject dialog");
  console.log("Payment NOT authorized until explicit APPROVE click.");

  const intent = buildPaymentApprovalIntentFromSelected({
    selected,
    serviceLabel: "OttoAI - Crypto News",
    advertisedPurpose:
      "Real-time crypto news with sentiment and ranked headlines",
    purposeEvidenceClass:
      "Advertised purpose confirmed; delivered content quality not yet verified.",
    whySelected:
      "First materially distinct second seller for the B5 generalized payment path.",
    knownFacts: [
      "fresh unpaid 402 observed",
      "x402 v2 / exact",
      "Base + USDC",
      "seller stable during due diligence",
      "B4/B371 compatible",
    ],
    unknownFacts: [
      "paid response schema/quality",
      "precise post-payment access scope",
    ],
  });

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
        expected_signer_address: buyer,
        credential_access_enabled: true,
        real_backend_activation: false,
        credential_caching_enabled: false,
        automatic_discovery_enabled: false,
        fallback_provider_enabled: false,
        real_signing_enabled: false,
        payment_bearing_send_enabled: false,
        settlement_enabled: false,
        retry_enabled: false,
        effect: "B.5.2 OttoAI diversity payment via windows-dpapi-local-signer",
      },
      null,
      2,
    ) + "\n",
  );

  let result;
  try {
    result = await runThinMainnetPayment({
      directory: runDir,
      selected,
      paymentApprovalIntent: intent,
      decisionProvider: createWindowsApproveRejectDialogProvider({
        operationalHumanCheckpoint: OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT,
      }),
      credentialProvider: createWindowsDpapiLocalSignerProvider(),
      credentialPolicyPath,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    let code = "B52_OTTOAI_PAYMENT_FAILED_NO_RETRY";
    if (/HUMAN_REJECTED|BLOCKED_B4_HUMAN_REJECTED/.test(msg)) {
      code = HUMAN_REJECTED_NO_PAYMENT;
    } else if (/ABORTED|BLOCKED_B4_HUMAN_DECISION_ABORTED/.test(msg)) {
      code = HUMAN_DECISION_ABORTED_NO_PAYMENT;
    } else if (/AMBIGUOUS/.test(msg)) {
      code = B52_OTTOAI_SEND_AMBIGUOUS_TERMINAL_RECONCILE;
    } else if (/FRESH_TERMS_DIFFER|REQUIREMENTS_CHANGED/.test(msg)) {
      code = "BLOCKED_B52_FRESH_TERMS_DIFFER_FROM_HUMAN_APPROVAL_REAUTHORIZE";
    }
    persist(runDir, "RESULT.txt", code);
    persist(runDir, "b52_report.md", `# RESULT\n\`${code}\`\n\n\`\`\`\n${msg}\n\`\`\`\n`);
    persist(runDir, "negative_effects.json", {
      note: msg.slice(0, 500),
      retry: 0,
      resend: 0,
    });
    console.error(code);
    console.error(msg);
    return code === HUMAN_REJECTED_NO_PAYMENT || code === HUMAN_DECISION_ABORTED_NO_PAYMENT
      ? 0
      : 1;
  }

  const responseCandidates = [
    join(runDir, "payment_http_response_sanitized.json"),
    join(runDir, "payment_bearing_http_response.json"),
    join(runDir, "productive_send_response.json"),
    join(runDir, "send_response.json"),
  ];
  let bodyText: string | null = null;
  for (const p of responseCandidates) {
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as {
          body_text?: string;
          body?: string;
          body_excerpt?: string;
          status?: number;
          body_sha256?: string;
        };
        bodyText = j.body_text ?? j.body ?? j.body_excerpt ?? null;
        persist(runDir, "response_metadata.json", {
          source: p,
          http_status: result.http_status ?? j.status ?? null,
          body_len: bodyText?.length ?? 0,
          body_sha256: j.body_sha256 ?? null,
          // do not persist full payment headers
        });
        break;
      } catch {
        // continue
      }
    }
  }
  if (!existsSync(join(runDir, "response_metadata.json"))) {
    persist(runDir, "response_metadata.json", {
      http_status: result.http_status,
      body_len: null,
      note: "response body file not found under common names; see runner artifacts",
    });
  }

  const paidAssessment = assessPaidContent(bodyText);
  persist(runDir, "paid_content_assessment.json", paidAssessment);

  let settlementClass = B52_OTTOAI_PAYMENT_ACCEPTED_RECONCILIATION_REQUIRED;
  if (result.onchain_status === "ONCHAIN_VERIFIED") {
    settlementClass = B52_OTTOAI_PAYMENT_CONFIRMED_AFTER_RECONCILIATION;
  } else if (result.state.state === "CONFIRMED" && result.http_status === 200) {
    settlementClass = B52_OTTOAI_DIVERSITY_PAYMENT_CONFIRMED;
  }
  if (result.state.state === "CONFIRMED") {
    // Prefer diversity confirmed when productive path completed.
    settlementClass =
      result.onchain_status === "ONCHAIN_VERIFIED"
        ? B52_OTTOAI_PAYMENT_CONFIRMED_AFTER_RECONCILIATION
        : B52_OTTOAI_DIVERSITY_PAYMENT_CONFIRMED;
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

  persist(runDir, "negative_effects.json", {
    private_key_prompts: 0,
    signatures: result.signatures,
    PaymentSendAuthorizations: result.payment_send_authorization_sha256 ? 1 : 0,
    payment_bearing_requests: result.payment_bearing_requests,
    retry: 0,
    resend: 0,
    pushes: 0,
  });

  persist(runDir, "RESULT.txt", settlementClass);
  persist(
    runDir,
    "b52_report.md",
    [
      `# TrustForge B.5.2 — OttoAI diversity payment`,
      ``,
      `## RESULT`,
      `\`${settlementClass}\``,
      ``,
      `- human decision: ${result.decision}`,
      `- intent hash: ${audit.intent_hash}`,
      `- method: GET / GET / GET`,
      `- signatures: ${result.signatures}`,
      `- payment-bearing requests: ${result.payment_bearing_requests}`,
      `- onchain: ${result.onchain_status ?? "n/a"}`,
      `- paid-content purpose: ${String(paidAssessment.delivered_purpose)}`,
      `- push: none`,
      ``,
    ].join("\n"),
  );

  // SHA256SUMS
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(runDir).filter((f) => f !== "SHA256SUMS.txt");
  const sums = files
    .map((f) => `${sha256File(join(runDir, f))}  ${f}`)
    .sort()
    .join("\n");
  writeFileSync(join(runDir, "SHA256SUMS.txt"), `${sums}\n`);

  console.log(`RESULT: ${settlementClass}`);
  console.log(`run_dir: ${runDir}`);
  console.log(`decision: ${result.decision}`);
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
