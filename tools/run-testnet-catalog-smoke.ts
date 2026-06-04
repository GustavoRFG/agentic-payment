import {
  PAYMENT_AMOUNT_ATOMIC,
  TESTNET_NETWORK,
} from "../seller-api/src/config/safety.ts";
import { projectRootFrom } from "./_lib/child-process.ts";
import { startSeller } from "./_lib/seller-harness.ts";

interface CatalogEndpoint {
  method: "POST";
  path: string;
  amountAtomic: string;
  body: Record<string, unknown>;
}

interface AcceptEntry {
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
}

interface PaymentRequiredEnvelope {
  accepts?: AcceptEntry[];
  extensions?: Record<string, unknown>;
}

const CATALOG: CatalogEndpoint[] = [
  {
    method: "POST",
    path: "/paid/analyze-text",
    amountAtomic: PAYMENT_AMOUNT_ATOMIC,
    body: { text: "Catalog smoke test.", mode: "summary" },
  },
  {
    method: "POST",
    path: "/paid/analyze-code",
    amountAtomic: "2000",
    body: { code: "const x = 1;", language: "typescript" },
  },
  {
    method: "POST",
    path: "/paid/summarize",
    amountAtomic: PAYMENT_AMOUNT_ATOMIC,
    body: { text: "This text is long enough to summarize.", maxPoints: 3 },
  },
  {
    method: "POST",
    path: "/paid/extract-data",
    amountAtomic: "2000",
    body: {
      text: "Invoice INV-1 total $10 due 2026-06-30.",
      fields: ["invoice_id", "total"],
    },
  },
  {
    method: "POST",
    path: "/paid/translate",
    amountAtomic: PAYMENT_AMOUNT_ATOMIC,
    body: { text: "Hola mundo.", targetLanguage: "English" },
  },
];

function decodePaymentRequired(raw: string): PaymentRequiredEnvelope {
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as PaymentRequiredEnvelope;
}

async function checkEndpoint(
  baseUrl: string,
  endpoint: CatalogEndpoint,
): Promise<{ path: string; status: number; network: string; amount: string; bazaar: string }> {
  const response = await fetch(`${baseUrl}${endpoint.path}`, {
    method: endpoint.method,
    headers: {
      "Content-Type": "application/json",
      "X-Agentic-Request-Id": `catalog-smoke-${endpoint.path.replace(/[^a-z0-9]/gi, "-")}`,
    },
    body: JSON.stringify(endpoint.body),
  });

  if (response.status !== 402) {
    throw new Error(`${endpoint.path} returned HTTP ${response.status}, expected 402`);
  }

  const raw = response.headers.get("payment-required") ?? "";
  if (!raw) throw new Error(`${endpoint.path} returned 402 without PAYMENT-REQUIRED`);

  const decoded = decodePaymentRequired(raw);
  const accept = decoded.accepts?.[0];
  if (!accept) throw new Error(`${endpoint.path} returned no accepts entry`);

  const amount = accept.amount ?? accept.maxAmountRequired ?? "";
  if (accept.network !== TESTNET_NETWORK) {
    throw new Error(`${endpoint.path} network=${accept.network}, expected ${TESTNET_NETWORK}`);
  }
  if (amount !== endpoint.amountAtomic) {
    throw new Error(`${endpoint.path} amount=${amount}, expected ${endpoint.amountAtomic}`);
  }
  if (!decoded.extensions?.bazaar) {
    throw new Error(`${endpoint.path} missing Bazaar metadata`);
  }

  return {
    path: endpoint.path,
    status: response.status,
    network: accept.network,
    amount,
    bazaar: "yes",
  };
}

function printTable(rows: Array<{ path: string; status: number; network: string; amount: string; bazaar: string }>): void {
  console.log("Endpoint                     HTTP  Network       Amount  Bazaar");
  console.log("---------------------------  ----  ------------  ------  ------");
  for (const row of rows) {
    console.log(
      `${row.path.padEnd(27)}  ${String(row.status).padEnd(4)}  ` +
        `${row.network.padEnd(12)}  ${row.amount.padEnd(6)}  ${row.bazaar}`,
    );
  }
}

async function main(): Promise<void> {
  const root = projectRootFrom(import.meta.url);
  let seller: Awaited<ReturnType<typeof startSeller>> | null = null;

  try {
    seller = await startSeller({ projectRoot: root, adapterMode: "mock" });
    const rows = [];
    for (const endpoint of CATALOG) {
      rows.push(await checkEndpoint(seller.baseUrl, endpoint));
    }
    printTable(rows);
    console.log("RESULT: TESTNET_CATALOG_SMOKE_PASSED");
  } finally {
    await seller?.stop();
  }
}

main().catch((error) => {
  console.error("[catalog:smoke:testnet] error:", (error as Error).message);
  process.exitCode = 1;
});
