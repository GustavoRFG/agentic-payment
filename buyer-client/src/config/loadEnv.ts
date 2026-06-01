import dotenv from "dotenv";

export function loadEnvUnlessDisabled(): void {
  if (process.env.AGENTIC_SKIP_DOTENV === "1") return;
  dotenv.config();
}
