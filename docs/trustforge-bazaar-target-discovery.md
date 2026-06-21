# TrustForge Bazaar target discovery

Status: implemented on `feat/bazaar-target-discovery`.

This milestone replaces the single hard-coded live target assumption with a
payment-free Bazaar target resolution stage:

1. Discover HTTP x402 resources from the Bazaar facilitator through the
   official `@x402` SDK packages.
2. Normalize Bazaar resources into TrustForge `TargetCandidate` records.
3. Filter candidates to Base mainnet USDC under the configured atomic budget.
4. Probe each surviving endpoint with an unsigned HTTP request and stop at the
   402 challenge.
5. Rank only `live_402_ok` targets deterministically by price, freshness, and
   optional reliability metrics.
6. Write a byte-stable `target_selection.json` containing the primary target,
   ordered fallbacks, per-candidate outcomes, and scoring rationale.

## CLI

Run:

```powershell
npm run trustforge:targets:discover
```

Default artifacts are written under:

```text
D:\trustforge\artifacts\runs\bazaar-target-discovery\run_<timestamp>\
```

The primary report is `target_selection.json`; `RESULT.txt` summarizes the
same run for terminal use.

Useful flags:

```powershell
npm run trustforge:targets:discover -- --max-target-price-atomic 10000
npm run trustforge:targets:discover -- --facilitator-url https://api.cdp.coinbase.com/platform/v2/x402
npm run trustforge:targets:discover -- --with-indexer --indexer-url <url>
```

Reliability enrichment is off by default. If enabled and the indexer fails, the
stage skips enrichment and proceeds with handshake-only ranking.

## Safety

The target resolution stage is strictly no-payment:

- No `.env` loading.
- `BUYER_PRIVATE_KEY` blocks the stage instead of being read.
- No wallet loading or paid rich-probe execution imports.
- No payment header is created or sent.
- No settlement or on-chain write is attempted.

The existing human payment gate remains unchanged. It can now additionally
record optional `target_selection_audit` metadata: selected resource URL,
handshake status, fallback URLs, and scoring rationale.
