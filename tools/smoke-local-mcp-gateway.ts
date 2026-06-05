import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../mcp-gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../mcp-gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { startSeller, type SellerHarness } from "./_lib/seller-harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mcpDir = join(repoRoot, "mcp-gateway");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const requiredTools = ["analyze_text_paid", "inspect_analyze_text_price"];

function childEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...overrides };
}

function readToolJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  if (!("content" in result)) {
    throw new Error("inspect tool returned no content");
  }
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("inspect tool returned non-text content");
  }
  return JSON.parse(first.text) as unknown;
}

async function main(): Promise<void> {
  let seller: SellerHarness | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  try {
    seller = await startSeller({ projectRoot: repoRoot, port: 4021 });

    transport = new StdioClientTransport({
      command: npmCommand,
      args: ["run", "dev"],
      cwd: mcpDir,
      env: childEnv({
        RESOURCE_SERVER_URL: "http://localhost:4021",
        MAX_PAYMENT_USD: "0.001",
        X402_USE_MAINNET: "0",
      }),
      stderr: "pipe",
    });
    transport.stderr?.resume();

    client = new Client({
      name: "local-mcp-gateway-smoke",
      version: "0.1.0",
    });
    await client.connect(transport);

    const tools = await client.listTools();
    const discovered = tools.tools.map((tool) => tool.name).sort();
    if (
      discovered.length !== requiredTools.length ||
      discovered.some((name, index) => name !== requiredTools[index])
    ) {
      throw new Error("unexpected MCP tool list");
    }

    const inspectResult = readToolJson(
      await client.callTool({
        name: "inspect_analyze_text_price",
        arguments: {
          text: "AI agents can autonomously purchase specialized API capabilities.",
        },
      }),
    );
    const requirements = inspectResult as {
      network?: string;
      amountAtomic?: string;
      paymentAttempted?: boolean;
    };

    if (
      requirements.network !== "eip155:84532" ||
      requirements.amountAtomic !== "1000" ||
      requirements.paymentAttempted !== false
    ) {
      throw new Error("inspect tool returned unexpected requirements");
    }

    console.log("RESULT: LOCAL_MCP_GATEWAY_SMOKE_PASSED");
    console.log("tools discovered: 2");
    console.log("payment attempted: No");
    console.log("mainnet used: No");
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (transport) await transport.close().catch(() => undefined);
    if (seller) await seller.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`RESULT: LOCAL_MCP_GATEWAY_SMOKE_FAILED`);
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
});
