/**
 * sepolia-settlement-executor — backward-compatible delegate to x402-thin-settlement-executor.
 */

import { TESTNET_NETWORK } from "../../shared/payment-safety";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";
import {
  executeThinX402Settlement,
  type ThinSettlementExecutionResult,
} from "./x402-thin-settlement-executor";
import { SEPOLIA_X402_SETTLEMENT_PROFILE } from "./x402-settlement-profile";

export type SepoliaSettlementExecutionResult = ThinSettlementExecutionResult & {
  readonly network: typeof TESTNET_NETWORK;
};

export async function executeSepoliaSingleSettlement(input: {
  readonly runDir: string;
  readonly auth: HumanPaymentAuthorization;
  readonly selected: DiscoveredSelectedCandidate;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly skipFreshnessPreflight?: boolean;
  readonly authorizationHash: string;
}): Promise<SepoliaSettlementExecutionResult> {
  const result = await executeThinX402Settlement({
    profile: SEPOLIA_X402_SETTLEMENT_PROFILE,
    runDir: input.runDir,
    auth: input.auth,
    selected: input.selected,
    authorizationHash: input.authorizationHash,
    env: input.env,
    fetchImpl: input.fetchImpl,
    skipFreshnessPreflight: input.skipFreshnessPreflight,
  });
  return { ...result, network: TESTNET_NETWORK };
}

export { assertSepoliaQuoteWithinMax } from "./sepolia-settlement-quote";
