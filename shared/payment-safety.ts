export const TESTNET_NETWORK = "eip155:84532" as const;
export const MAINNET_NETWORK = "eip155:8453" as const;

export const TESTNET_USDC_ADDRESS =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

export const MAINNET_USDC_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export const TESTNET_FACILITATOR_URL =
  "https://x402.org/facilitator" as const;

export const MAINNET_FACILITATOR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402" as const;

// Default to testnet. Mainnet requires an explicit opt-in because it uses real USDC.
export const ACTIVE_NETWORK =
  process.env.X402_USE_MAINNET === "1" ? MAINNET_NETWORK : TESTNET_NETWORK;

export function activePaymentNetwork(
  source: NodeJS.ProcessEnv = process.env,
): typeof TESTNET_NETWORK | typeof MAINNET_NETWORK {
  return source.X402_USE_MAINNET === "1" ? MAINNET_NETWORK : TESTNET_NETWORK;
}

export function activeUsdcAddress(
  source: NodeJS.ProcessEnv = process.env,
): typeof TESTNET_USDC_ADDRESS | typeof MAINNET_USDC_ADDRESS {
  return source.X402_USE_MAINNET === "1"
    ? MAINNET_USDC_ADDRESS
    : TESTNET_USDC_ADDRESS;
}

export function activeFacilitatorUrl(
  source: NodeJS.ProcessEnv = process.env,
): typeof TESTNET_FACILITATOR_URL | typeof MAINNET_FACILITATOR_URL {
  return source.X402_USE_MAINNET === "1"
    ? MAINNET_FACILITATOR_URL
    : TESTNET_FACILITATOR_URL;
}

export const PAYMENT_ASSET = "USDC" as const;
export const PAYMENT_AMOUNT_ATOMIC = "1000" as const;
export const PAYMENT_AMOUNT_USD = "0.001" as const;
export const PAYMENT_PRICE_LABEL = "$0.001" as const;
export const MAX_PAYMENT_ATTEMPTS = 1 as const;
