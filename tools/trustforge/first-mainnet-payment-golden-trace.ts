/**
 * first-mainnet-payment-golden-trace — canonical FIRST_REAL_MAINNET_PAYMENT_V1.
 * References evidence; never embeds secrets/nonce/signature/payment header.
 */

export const FIRST_REAL_MAINNET_PAYMENT_V1_ID =
  "FIRST_REAL_MAINNET_PAYMENT_V1" as const;

export const GOLDEN_TRACE_STATUS_CONFIRMED = "CONFIRMED" as const;

export interface FirstRealMainnetPaymentGoldenTrace {
  readonly id: typeof FIRST_REAL_MAINNET_PAYMENT_V1_ID;
  readonly GOLDEN_TRACE_STATUS: typeof GOLDEN_TRACE_STATUS_CONFIRMED;
  readonly productive_head: string;
  readonly ancestry: string;
  readonly evidence_run: string;
  readonly buyer: string;
  readonly network_raw: string;
  readonly network_canonical: string;
  readonly chain_id: number;
  readonly asset: string;
  readonly pay_to: string;
  readonly amount_atomic: string;
  readonly amount_usdc: string;
  readonly endpoint: string;
  readonly method: string;
  readonly query: string;
  readonly request_binding_sha256: string;
  readonly requirements_sha256: string;
  readonly envelope_sha256: string;
  readonly transaction_hash: string;
  readonly http_status: number;
  readonly onchain_status: string;
  readonly signatures: 1;
  readonly payment_bearing_requests: 1;
  readonly retry: 0;
  readonly resend: 0;
  readonly final_result: "FIRST_REAL_PAYMENT_CONFIRMED";
  readonly authority_sequence: readonly string[];
}

export const FIRST_REAL_MAINNET_PAYMENT_V1: FirstRealMainnetPaymentGoldenTrace = {
  id: FIRST_REAL_MAINNET_PAYMENT_V1_ID,
  GOLDEN_TRACE_STATUS: GOLDEN_TRACE_STATUS_CONFIRMED,
  productive_head: "2806977c5e653e4b70ecb88f990c42e3824b2f5c",
  ancestry: "4595fa5 → 2806977",
  evidence_run:
    "D:\\trustforge\\artifacts\\runs\\first-real-payment\\run_20260812_035951",
  buyer: "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
  network_raw: "eip155:8453",
  network_canonical: "eip155:8453",
  chain_id: 8453,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  pay_to: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
  amount_atomic: "1000",
  amount_usdc: "0.001",
  endpoint: "https://api.onesource.io/api/chain/block-number",
  method: "GET",
  query: "network=ethereum",
  request_binding_sha256:
    "333c2c9b6696fd723b3b9039977e536800465356e371dff975af840c61ff5da3",
  requirements_sha256:
    "99ab6417aea222f4de4e6984b4f0656a0ee0f1679498a4dcdd432d6dbf72ebcc",
  envelope_sha256:
    "2fb8de90df77884ea0f80503c65fdb70eb6fb181b30605bb6653c41c86ce708b",
  transaction_hash:
    "0x7be853241d0ca2c73c2926a9ad510471657dd8a74b271c9979f1e9a1d63ce72d",
  http_status: 200,
  onchain_status: "ONCHAIN_VERIFIED",
  signatures: 1,
  payment_bearing_requests: 1,
  retry: 0,
  resend: 0,
  final_result: "FIRST_REAL_PAYMENT_CONFIRMED",
  authority_sequence: [
    "fresh_unpaid_402",
    "exact_requirements_gate",
    "attempt_nonce_unsigned",
    "BuyerSigningAuthorization",
    "CredentialAccessAuthorization",
    "real_eip3009_signature",
    "POST_SIGN_JIT_AUDIT_PASS",
    "PaymentSendAuthorization",
    "SEND_COMMITTED_NO_RETRY",
    "B371_productive_one_shot_send",
    "RESPONSE_OBSERVED",
    "ONCHAIN_VERIFIED",
  ],
};

export interface GoldenTraceStructuralComparison {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
  readonly compared: readonly string[];
}

/** Compare structural invariants (not nonce/signature/timestamps). */
export function compareRunnerAgainstGoldenTrace(input: {
  readonly signatures: number;
  readonly payment_bearing_requests: number;
  readonly retry: number;
  readonly resend: number;
  readonly authority_sequence: readonly string[];
  readonly post_sign_audit_pass: boolean;
  readonly send_committed: boolean;
}): GoldenTraceStructuralComparison {
  const golden = FIRST_REAL_MAINNET_PAYMENT_V1;
  const mismatches: string[] = [];
  const compared: string[] = [];
  const check = (label: string, ok: boolean) => {
    compared.push(label);
    if (!ok) mismatches.push(label);
  };
  check("signatures_eq_1", input.signatures === golden.signatures);
  check(
    "payment_bearing_requests_eq_1",
    input.payment_bearing_requests === golden.payment_bearing_requests,
  );
  check("retry_eq_0", input.retry === golden.retry);
  check("resend_eq_0", input.resend === golden.resend);
  check("post_sign_audit_pass", input.post_sign_audit_pass);
  check("send_committed", input.send_committed);
  for (const step of [
    "PaymentSendAuthorization",
    "SEND_COMMITTED_NO_RETRY",
    "B371_productive_one_shot_send",
  ]) {
    check(`authority_contains_${step}`, input.authority_sequence.includes(step));
  }
  return { ok: mismatches.length === 0, mismatches, compared };
}
