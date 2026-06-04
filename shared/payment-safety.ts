export const TESTNET_NETWORK = "eip155:84532" as const;
export const MAINNET_NETWORK = "eip155:8453" as const;

// Default to testnet. Mainnet requires an explicit opt-in because it uses real USDC.
export const ACTIVE_NETWORK =
  process.env.X402_USE_MAINNET === "1" ? MAINNET_NETWORK : TESTNET_NETWORK;

export function activePaymentNetwork(
  source: NodeJS.ProcessEnv = process.env,
): typeof TESTNET_NETWORK | typeof MAINNET_NETWORK {
  return source.X402_USE_MAINNET === "1" ? MAINNET_NETWORK : TESTNET_NETWORK;
}

export const PAYMENT_ASSET = "USDC" as const;
export const PAYMENT_AMOUNT_ATOMIC = "1000" as const;
export const PAYMENT_AMOUNT_USD = "0.001" as const;
export const PAYMENT_PRICE_LABEL = "$0.001" as const;
export const MAX_PAYMENT_ATTEMPTS = 1 as const;
