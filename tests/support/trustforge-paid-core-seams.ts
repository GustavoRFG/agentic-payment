/**
 * tests/support/trustforge-paid-core-seams.ts
 *
 * Structural barrier: productive payment modules no longer export `__testOnly*`
 * symbols. Historical tests reach implementation cores only through this
 * test-support module. Productive code under tools/, buyer-client/, seller-api/,
 * and shared/ must never import this file.
 */

export { executeThinX402SettlementCore as executeThinX402Settlement } from "../../tools/trustforge/x402-thin-settlement-executor";
export { executeSingleX402SettlementCore as executeSingleX402Settlement } from "../../tools/trustforge/x402-single-settlement-executor";
export { runX402PaidSettlementCore as runX402PaidSettlement } from "../../tools/trustforge/x402-paid-settlement-runner";
export { runExternalPaidProbeCore as runExternalPaidProbe } from "../../tools/trustforge/external-x402-paid-executor";
export { runPhase6SinglePaidRichProbeCore as runPhase6SinglePaidRichProbe } from "../../tools/run-trustforge-phase6-single-paid-rich-probe";
