import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { adaptDiscoveredPrimaryToSelectedCandidate } from "../../tools/trustforge/discovered-target-to-selected-candidate";
import {
  buildHumanPaymentAuthorizationDraft,
  PENDING_HUMAN_DECISION,
} from "../../tools/run-trustforge-emit-paid-authorization-draft";
import { evaluateFresh402AgainstAuthorizedQuote } from "../../tools/trustforge/paid-quote-freshness-preflight";
import { runPhase6SinglePaidRichProbe } from "../../tools/run-trustforge-phase6-single-paid-rich-probe";
import { validateHumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import {
  PHASE2_FIXTURE_TX,
  ZAPPER_TX_EXPLAINER_POLICY,
} from "../../tools/trustforge/rich-tx-explainer-policy";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";

const endpoint = ZAPPER_TX_EXPLAINER_POLICY.endpointUrl;
const requestBinding = createThinSettlementRequestBinding({
  endpoint,
  method: "POST",
  input_status: "known",
  query: [],
  body: ZAPPER_TX_EXPLAINER_POLICY.buildRequestBody(
    PHASE2_FIXTURE_TX,
    ZAPPER_TX_EXPLAINER_POLICY.targetChainId,
  ),
});

describe("paid discovered target pipeline (offline/testnet-safe)", () => {
  it("adapts canonical discovery, drafts authorization, and blocks preflight no-go before key load", async () => {
    const root = await mkdtemp(join(tmpdir(), "tf-paid-discovered-"));
    try {
      const adapted = adaptDiscoveredPrimaryToSelectedCandidate({
        selection: {
          primary: {
            method: "POST",
            handshakeStatus: "live_402_ok",
            resourceUrl: endpoint,
            requestEndpoint: requestBinding.endpoint,
            requestInputStatus: "known",
            requestQuery: requestBinding.query,
            requestBody: requestBinding.body,
            requestInputProvenance: "bazaar.extensions.bazaar.info.input",
            requestBindingSha256: requestBinding.binding_sha256,
            quoteUsdc: "0.001125",
            quoteAtomic: "1125",
            selectedPayTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
            scoringRationale: ["price_atomic=1125"],
          },
          fallbacks: [],
        },
      });
      expect(adapted.ok).toBe(true);
      if (!adapted.ok) return;

      const draft = buildHumanPaymentAuthorizationDraft(adapted.candidate);
      expect(draft.decision).toBe(PENDING_HUMAN_DECISION);

      const auth = {
        ...draft,
        decision: "authorize_one_payment" as const,
        decided_at: "2026-06-20T00:00:00.000Z",
        rationale: "testnet-safe single shot",
      };
      const validation = validateHumanPaymentAuthorization(auth, adapted.candidate);
      expect(validation.valid).toBe(true);

      const noGo = evaluateFresh402AgainstAuthorizedQuote(
        {
          candidateId: "zapper_tx_explainer",
          resourceUrl: endpoint,
          status: "live_402_ok",
          httpStatus: 402,
          selectedAccept: {
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amountAtomic: "20000",
            payTo: adapted.candidate.authorized_pay_to,
            maxTimeoutSeconds: 300,
          },
          challenge: { nonce: "n", expiresAt: "2099-01-01T00:00:00.000Z" },
          quoteAtomic: "20000",
          quoteUsdc: "0.02",
          rawResponse: { httpStatus: 402, headers: {}, body: {}, bodySha256: null },
          detail: null,
          walletUsed: false,
          paymentAttempted: false,
          paymentBearingHttpRequestCount: 0,
        },
        {
          endpoint,
          quote_amount_usdc: adapted.candidate.quote_amount_usdc,
          quote_atomic: adapted.candidate.quote_atomic,
          authorized_max_usdc: auth.max_usdc,
          pay_to: adapted.candidate.authorized_pay_to,
          request_binding: requestBinding,
        },
      );
      expect(noGo.go).toBe(false);

      const runDir = join(root, "phase6-run");
      const authPath = join(root, "human_payment_authorization.json");
      const selectedPath = join(root, "selected_candidate.json");
      await import("node:fs/promises").then(({ writeFile }) =>
        Promise.all([
          writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8"),
          writeFile(selectedPath, `${JSON.stringify(adapted.candidate, null, 2)}\n`, "utf8"),
        ]),
      );

      const fetchImpl = vi.fn(async () => {
        throw new Error("preflight should abort before network");
      }) as unknown as typeof fetch;

      await expect(
        runPhase6SinglePaidRichProbe({
          phase5RunDir: root,
          runDir,
          env: {},
          fetchImpl,
        }),
      ).rejects.toThrow("BLOCKED_PAY_TIME_FRESHNESS");

      const resultText = await readFile(join(runDir, "RESULT.txt"), "utf8");
      expect(resultText).toContain("FAIL_PAY_TIME_FRESHNESS");
      expect(resultText).toContain("wallet_loaded: no");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
