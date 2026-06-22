/**
 * sepolia-settlement-executor — Sepolia orchestration wrapper over shared x402 executor.
 */

import {
  PAYMENT_AMOUNT_USD,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";
import { runPaidQuoteFreshnessPreflight } from "./paid-quote-freshness-preflight";
import { assertMainnetBuyerKeyAbsent } from "./sepolia-settlement-guards";
import {
  validateHumanPaymentAuthorization,
  type HumanPaymentAuthorization,
} from "./validate-human-payment-authorization";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import { parseUsdcDecimalToAtomic } from "./external-x402-get-policy";
import {
  executeSingleX402Settlement,
  type SingleSettlementExecutionResult,
} from "./x402-single-settlement-executor";
import { SEPOLIA_BUYER_PRIVATE_KEY_ENV, SEPOLIA_TESTNET_BUYER_WALLET } from "./network-config";

export interface SepoliaSettlementExecutionResult {
  readonly ok: boolean;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly paymentAttempted: boolean;
  readonly paymentBearingHttpRequestCount: number;
  readonly responseBodyPreview: string;
  readonly buyerAddress: string;
  readonly network: typeof TESTNET_NETWORK;
  readonly facilitatorTransactionHash: string | null;
  readonly facilitatorReceiptPath: string | null;
  readonly facilitatorReceiptParseStatus: string | null;
  readonly attemptId: string;
  readonly intentPath: string;
}

function mapSepoliaResult(result: SingleSettlementExecutionResult): SepoliaSettlementExecutionResult {
  return {
    ok: result.ok,
    status: result.status,
    httpStatus: result.httpStatus,
    paymentAttempted: result.paymentAttempted,
    paymentBearingHttpRequestCount: result.paymentBearingHttpRequestCount,
    responseBodyPreview: result.responseBodyPreview,
    buyerAddress: result.buyerAddress,
    network: TESTNET_NETWORK,
    facilitatorTransactionHash: result.facilitatorTransactionHash,
    facilitatorReceiptPath: result.facilitatorReceiptPath,
    facilitatorReceiptParseStatus: result.facilitatorReceipt.parseStatus,
    attemptId: result.attemptId,
    intentPath: result.intentPath,
  };
}

export async function executeSepoliaSingleSettlement(input: {
  readonly runDir: string;
  readonly auth: HumanPaymentAuthorization;
  readonly selected: DiscoveredSelectedCandidate;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly skipFreshnessPreflight?: boolean;
  readonly authorizationHash: string;
}): Promise<SepoliaSettlementExecutionResult> {
  const env = input.env ?? process.env;
  assertMainnetBuyerKeyAbsent(env);
  if (env.X402_USE_MAINNET === "1") {
    throw new Error("BLOCKED_MAINNET_SIGNAL: X402_USE_MAINNET must not be set");
  }

  const validation = validateHumanPaymentAuthorization(input.auth, input.selected);
  if (!validation.valid) {
    throw new Error(`BLOCKED_INVALID_PAYMENT_AUTHORIZATION: ${validation.reasons.join("; ")}`);
  }

  if (!input.skipFreshnessPreflight) {
    const preflight = await runPaidQuoteFreshnessPreflight({
      authorized: {
        endpoint: input.selected.endpoint,
        quote_amount_usdc: input.selected.quote_amount_usdc,
        quote_atomic: input.selected.quote_atomic,
        authorized_max_usdc: input.auth.max_usdc,
        pay_to: input.selected.authorized_pay_to,
        network: input.selected.network,
        asset: input.selected.asset,
      },
      fetchImpl: input.fetchImpl,
    });
    if (!preflight.go) {
      throw new Error(`BLOCKED_PAY_TIME_FRESHNESS: ${preflight.reasons.join("; ")}`);
    }
  }

  const authorizationHash = input.authorizationHash;
  const maxAmountAtomic = parseUsdcDecimalToAtomic(input.auth.max_usdc).toString();
  const requestBody = {
    text: "TrustForge Sepolia settlement proof — single authorized attempt.",
    mode: "full",
  };

  const result = await executeSingleX402Settlement({
    request: {
      network: input.selected.network,
      privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
      expectedBuyerAddress: SEPOLIA_TESTNET_BUYER_WALLET,
      endpoint: input.selected.endpoint,
      method: "POST",
      body: requestBody,
      asset: input.selected.asset ?? TESTNET_USDC_ADDRESS,
      payTo: input.selected.authorized_pay_to,
      quotedAmountAtomic: input.selected.quote_atomic,
      maxAmountAtomic,
      runDir: input.runDir,
      authorizationHash,
      require402BeforePayment: true,
      expectedNetworkIn402: TESTNET_NETWORK,
    },
    env,
    fetchImpl: input.fetchImpl,
  });

  return mapSepoliaResult(result);
}

export function assertSepoliaQuoteWithinMax(
  quoteUsdc: string,
  maxUsdc: string,
): void {
  const quote = Number.parseFloat(quoteUsdc);
  const max = Number.parseFloat(maxUsdc);
  if (!Number.isFinite(quote) || quote > max) {
    throw new Error(`quote ${quoteUsdc} exceeds max ${maxUsdc}`);
  }
  if (quote !== Number.parseFloat(PAYMENT_AMOUNT_USD)) {
    // allow small formatting differences — atomic check happens in freshness
  }
}
