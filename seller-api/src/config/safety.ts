export {
  MAX_PAYMENT_ATTEMPTS,
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  PAYMENT_ASSET,
  PAYMENT_PRICE_LABEL,
  TESTNET_NETWORK,
} from "../../../shared/payment-safety";

export const MAINNET_NETWORKS = new Set(["eip155:1", "eip155:8453"]);

export const SENSITIVE_ENV_NAMES = new Set([
  "BUYER_PRIVATE_KEY",
  "PRIVATE_KEY",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
  "WALLET_SECRET",
  "MNEMONIC",
  "SEED_PHRASE",
]);

export const FORBIDDEN_SNAPSHOT_PATTERNS: RegExp[] = [
  /CDP_API/i,
  /CDP_WALLET/i,
  /BUYER_PRIVATE_KEY/i,
  /PRIVATE_KEY/i,
  /MNEMONIC/i,
  /SEED_PHRASE/i,
  /wallet_secret/i,
  /authorization/i,
  /cookie/i,
  /paymentHeader/i,
  /signature/i,
];

export function isMainnetNetwork(network: string | undefined): boolean {
  return network !== undefined && MAINNET_NETWORKS.has(network);
}

export function sanitizeEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (!key || key.startsWith("=") || typeof value !== "string") continue;
    if (SENSITIVE_ENV_NAMES.has(key.toUpperCase())) continue;
    out[key] = value;
  }

  return out;
}
