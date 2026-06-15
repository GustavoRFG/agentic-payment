#!/usr/bin/env python3
"""
onchain_settlement_reconciliation — read-only Base USDC Transfer ledger for TrustForge buyer wallet.

Uses JSON-RPC only (eth_getLogs, eth_call, eth_getBlockByNumber, eth_getTransactionReceipt).
No wallet, no signing, no private keys.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from typing import Any

BUYER_WALLET = "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1"
USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
TRANSFER_TOPIC = (
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
)
CHAIN = "eip155:8453"
DEFAULT_RPCS = [
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
    "https://1rpc.io/base",
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
]
DEFAULT_WINDOW = 2000
PROBE_WINDOW = 50
MAX_RETRIES = 3
BACKOFFS = (0.5, 1.0, 2.0)

# Known settlement tx hashes from TrustForge artifacts (to match, not assume on-chain)
KNOWN_RUN_MATCHES: dict[str, str] = {
    "0xb445f8c1091a55ac35d23db38371a0e0d0bbb0bf2564e3ddf9843abea70cfb11": "T0C",
    "0xff5ec5e20c42aff2d6d96b7854441a0d0357178a2263f02ea381a00db12d26d4": "Phase2_recorded_tx",
    "0x9b605be3d78e4b64168842548612f3ceb671c61df8fab069aa7a815d934c35ed": "Phase3B_run_20260614_214953",
    "0x8f5edd95fb36ae7bcc129dc600ec7815db6d979ffe6cd7088b711ff94a0c2b86": "Phase3B_run_20260614_215030",
}

ZAPPER_PAY_TO = "0x43a2a720cd0911690c248075f4a29a5e7716f758"
OBSERVED_BALANCE_USDC = Decimal("0.051472")
PHASE3B_BALANCE_OBSERVED = Decimal("0.052597")
PHASE6_EXPECTED_DROP = Decimal("0.001125")


def pad_topic_address(address: str) -> str:
    addr = address.lower().removeprefix("0x")
    return "0x" + addr.rjust(64, "0")


def unpad_topic_address(topic: str) -> str:
    if not topic or not topic.startswith("0x"):
        return ""
    hex_part = topic[2:].rjust(64, "0")
    return "0x" + hex_part[-40:]


def atomic_to_usdc(amount_atomic: int) -> str:
    whole = amount_atomic // 1_000_000
    frac = amount_atomic % 1_000_000
    if frac == 0:
        return str(whole)
    frac_str = str(frac).rjust(6, "0").rstrip("0")
    return f"{whole}.{frac_str}"


def sum_usdc(values: list[str]) -> str:
    total = 0
    for v in values:
        micro = int((Decimal(v) * 1_000_000).to_integral_value(rounding=ROUND_DOWN))
        total += micro
    return atomic_to_usdc(total)


def hex_to_int(value: str | None) -> int:
    if not value:
        return 0
    return int(value, 16)


@dataclass
class RpcDiscarded:
    url: str
    reason: str


@dataclass
class SettlementRow:
    tx_hash: str
    block_number: int
    timestamp_utc: str | None
    to: str
    value_usdc: str
    value_atomic: str
    receipt_status: str
    matched_run: str | None
    source: str
    log_index: int


@dataclass
class ReconciliationResult:
    schema_name: str = "trustforge_onchain_settlement_ledger"
    schema_version: str = "0.1.0"
    wallet: str = BUYER_WALLET
    usdc_contract: str = USDC_CONTRACT
    chain: str = CHAIN
    selected_rpc: str = ""
    rpc_discarded: list[dict[str, str]] = field(default_factory=list)
    scanned_from_block: int = 0
    scanned_to_block: int = 0
    windows_scanned: int = 0
    current_balance_usdc: str = ""
    current_balance_onchain_confirmed: bool = False
    observed_balance_usdc: str = str(OBSERVED_BALANCE_USDC)
    total_outflows_usdc: str = "0"
    total_inflows_usdc: str = "0"
    settlements: list[dict[str, Any]] = field(default_factory=list)
    inflows: list[dict[str, Any]] = field(default_factory=list)
    unattributed_settlements: list[dict[str, Any]] = field(default_factory=list)
    known_settlements_confirmed_onchain: int = 0
    phase6_settlements_identified: list[str] = field(default_factory=list)
    reconciliation_balance_check: str = "fail"
    reconciliation_detail: str = ""
    status: str = "COMPLETE"


class JsonRpcClient:
    def __init__(self, url: str) -> None:
        self.url = url
        self._req_id = 0
        self._block_cache: dict[int, dict[str, Any]] = {}
        self._receipt_cache: dict[str, dict[str, Any]] = {}

    def call(self, method: str, params: list[Any]) -> Any:
        self._req_id += 1
        payload = json.dumps(
            {"jsonrpc": "2.0", "id": self._req_id, "method": method, "params": params}
        ).encode("utf-8")
        req = urllib.request.Request(
            self.url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "trustforge-onchain-reconcile/0.1",
            },
            method="POST",
        )
        last_error: Exception | None = None
        for attempt, backoff in enumerate(BACKOFFS[:MAX_RETRIES]):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                if "error" in body and body["error"]:
                    raise RuntimeError(json.dumps(body["error"]))
                return body.get("result")
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt < MAX_RETRIES - 1:
                    time.sleep(backoff)
        raise last_error or RuntimeError("rpc failed")

    def block_number(self) -> int:
        return hex_to_int(self.call("eth_blockNumber", []))

    def get_block_timestamp(self, block_number: int) -> str | None:
        if block_number in self._block_cache:
            ts = self._block_cache[block_number].get("timestamp")
        else:
            block = self.call("eth_getBlockByNumber", [hex(block_number), False])
            if not block:
                return None
            self._block_cache[block_number] = block
            ts = block.get("timestamp")
        if not ts:
            return None
        return datetime.fromtimestamp(hex_to_int(ts), tz=timezone.utc).isoformat()

    def receipt_status(self, tx_hash: str) -> str:
        key = tx_hash.lower()
        if key not in self._receipt_cache:
            receipt = self.call("eth_getTransactionReceipt", [key])
            self._receipt_cache[key] = receipt or {}
        status = self._receipt_cache[key].get("status")
        if status == "0x1":
            return "success"
        if status == "0x0":
            return "failed"
        return "unknown"

    def balance_of_usdc(self, wallet: str) -> tuple[int, str]:
        data = "0x70a08231" + wallet.lower().removeprefix("0x").rjust(64, "0")
        result = self.call(
            "eth_call",
            [{"to": USDC_CONTRACT, "data": data}, "latest"],
        )
        atomic = hex_to_int(result)
        return atomic, atomic_to_usdc(atomic)

    def get_logs_window(
        self,
        from_block: int,
        to_block: int,
        topic1: str | None = None,
        topic2: str | None = None,
    ) -> list[dict[str, Any]]:
        topics: list[str | None] = [TRANSFER_TOPIC]
        if topic1 is not None:
            topics.append(topic1)
        if topic2 is not None:
            topics.append(topic2)
        params = {
            "address": USDC_CONTRACT,
            "fromBlock": hex(from_block),
            "toBlock": hex(to_block),
            "topics": topics,
        }
        result = self.call("eth_getLogs", [params])
        return result or []


def resolve_rpc_list() -> list[str]:
    env = os.environ.get("BASE_RPC_URLS", "").strip()
    if env:
        return [u.strip() for u in env.split(",") if u.strip()]
    return list(DEFAULT_RPCS)


def probe_rpc(url: str, current_block: int) -> tuple[bool, str]:
    try:
        client = JsonRpcClient(url)
        to_block = current_block
        from_block = max(0, to_block - PROBE_WINDOW)
        client.get_logs_window(from_block, to_block)
        return True, "probe_ok"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:200]


def select_rpc(urls: list[str]) -> tuple[str | None, list[RpcDiscarded], int | None]:
    discarded: list[RpcDiscarded] = []
    for url in urls:
        try:
            client = JsonRpcClient(url)
            current_block = client.block_number()
            ok, reason = probe_rpc(url, current_block)
            if ok:
                return url, discarded, current_block
            discarded.append(RpcDiscarded(url, reason))
        except Exception as exc:  # noqa: BLE001
            discarded.append(RpcDiscarded(url, f"rpc: {exc}"[:200]))
    return None, discarded, None


def paginate_range(from_block: int, to_block: int, window: int) -> list[tuple[int, int]]:
    windows: list[tuple[int, int]] = []
    start = from_block
    while start <= to_block:
        end = min(start + window - 1, to_block)
        windows.append((start, end))
        start = end + 1
    return windows


def scan_transfers(
    client: JsonRpcClient,
    from_block: int,
    to_block: int,
    wallet: str,
    direction: str,
    window: int,
) -> tuple[list[SettlementRow], int]:
    wallet_topic = pad_topic_address(wallet)
    rows: list[SettlementRow] = []
    windows = paginate_range(from_block, to_block, window)
    for w_from, w_to in windows:
        if direction == "out":
            topics: list[Any] = [TRANSFER_TOPIC, wallet_topic]
        else:
            topics = [TRANSFER_TOPIC, None, wallet_topic]
        logs = client.call(
            "eth_getLogs",
            [
                {
                    "address": USDC_CONTRACT,
                    "fromBlock": hex(w_from),
                    "toBlock": hex(w_to),
                    "topics": topics,
                }
            ],
        ) or []

        for log in logs:
            amount_atomic = hex_to_int(log.get("data"))
            block_number = hex_to_int(log.get("blockNumber"))
            tx_hash = (log.get("transactionHash") or "").lower()
            to_addr = unpad_topic_address((log.get("topics") or ["", "", ""])[2])
            log_index = hex_to_int(log.get("logIndex"))
            ts = client.get_block_timestamp(block_number)
            value_usdc = atomic_to_usdc(amount_atomic)
            receipt_status = client.receipt_status(tx_hash)
            known = KNOWN_RUN_MATCHES.get(tx_hash.lower())
            source = "known" if known else "discovered"
            matched: str | None = known
            if not matched and direction == "out":
                if to_addr.lower() == ZAPPER_PAY_TO.lower() and amount_atomic == 1125:
                    if ts and (
                        ts.startswith("2026-06-15T03:")
                        or ts.startswith("2026-06-15T04:0")
                    ):
                        matched = "Phase6_candidate"
                    elif ts and ts.startswith("2026-06-14T21:50"):
                        matched = "Phase3B_candidate"
            rows.append(
                SettlementRow(
                    tx_hash=tx_hash,
                    block_number=block_number,
                    timestamp_utc=ts,
                    to=to_addr,
                    value_usdc=value_usdc,
                    value_atomic=str(amount_atomic),
                    receipt_status=receipt_status,
                    matched_run=matched,
                    source=source,
                    log_index=log_index,
                )
            )
    rows.sort(key=lambda r: (r.block_number, r.log_index))
    return rows, len(windows)


def resolve_from_block(client: JsonRpcClient, margin: int = 1000) -> int:
    t0c = "0xb445f8c1091a55ac35d23db38371a0e0d0bbb0bf2564e3ddf9843abea70cfb11"
    tx = client.call("eth_getTransactionByHash", [t0c])
    if tx and tx.get("blockNumber"):
        block = hex_to_int(tx["blockNumber"])
        return max(0, block - margin)
    return 47_310_000  # fallback near Phase3B scan origin


def match_phase6_runs(outflows: list[SettlementRow]) -> list[str]:
    phase6: list[str] = []
    for row in outflows:
        if row.tx_hash in KNOWN_RUN_MATCHES:
            continue
        if row.value_atomic != "1125":
            continue
        if row.to.lower() != ZAPPER_PAY_TO.lower():
            continue
        ts = row.timestamp_utc or ""
        if ts.startswith("2026-06-15T03:") or ts.startswith("2026-06-15T04:0"):
            phase6.append(row.tx_hash)
    return phase6


def build_markdown(ledger: ReconciliationResult) -> str:
    lines = [
        "# TrustForge on-chain USDC settlement ledger",
        "",
        f"- **Status:** {ledger.status}",
        f"- **Wallet:** `{ledger.wallet}`",
        f"- **RPC:** `{ledger.selected_rpc}`",
        f"- **Scanned blocks:** {ledger.scanned_from_block} → {ledger.scanned_to_block} ({ledger.windows_scanned} windows)",
        f"- **Current balance (on-chain):** {ledger.current_balance_usdc} USDC",
        f"- **Observed balance (Basescan):** {ledger.observed_balance_usdc} USDC",
        f"- **Total outflows:** {ledger.total_outflows_usdc} USDC",
        f"- **Total inflows:** {ledger.total_inflows_usdc} USDC",
        f"- **Reconciliation:** {ledger.reconciliation_balance_check} — {ledger.reconciliation_detail}",
        "",
        "## Outbound USDC transfers (payments)",
        "",
        "| tx_hash | block | timestamp_utc | to | value_usdc | status | matched_run | source |",
        "|---------|-------|---------------|-----|------------|--------|-------------|--------|",
    ]
    for s in ledger.settlements:
        lines.append(
            f"| `{s['tx_hash'][:10]}…` | {s['block_number']} | {s.get('timestamp_utc') or 'null'} | "
            f"`{s['to'][:10]}…` | {s['value_usdc']} | {s['receipt_status']} | "
            f"{s.get('matched_run') or 'unattributed'} | {s['source']} |"
        )
    if ledger.unattributed_settlements:
        lines.extend(
            [
                "",
                "## Unattributed settlements (on-chain but not in known hash list)",
                "",
            ]
        )
        for s in ledger.unattributed_settlements:
            lines.append(
                f"- `{s['tx_hash']}` block {s['block_number']} → {s['to']} "
                f"**{s['value_usdc']} USDC** ({s.get('timestamp_utc')})"
            )
    if ledger.phase6_settlements_identified:
        lines.extend(["", "## Phase 6 settlements identified", ""])
        for h in ledger.phase6_settlements_identified:
            lines.append(f"- `{h}`")
    lines.extend(
        [
            "",
            "## RPC discarded",
            "",
        ]
    )
    for d in ledger.rpc_discarded:
        lines.append(f"- `{d['url']}`: {d['reason']}")
    return "\n".join(lines) + "\n"


def run_reconciliation(
    *,
    output_dir: Path | None = None,
    window: int = DEFAULT_WINDOW,
) -> ReconciliationResult:
    urls = resolve_rpc_list()
    selected, discarded, _ = select_rpc(urls)
    result = ReconciliationResult(
        rpc_discarded=[asdict(d) for d in discarded],
    )
    if not selected:
        result.status = "BLOCKED_NO_USABLE_RPC"
        result.reconciliation_detail = "no RPC passed eth_getLogs probe"
        return result

    client = JsonRpcClient(selected)
    result.selected_rpc = selected
    to_block = client.block_number()
    from_block = resolve_from_block(client)
    result.scanned_from_block = from_block
    result.scanned_to_block = to_block

    outflows, windows_scanned = scan_transfers(
        client, from_block, to_block, BUYER_WALLET, "out", window
    )
    result.windows_scanned = windows_scanned

    inflows, _ = scan_transfers(client, from_block, to_block, BUYER_WALLET, "in", window)
    result.inflows = [asdict(r) for r in inflows]

    balance_atomic, balance_usdc = client.balance_of_usdc(BUYER_WALLET)
    result.current_balance_usdc = balance_usdc
    result.current_balance_onchain_confirmed = abs(
        Decimal(balance_usdc) - OBSERVED_BALANCE_USDC
    ) < Decimal("0.000001")

    outflow_values = [r.value_usdc for r in outflows]
    inflow_values = [r.value_usdc for r in inflows]
    result.total_outflows_usdc = sum_usdc(outflow_values)
    result.total_inflows_usdc = sum_usdc(inflow_values)

    # Match known hashes
    confirmed = 0
    for row in outflows:
        known_match = KNOWN_RUN_MATCHES.get(row.tx_hash.lower())
        if known_match:
            row.matched_run = known_match
            row.source = "known"
            confirmed += 1

    phase6_hashes = match_phase6_runs(outflows)
    result.phase6_settlements_identified = phase6_hashes
    for row in outflows:
        if row.tx_hash in phase6_hashes and not row.matched_run:
            row.matched_run = "Phase6_onchain"

    result.known_settlements_confirmed_onchain = confirmed
    result.settlements = [asdict(r) for r in outflows]
    result.unattributed_settlements = [
        asdict(r) for r in outflows if r.source == "discovered" and not r.matched_run
    ]

    # Balance reconciliation
    net = Decimal(result.total_inflows_usdc) - Decimal(result.total_outflows_usdc)
    phase6_out = sum(
        Decimal(r.value_usdc)
        for r in outflows
        if r.tx_hash in phase6_hashes or (r.matched_run or "").startswith("Phase6")
    )
    details: list[str] = []
    if result.current_balance_onchain_confirmed:
        details.append(
            f"on-chain balance {balance_usdc} matches observed {OBSERVED_BALANCE_USDC}"
        )
    else:
        details.append(
            f"on-chain balance {balance_usdc} differs from observed {OBSERVED_BALANCE_USDC}"
        )

    phase6_drop = PHASE3B_BALANCE_OBSERVED - Decimal(balance_usdc)
    if abs(phase6_drop - PHASE6_EXPECTED_DROP) < Decimal("0.000001"):
        details.append(
            f"Phase6 window drop {phase6_drop} matches expected {PHASE6_EXPECTED_DROP}"
        )
    elif phase6_out > 0:
        details.append(f"Phase6 outflows on-chain total {phase6_out} USDC")

    details.append(
        f"inflows {result.total_inflows_usdc} − outflows {result.total_outflows_usdc} "
        f"= net {net}; current balance {balance_usdc}"
    )
    result.reconciliation_detail = "; ".join(details)

    balance_ok = result.current_balance_onchain_confirmed
    if outflows and balance_ok:
        result.reconciliation_balance_check = "pass"
    elif outflows:
        result.reconciliation_balance_check = "partial"
    else:
        result.reconciliation_balance_check = "fail"

    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
        json_path = output_dir / "onchain_settlement_ledger.json"
        md_path = output_dir / "onchain_settlement_ledger.md"
        json_path.write_text(json.dumps(asdict(result), indent=2) + "\n", encoding="utf-8")
        md_path.write_text(build_markdown(result), encoding="utf-8")
        (output_dir / "RESULT.txt").write_text(format_result(result, json_path, md_path), encoding="utf-8")

    return result


def format_result(ledger: ReconciliationResult, json_path: Path, md_path: Path) -> str:
    unattr = [s["tx_hash"] for s in ledger.unattributed_settlements]
    return "\n".join(
        [
            "RESULT",
            f"trustforge_onchain_reconciliation_status: {ledger.status}",
            "repo: D:\\agentic-payments-lab",
            "branch: mvp-007a-local-paid-mcp-gateway",
            "commit_before: b78b889",
            "commit_after: null",
            "strict_no_payment: yes",
            "wallet_loaded: no",
            f"rpc_selected: {ledger.selected_rpc or 'null'}",
            f"rpc_discarded: {len(ledger.rpc_discarded)}",
            f"scanned_from_block: {ledger.scanned_from_block}",
            f"scanned_to_block: {ledger.scanned_to_block}",
            f"windows_scanned: {ledger.windows_scanned}",
            f"total_outflow_settlements_found: {len(ledger.settlements)}",
            f"total_outflow_usdc: {ledger.total_outflows_usdc}",
            f"current_balance_onchain_usdc: {ledger.current_balance_usdc}",
            f"current_balance_confirmed_onchain: {'yes' if ledger.current_balance_onchain_confirmed else 'no'}",
            f"reconciliation_balance_check: {ledger.reconciliation_balance_check}",
            f"known_settlements_confirmed_onchain: {ledger.known_settlements_confirmed_onchain}",
            f"unattributed_settlements_found: {len(ledger.unattributed_settlements)}",
            f"unattributed_tx_hashes: {','.join(unattr) if unattr else 'none'}",
            f"phase6_settlements_identified: {len(ledger.phase6_settlements_identified)} "
            f"({','.join(ledger.phase6_settlements_identified) if ledger.phase6_settlements_identified else 'none'})",
            f"ledger_json: {json_path}",
            f"ledger_md: {md_path}",
            "tests: see repo pytest",
            "build: n/a",
            "secrets_printed: no",
            "push_executed: no",
            f"report: {md_path}",
            "NEXT",
            "Use canonical ledger to correct RESULT files reporting actual_spend:null; do not retry payment without new authorization.",
        ]
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="TrustForge read-only on-chain USDC reconciliation")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Directory for ledger JSON/MD/RESULT",
    )
    parser.add_argument("--window", type=int, default=DEFAULT_WINDOW)
    args = parser.parse_args(argv)

    out = args.output_dir
    if out is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        out = Path(r"D:\trustforge\artifacts\runs\onchain-reconciliation") / f"run_{stamp}"

    ledger = run_reconciliation(output_dir=out, window=args.window)
    print(format_result(ledger, out / "onchain_settlement_ledger.json", out / "onchain_settlement_ledger.md"))
    return 0 if ledger.status == "COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main())
