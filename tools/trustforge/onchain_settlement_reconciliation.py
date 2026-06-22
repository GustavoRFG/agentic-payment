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
import socket
import sys
import time
import urllib.error
import urllib.parse
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
BASE_CHAIN_ID = 8453

TRUSTFORGE_BASE_RPC_URL_ENV = "TRUSTFORGE_BASE_RPC_URL"
TRUSTFORGE_BASE_RPC_FALLBACK_URLS_ENV = "TRUSTFORGE_BASE_RPC_FALLBACK_URLS"
LEGACY_BASE_RPC_URLS_ENV = "BASE_RPC_URLS"

DEFAULT_RPCS = [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
    "https://1rpc.io/base",
    "https://base.llamarpc.com",
]

MAX_FALLBACK_ENDPOINTS = 3
MAX_ATTEMPTS_PER_ENDPOINT = 1
RPC_TIMEOUT_SEC = 30
DEFAULT_WINDOW = 2000
PROBE_WINDOW = 50

RECONCILIATION_PASS = "RECONCILIATION_PASS"
RECONCILIATION_NO_NEW_SETTLEMENT = "RECONCILIATION_NO_NEW_SETTLEMENT"
RECONCILIATION_UNATTRIBUTED_SETTLEMENTS = "RECONCILIATION_UNATTRIBUTED_SETTLEMENTS"
RECONCILIATION_RPC_UNAVAILABLE = "RECONCILIATION_RPC_UNAVAILABLE"
RECONCILIATION_RPC_FORBIDDEN = "RECONCILIATION_RPC_FORBIDDEN"
RECONCILIATION_RPC_RATE_LIMITED = "RECONCILIATION_RPC_RATE_LIMITED"
RECONCILIATION_INVALID_RESPONSE = "RECONCILIATION_INVALID_RESPONSE"
RECONCILIATION_WRONG_CHAIN = "RECONCILIATION_WRONG_CHAIN"
RECONCILIATION_RPC_TIMEOUT = "RECONCILIATION_RPC_TIMEOUT"


class RpcDeadlineExceeded(Exception):
    """Raised when bounded reconciliation exceeds max total runtime."""

# Known settlement tx hashes from TrustForge artifacts (to match, not assume on-chain)
KNOWN_RUN_MATCHES: dict[str, str] = {
    "0xb445f8c1091a55ac35d23db38371a0e0d0bbb0bf2564e3ddf9843abea70cfb11": "T0C",
    "0xff5ec5e20c42aff2d6d96b7854441a0d0357178a2263f02ea381a00db12d26d4": "Phase2_recorded_tx",
    "0x9b605be3d78e4b64168842548612f3ceb671c61df8fab069aa7a815d934c35ed": "Phase3B_run_20260614_214953",
    "0x8f5edd95fb36ae7bcc129dc600ec7815db5d979ffe6cd7088b711ff94a0c2b86": "Phase3B_run_20260614_215030",
}

ZAPPER_PAY_TO = "0x43a2a720cd0911690c248075f4a29a5e7716f758"
OBSERVED_BALANCE_USDC = Decimal("0.051472")
PHASE3B_BALANCE_OBSERVED = Decimal("0.052597")
PHASE6_EXPECTED_DROP = Decimal("0.001125")

SEPOLIA_CHAIN_ID = 84532
SEPOLIA_WALLET = "0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392"
SEPOLIA_USDC_CONTRACT = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
SEPOLIA_CHAIN = "eip155:84532"

TRUSTFORGE_SEPOLIA_RPC_URL_ENV = "TRUSTFORGE_SEPOLIA_RPC_URL"
TRUSTFORGE_SEPOLIA_RPC_FALLBACK_URLS_ENV = "TRUSTFORGE_SEPOLIA_RPC_FALLBACK_URLS"

DEFAULT_SEPOLIA_RPCS = [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
]


@dataclass(frozen=True)
class NetworkProfile:
    network_id: str
    chain: str
    chain_id: int
    wallet: str
    usdc_contract: str
    rpc_primary_env: str
    rpc_fallback_env: str
    default_rpcs: tuple[str, ...]
    observed_balance_usdc: Decimal | None = None
    known_run_matches: dict[str, str] = field(default_factory=dict)
    zapper_pay_to: str | None = None


MAINNET_PROFILE = NetworkProfile(
    network_id="mainnet",
    chain=CHAIN,
    chain_id=BASE_CHAIN_ID,
    wallet=BUYER_WALLET,
    usdc_contract=USDC_CONTRACT,
    rpc_primary_env=TRUSTFORGE_BASE_RPC_URL_ENV,
    rpc_fallback_env=TRUSTFORGE_BASE_RPC_FALLBACK_URLS_ENV,
    default_rpcs=tuple(DEFAULT_RPCS),
    observed_balance_usdc=OBSERVED_BALANCE_USDC,
    known_run_matches=KNOWN_RUN_MATCHES,
    zapper_pay_to=ZAPPER_PAY_TO,
)

SEPOLIA_PROFILE = NetworkProfile(
    network_id="sepolia",
    chain=SEPOLIA_CHAIN,
    chain_id=SEPOLIA_CHAIN_ID,
    wallet=SEPOLIA_WALLET,
    usdc_contract=SEPOLIA_USDC_CONTRACT,
    rpc_primary_env=TRUSTFORGE_SEPOLIA_RPC_URL_ENV,
    rpc_fallback_env=TRUSTFORGE_SEPOLIA_RPC_FALLBACK_URLS_ENV,
    default_rpcs=tuple(DEFAULT_SEPOLIA_RPCS),
    observed_balance_usdc=None,
    known_run_matches={},
    zapper_pay_to=None,
)


def resolve_network_profile(network_id: str | None = None) -> NetworkProfile:
    if network_id in (None, "", "mainnet", "base", "8453"):
        return MAINNET_PROFILE
    if network_id in ("sepolia", "base-sepolia", "84532", "testnet"):
        return SEPOLIA_PROFILE
    raise ValueError(f"unsupported network profile: {network_id}")


@dataclass
class SettlementExpectation:
    pay_to: str
    amount_usdc: str
    amount_atomic: str | None = None
    balance_before_usdc: str | None = None


@dataclass
class BaseRpcConfig:
    primary_url: str
    fallback_urls: list[str]
    max_attempts_per_endpoint: int = MAX_ATTEMPTS_PER_ENDPOINT
    timeout_ms: int = RPC_TIMEOUT_SEC * 1000


@dataclass
class RpcDiscarded:
    url: str
    url_redacted: str
    reason: str
    error_class: str


@dataclass
class RpcHealthResult:
    ok: bool
    chain_id: int | None
    latest_block: int | None
    error_class: str | None
    detail: str
    rpc_status: str


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
    schema_version: str = "0.2.0"
    wallet: str = BUYER_WALLET
    usdc_contract: str = USDC_CONTRACT
    chain: str = CHAIN
    selected_rpc: str = ""
    selected_rpc_redacted: str = ""
    rpc_discarded: list[dict[str, str]] = field(default_factory=list)
    rpc_status: str = "not_run"
    rpc_provider_redacted: str = ""
    rpc_fallback_used: bool = False
    chain_id: int | None = None
    latest_block: int | None = None
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
    unattributed_settlements_found: int | None = None
    settlements_checked: list[str] = field(default_factory=list)
    known_settlements_confirmed_onchain: int = 0
    phase6_settlements_identified: list[str] = field(default_factory=list)
    reconciliation_balance_check: str = "not_run"
    balance_identity_status: str = "not_run"
    reconciliation_detail: str = ""
    reconciliation_status: str = RECONCILIATION_RPC_UNAVAILABLE
    error_class: str | None = None
    safe_to_use_for_payment_verification: bool = False
    status: str = "BLOCKED"


def redact_rpc_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url.strip())
    host = parsed.hostname or "unknown"
    path = parsed.path or ""
    if path and path != "/":
        return f"{parsed.scheme}://{host}/..."
    return f"{parsed.scheme}://{host}"


def classify_rpc_error(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code == 403:
            return RECONCILIATION_RPC_FORBIDDEN
        if exc.code == 429:
            return RECONCILIATION_RPC_RATE_LIMITED
        return RECONCILIATION_RPC_UNAVAILABLE
    if isinstance(exc, socket.timeout):
        return RECONCILIATION_RPC_UNAVAILABLE
    if isinstance(exc, TimeoutError):
        return RECONCILIATION_RPC_UNAVAILABLE
    if isinstance(exc, json.JSONDecodeError):
        return RECONCILIATION_INVALID_RESPONSE
    message = str(exc).lower()
    if "403" in message or "forbidden" in message:
        return RECONCILIATION_RPC_FORBIDDEN
    if "429" in message or "rate limit" in message:
        return RECONCILIATION_RPC_RATE_LIMITED
    if "timed out" in message or "timeout" in message:
        return RECONCILIATION_RPC_UNAVAILABLE
    return RECONCILIATION_RPC_UNAVAILABLE


def load_base_rpc_config(profile: NetworkProfile | None = None) -> BaseRpcConfig:
    prof = profile or MAINNET_PROFILE
    primary = os.environ.get(prof.rpc_primary_env, "").strip()
    legacy = os.environ.get(LEGACY_BASE_RPC_URLS_ENV, "").strip() if prof.network_id == "mainnet" else ""
    fallbacks_env = os.environ.get(prof.rpc_fallback_env, "").strip()

    fallback_urls: list[str] = []
    if fallbacks_env:
        fallback_urls.extend(u.strip() for u in fallbacks_env.split(",") if u.strip())
    elif legacy and not primary:
        fallback_urls.extend(u.strip() for u in legacy.split(",") if u.strip())

    if primary:
        endpoint_list = [primary, *fallback_urls]
    elif fallback_urls:
        endpoint_list = fallback_urls
    else:
        endpoint_list = list(prof.default_rpcs)

    deduped: list[str] = []
    seen: set[str] = set()
    for url in endpoint_list:
        if not url or url in seen:
            continue
        seen.add(url)
        deduped.append(url)
        if len(deduped) >= MAX_FALLBACK_ENDPOINTS + 1:
            break

    if not deduped:
        deduped = list(prof.default_rpcs[: MAX_FALLBACK_ENDPOINTS + 1])

    return BaseRpcConfig(
        primary_url=deduped[0],
        fallback_urls=deduped[1:],
    )


def resolve_endpoint_list(config: BaseRpcConfig | None = None, profile: NetworkProfile | None = None) -> list[str]:
    cfg = config or load_base_rpc_config(profile)
    return [cfg.primary_url, *cfg.fallback_urls]


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


class JsonRpcClient:
    def __init__(
        self,
        url: str,
        *,
        usdc_contract: str = USDC_CONTRACT,
        timeout_sec: int = RPC_TIMEOUT_SEC,
        max_attempts: int = MAX_ATTEMPTS_PER_ENDPOINT,
    ) -> None:
        self.url = url
        self.usdc_contract = usdc_contract
        self.timeout_sec = timeout_sec
        self.max_attempts = max(1, max_attempts)
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
                "User-Agent": "trustforge-onchain-reconcile/0.2",
            },
            method="POST",
        )
        last_error: Exception | None = None
        for _ in range(self.max_attempts):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                    raw = resp.read().decode("utf-8")
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError("jsonrpc response is not an object")
                if "error" in body and body["error"]:
                    raise RuntimeError(json.dumps(body["error"]))
                if "result" not in body:
                    raise ValueError("jsonrpc response missing result")
                return body.get("result")
            except Exception as exc:  # noqa: BLE001
                last_error = exc
        raise last_error or RuntimeError("rpc failed")

    def block_number(self) -> int:
        return hex_to_int(self.call("eth_blockNumber", []))

    def chain_id(self) -> int:
        return hex_to_int(self.call("eth_chainId", []))

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
            [{"to": self.usdc_contract, "data": data}, "latest"],
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
            "address": self.usdc_contract,
            "fromBlock": hex(from_block),
            "toBlock": hex(to_block),
            "topics": topics,
        }
        result = self.call("eth_getLogs", [params])
        return result or []


def rpc_health_check(
    url: str,
    config: BaseRpcConfig | None = None,
    *,
    profile: NetworkProfile | None = None,
) -> RpcHealthResult:
    prof = profile or MAINNET_PROFILE
    cfg = config or load_base_rpc_config(prof)
    timeout_sec = max(1, cfg.timeout_ms // 1000)
    try:
        client = JsonRpcClient(
            url,
            usdc_contract=prof.usdc_contract,
            timeout_sec=timeout_sec,
            max_attempts=cfg.max_attempts_per_endpoint,
        )
        chain_id = client.chain_id()
        latest_block = client.block_number()
        if chain_id != prof.chain_id:
            return RpcHealthResult(
                ok=False,
                chain_id=chain_id,
                latest_block=latest_block,
                error_class=RECONCILIATION_WRONG_CHAIN,
                detail=f"expected chainId {prof.chain_id}, got {chain_id}",
                rpc_status="fail",
            )
        if latest_block <= 0:
            return RpcHealthResult(
                ok=False,
                chain_id=chain_id,
                latest_block=latest_block,
                error_class=RECONCILIATION_INVALID_RESPONSE,
                detail="invalid latest block",
                rpc_status="fail",
            )
        to_block = latest_block
        from_block = max(0, to_block - PROBE_WINDOW)
        client.get_logs_window(from_block, to_block)
        return RpcHealthResult(
            ok=True,
            chain_id=chain_id,
            latest_block=latest_block,
            error_class=None,
            detail="eth_chainId/eth_blockNumber/eth_getLogs probe ok",
            rpc_status="pass",
        )
    except Exception as exc:  # noqa: BLE001
        error_class = classify_rpc_error(exc)
        return RpcHealthResult(
            ok=False,
            chain_id=None,
            latest_block=None,
            error_class=error_class,
            detail=str(exc)[:200],
            rpc_status="fail",
        )


def select_rpc(
    urls: list[str],
    config: BaseRpcConfig | None = None,
    profile: NetworkProfile | None = None,
) -> tuple[str | None, list[RpcDiscarded], RpcHealthResult | None, bool]:
    prof = profile or MAINNET_PROFILE
    cfg = config or load_base_rpc_config(prof)
    discarded: list[RpcDiscarded] = []
    fallback_used = False
    for index, url in enumerate(urls):
        health = rpc_health_check(url, cfg, profile=prof)
        if health.ok:
            return url, discarded, health, fallback_used or index > 0
        discarded.append(
            RpcDiscarded(
                url=url,
                url_redacted=redact_rpc_url(url),
                reason=health.detail,
                error_class=health.error_class or RECONCILIATION_RPC_UNAVAILABLE,
            )
        )
        fallback_used = fallback_used or index == 0
    return None, discarded, None, fallback_used


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
    profile: NetworkProfile,
    settlement_expectation: SettlementExpectation | None = None,
    *,
    deadline_monotonic: float | None = None,
) -> tuple[list[SettlementRow], int]:
    wallet_topic = pad_topic_address(wallet)
    rows: list[SettlementRow] = []
    windows = paginate_range(from_block, to_block, window)
    for w_from, w_to in windows:
        if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic:
            raise RpcDeadlineExceeded("global reconciliation deadline exceeded")
        if direction == "out":
            topics: list[Any] = [TRANSFER_TOPIC, wallet_topic]
        else:
            topics = [TRANSFER_TOPIC, None, wallet_topic]
        logs = client.call(
            "eth_getLogs",
            [
                {
                    "address": client.usdc_contract,
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
            known = profile.known_run_matches.get(tx_hash.lower())
            source = "known" if known else "discovered"
            matched: str | None = known
            if not matched and settlement_expectation and direction == "out":
                exp_atomic = (
                    int(settlement_expectation.amount_atomic)
                    if settlement_expectation.amount_atomic
                    else int(
                        (Decimal(settlement_expectation.amount_usdc) * 1_000_000).to_integral_value(
                            rounding=ROUND_DOWN
                        )
                    )
                )
                if (
                    to_addr.lower() == settlement_expectation.pay_to.lower()
                    and amount_atomic == exp_atomic
                ):
                    matched = "Sepolia_settlement_proof"
            if not matched and direction == "out" and profile.zapper_pay_to:
                if to_addr.lower() == profile.zapper_pay_to.lower() and amount_atomic == 1125:
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


def resolve_from_block(
    client: JsonRpcClient,
    profile: NetworkProfile,
    margin: int = 1000,
    to_block: int | None = None,
) -> int:
    if profile.network_id == "sepolia":
        latest = to_block if to_block is not None else client.block_number()
        return max(0, latest - 50_000)
    t0c = "0xb445f8c1091a55ac35d23db38371a0e0d0bbb0bf2564e3ddf9843abea70cfb11"
    tx = client.call("eth_getTransactionByHash", [t0c])
    if tx and tx.get("blockNumber"):
        block = hex_to_int(tx["blockNumber"])
        return max(0, block - margin)
    return 47_310_000


def match_phase6_runs(outflows: list[SettlementRow], profile: NetworkProfile) -> list[str]:
    if profile.network_id != "mainnet" or not profile.zapper_pay_to:
        return []
    phase6: list[str] = []
    for row in outflows:
        if row.tx_hash in profile.known_run_matches:
            continue
        if row.value_atomic != "1125":
            continue
        if row.to.lower() != profile.zapper_pay_to.lower():
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
        f"- **Reconciliation status:** {ledger.reconciliation_status}",
        f"- **Wallet:** `{ledger.wallet}`",
        f"- **RPC (redacted):** `{ledger.rpc_provider_redacted or ledger.selected_rpc_redacted}`",
        f"- **Scanned blocks:** {ledger.scanned_from_block} → {ledger.scanned_to_block} ({ledger.windows_scanned} windows)",
        f"- **Current balance (on-chain):** {ledger.current_balance_usdc} USDC",
        f"- **Observed balance (Basescan):** {ledger.observed_balance_usdc} USDC",
        f"- **Total outflows:** {ledger.total_outflows_usdc} USDC",
        f"- **Total inflows:** {ledger.total_inflows_usdc} USDC",
        f"- **Reconciliation:** {ledger.reconciliation_balance_check} — {ledger.reconciliation_detail}",
        f"- **Safe for payment verification:** {ledger.safe_to_use_for_payment_verification}",
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
    lines.extend(["", "## RPC discarded", ""])
    for d in ledger.rpc_discarded:
        lines.append(f"- `{d.get('url_redacted', d.get('url', 'unknown'))}`: {d['reason']}")
    return "\n".join(lines) + "\n"


def _apply_rpc_failure(
    result: ReconciliationResult,
    discarded: list[RpcDiscarded],
    error_class: str,
    detail: str,
) -> ReconciliationResult:
    result.rpc_discarded = [asdict(d) for d in discarded]
    result.error_class = error_class
    result.reconciliation_status = error_class
    result.status = "BLOCKED"
    result.rpc_status = "fail"
    result.balance_identity_status = "not_run"
    result.reconciliation_balance_check = "not_run"
    result.unattributed_settlements_found = None
    result.safe_to_use_for_payment_verification = False
    result.reconciliation_detail = detail
    return result


def run_reconciliation(
    *,
    output_dir: Path | None = None,
    window: int = DEFAULT_WINDOW,
    config: BaseRpcConfig | None = None,
    profile: NetworkProfile | None = None,
    settlement_expectation: SettlementExpectation | None = None,
    max_total_runtime_seconds: int | None = None,
) -> ReconciliationResult:
    prof = profile or MAINNET_PROFILE
    cfg = config or load_base_rpc_config(prof)
    deadline_monotonic = (
        time.monotonic() + max(1, max_total_runtime_seconds)
        if max_total_runtime_seconds is not None
        else None
    )
    urls = resolve_endpoint_list(cfg, prof)
    selected, discarded, health, fallback_used = select_rpc(urls, cfg, prof)
    result = ReconciliationResult(
        wallet=prof.wallet,
        usdc_contract=prof.usdc_contract,
        chain=prof.chain,
        rpc_discarded=[asdict(d) for d in discarded],
        rpc_fallback_used=fallback_used,
    )

    if not selected or not health:
        top_error = discarded[-1].error_class if discarded else RECONCILIATION_RPC_UNAVAILABLE
        return _apply_rpc_failure(
            result,
            discarded,
            top_error,
            "no RPC passed eth_chainId/eth_blockNumber/eth_getLogs health preflight",
        )

    result.selected_rpc = selected
    result.selected_rpc_redacted = redact_rpc_url(selected)
    result.rpc_provider_redacted = result.selected_rpc_redacted
    result.rpc_status = health.rpc_status
    result.chain_id = health.chain_id
    result.latest_block = health.latest_block

    client = JsonRpcClient(
        selected,
        usdc_contract=prof.usdc_contract,
        timeout_sec=max(1, cfg.timeout_ms // 1000),
        max_attempts=cfg.max_attempts_per_endpoint,
    )
    to_block = client.block_number()
    from_block = resolve_from_block(client, prof, to_block=to_block)
    result.scanned_from_block = from_block
    result.scanned_to_block = to_block

    try:
        outflows, windows_scanned = scan_transfers(
            client,
            from_block,
            to_block,
            prof.wallet,
            "out",
            window,
            prof,
            settlement_expectation,
            deadline_monotonic=deadline_monotonic,
        )
        result.windows_scanned = windows_scanned
        inflows, _ = scan_transfers(
            client,
            from_block,
            to_block,
            prof.wallet,
            "in",
            window,
            prof,
            settlement_expectation,
            deadline_monotonic=deadline_monotonic,
        )
        result.inflows = [asdict(r) for r in inflows]
        balance_atomic, balance_usdc = client.balance_of_usdc(prof.wallet)
        _ = balance_atomic
    except RpcDeadlineExceeded as exc:
        return _apply_rpc_failure(
            result,
            discarded,
            RECONCILIATION_RPC_TIMEOUT,
            str(exc),
        )
    except Exception as exc:  # noqa: BLE001
        error_class = classify_rpc_error(exc)
        return _apply_rpc_failure(
            result,
            discarded,
            error_class,
            f"event scan failed after RPC health passed: {str(exc)[:200]}",
        )

    result.current_balance_usdc = balance_usdc
    observed_target = prof.observed_balance_usdc
    if settlement_expectation and settlement_expectation.balance_before_usdc:
        observed_target = Decimal(settlement_expectation.balance_before_usdc) - Decimal(
            settlement_expectation.amount_usdc
        )
    if observed_target is not None:
        result.observed_balance_usdc = str(observed_target)
        result.current_balance_onchain_confirmed = abs(
            Decimal(balance_usdc) - observed_target
        ) < Decimal("0.000001")
    else:
        result.current_balance_onchain_confirmed = True
    result.balance_identity_status = (
        "pass" if result.current_balance_onchain_confirmed else "fail"
    )

    outflow_values = [r.value_usdc for r in outflows]
    inflow_values = [r.value_usdc for r in inflows]
    result.total_outflows_usdc = sum_usdc(outflow_values)
    result.total_inflows_usdc = sum_usdc(inflow_values)

    confirmed = 0
    for row in outflows:
        known_match = prof.known_run_matches.get(row.tx_hash.lower())
        if known_match:
            row.matched_run = known_match
            row.source = "known"
            confirmed += 1

    phase6_hashes = match_phase6_runs(outflows, prof)
    result.phase6_settlements_identified = phase6_hashes
    for row in outflows:
        if row.tx_hash in phase6_hashes and not row.matched_run:
            row.matched_run = "Phase6_onchain"

    result.known_settlements_confirmed_onchain = confirmed
    result.settlements = [asdict(r) for r in outflows]
    result.settlements_checked = [r.tx_hash for r in outflows]
    result.unattributed_settlements = [
        asdict(r) for r in outflows if r.source == "discovered" and not r.matched_run
    ]
    result.unattributed_settlements_found = len(result.unattributed_settlements)

    net = Decimal(result.total_inflows_usdc) - Decimal(result.total_outflows_usdc)
    phase6_out = sum(
        Decimal(r.value_usdc)
        for r in outflows
        if r.tx_hash in phase6_hashes or (r.matched_run or "").startswith("Phase6")
    )
    details: list[str] = []
    if observed_target is not None:
        if result.current_balance_onchain_confirmed:
            details.append(
                f"on-chain balance {balance_usdc} matches observed {observed_target}"
            )
        else:
            details.append(
                f"on-chain balance {balance_usdc} differs from observed {observed_target}"
            )
    else:
        details.append(f"on-chain balance {balance_usdc} (no fixed observed target for {prof.network_id})")

    if prof.network_id == "mainnet":
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

    if result.unattributed_settlements_found and result.unattributed_settlements_found > 0:
        result.reconciliation_status = RECONCILIATION_UNATTRIBUTED_SETTLEMENTS
        result.status = "BLOCKED"
    elif not outflows and balance_ok:
        result.reconciliation_status = RECONCILIATION_NO_NEW_SETTLEMENT
        result.status = "COMPLETE"
    elif result.unattributed_settlements_found == 0 and balance_ok:
        result.reconciliation_status = RECONCILIATION_PASS
        result.status = "COMPLETE"
    else:
        result.reconciliation_status = RECONCILIATION_UNATTRIBUTED_SETTLEMENTS
        result.status = "BLOCKED"

    result.safe_to_use_for_payment_verification = (
        result.rpc_status == "pass"
        and result.chain_id == prof.chain_id
        and result.windows_scanned > 0
        and result.balance_identity_status == "pass"
        and result.reconciliation_status
        in (RECONCILIATION_PASS, RECONCILIATION_NO_NEW_SETTLEMENT)
        and result.unattributed_settlements_found == 0
    )

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
    unattr_count = (
        "null"
        if ledger.unattributed_settlements_found is None
        else str(ledger.unattributed_settlements_found)
    )
    return "\n".join(
        [
            "RESULT",
            f"trustforge_onchain_reconciliation_status: {ledger.status}",
            f"reconciliation_status: {ledger.reconciliation_status}",
            "repo: D:\\agentic-payments-lab",
            "strict_no_payment: yes",
            "wallet_loaded: no",
            f"rpc_status: {ledger.rpc_status}",
            f"rpc_provider_redacted: {ledger.rpc_provider_redacted or 'null'}",
            f"rpc_fallback_used: {'yes' if ledger.rpc_fallback_used else 'no'}",
            f"rpc_chain_id: {ledger.chain_id if ledger.chain_id is not None else 'null'}",
            f"rpc_latest_block: {ledger.latest_block if ledger.latest_block is not None else 'null'}",
            f"error_class: {ledger.error_class or 'null'}",
            f"scanned_from_block: {ledger.scanned_from_block}",
            f"scanned_to_block: {ledger.scanned_to_block}",
            f"windows_scanned: {ledger.windows_scanned}",
            f"total_outflow_settlements_found: {len(ledger.settlements)}",
            f"total_outflow_usdc: {ledger.total_outflows_usdc}",
            f"current_balance_onchain_usdc: {ledger.current_balance_usdc}",
            f"current_balance_confirmed_onchain: {'yes' if ledger.current_balance_onchain_confirmed else 'no'}",
            f"reconciliation_balance_check: {ledger.reconciliation_balance_check}",
            f"balance_identity_status: {ledger.balance_identity_status}",
            f"known_settlements_confirmed_onchain: {ledger.known_settlements_confirmed_onchain}",
            f"unattributed_settlements_found: {unattr_count}",
            f"unattributed_tx_hashes: {','.join(unattr) if unattr else 'none'}",
            f"safe_to_use_for_payment_verification: {'yes' if ledger.safe_to_use_for_payment_verification else 'no'}",
            f"phase6_settlements_identified: {len(ledger.phase6_settlements_identified)} "
            f"({','.join(ledger.phase6_settlements_identified) if ledger.phase6_settlements_identified else 'none'})",
            f"ledger_json: {json_path}",
            f"ledger_md: {md_path}",
            "secrets_printed: no",
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
    parser.add_argument(
        "--network",
        choices=["mainnet", "sepolia"],
        default="mainnet",
        help="Base network profile (mainnet=8453, sepolia=84532)",
    )
    parser.add_argument("--expected-pay-to", default=None, help="Sepolia settlement proof payTo filter")
    parser.add_argument("--expected-amount-usdc", default=None, help="Expected settlement USDC amount")
    parser.add_argument("--expected-amount-atomic", default=None, help="Expected settlement atomic amount")
    parser.add_argument("--balance-before-usdc", default=None, help="Wallet USDC balance before settlement")
    parser.add_argument(
        "--rpc-request-timeout-seconds",
        type=int,
        default=RPC_TIMEOUT_SEC,
        help="Per-request RPC timeout in seconds",
    )
    parser.add_argument(
        "--rpc-max-retries",
        type=int,
        default=MAX_ATTEMPTS_PER_ENDPOINT,
        help="Maximum retries per RPC endpoint",
    )
    parser.add_argument(
        "--max-total-runtime-seconds",
        type=int,
        default=None,
        help="Global reconciliation deadline in seconds",
    )
    args = parser.parse_args(argv)

    prof = resolve_network_profile(args.network)
    cfg = load_base_rpc_config(prof)
    cfg = BaseRpcConfig(
        primary_url=cfg.primary_url,
        fallback_urls=cfg.fallback_urls,
        max_attempts_per_endpoint=max(1, args.rpc_max_retries),
        timeout_ms=max(1, args.rpc_request_timeout_seconds) * 1000,
    )
    settlement: SettlementExpectation | None = None
    if args.expected_pay_to and args.expected_amount_usdc:
        settlement = SettlementExpectation(
            pay_to=args.expected_pay_to,
            amount_usdc=args.expected_amount_usdc,
            amount_atomic=args.expected_amount_atomic,
            balance_before_usdc=args.balance_before_usdc,
        )

    out = args.output_dir
    if out is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        subdir = "onchain-reconciliation-sepolia" if prof.network_id == "sepolia" else "onchain-reconciliation"
        out = Path(r"D:\trustforge\artifacts\runs") / subdir / f"run_{stamp}"

    ledger = run_reconciliation(
        output_dir=out,
        window=args.window,
        profile=prof,
        settlement_expectation=settlement,
        config=cfg,
        max_total_runtime_seconds=args.max_total_runtime_seconds,
    )
    print(format_result(ledger, out / "onchain_settlement_ledger.json", out / "onchain_settlement_ledger.md"))
    return 0 if ledger.safe_to_use_for_payment_verification else 1


if __name__ == "__main__":
    sys.exit(main())
