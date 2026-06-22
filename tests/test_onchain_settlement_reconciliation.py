"""Offline tests for onchain_settlement_reconciliation (no live RPC)."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "trustforge"))

from onchain_settlement_reconciliation import (  # noqa: E402
    BASE_CHAIN_ID,
    BUYER_WALLET,
    RECONCILIATION_INVALID_RESPONSE,
    RECONCILIATION_NO_NEW_SETTLEMENT,
    RECONCILIATION_PASS,
    RECONCILIATION_RPC_FORBIDDEN,
    RECONCILIATION_RPC_RATE_LIMITED,
    RECONCILIATION_RPC_TIMEOUT,
    RECONCILIATION_RPC_UNAVAILABLE,
    RECONCILIATION_UNATTRIBUTED_SETTLEMENTS,
    SEPOLIA_CHAIN_ID,
    SEPOLIA_PROFILE,
    SettlementExpectation,
    BaseRpcConfig,
    JsonRpcClient,
    atomic_to_usdc,
    classify_rpc_error,
    load_base_rpc_config,
    paginate_range,
    pad_topic_address,
    redact_rpc_url,
    rpc_health_check,
    run_reconciliation,
    select_rpc,
    sum_usdc,
    unpad_topic_address,
    resolve_network_profile,
)


def test_pad_topic_address():
    padded = pad_topic_address(BUYER_WALLET)
    assert padded == (
        "0x0000000000000000000000004cf373373aba89b9bbd5a428fd71831bcbc7d0c1"
    )
    assert len(padded) == 66


def test_unpad_topic_address():
    topic = pad_topic_address(BUYER_WALLET)
    assert unpad_topic_address(topic) == BUYER_WALLET.lower()


def test_atomic_to_usdc():
    assert atomic_to_usdc(1125) == "0.001125"
    assert atomic_to_usdc(1000) == "0.001"
    assert atomic_to_usdc(51472) == "0.051472"


def test_pagination_covers_range_without_gaps():
    windows = paginate_range(100, 5500, 2000)
    assert windows[0] == (100, 2099)
    assert windows[-1][1] == 5500
    for i in range(len(windows) - 1):
        assert windows[i][1] + 1 == windows[i + 1][0]


def test_sum_usdc():
    assert sum_usdc(["0.001", "0.001125", "0.001125"]) == "0.00325"


def test_balance_identity_fixture():
    initial = "0.055722"
    outflows = ["0.001", "0.001125", "0.001125"]
    current = "0.052472"
    net_out = sum_usdc(outflows)
    initial_micro = int(float(initial) * 1_000_000)
    out_micro = int(float(net_out) * 1_000_000)
    current_micro = int(float(current) * 1_000_000)
    assert initial_micro - out_micro == current_micro


def test_redact_rpc_url_hides_path_and_keys():
    assert redact_rpc_url("https://base-mainnet.g.alchemy.com/v2/secret-key") == (
        "https://base-mainnet.g.alchemy.com/..."
    )
    assert redact_rpc_url("https://mainnet.base.org") == "https://mainnet.base.org"


def test_classify_rpc_error_distinct_classes():
    assert classify_rpc_error(urllib.error.HTTPError("url", 403, "", {}, None)) == (
        RECONCILIATION_RPC_FORBIDDEN
    )
    assert classify_rpc_error(urllib.error.HTTPError("url", 429, "", {}, None)) == (
        RECONCILIATION_RPC_RATE_LIMITED
    )
    assert classify_rpc_error(json.JSONDecodeError("bad", "doc", 0)) == (
        RECONCILIATION_INVALID_RESPONSE
    )


def _rpc_response(payload: dict) -> MagicMock:
    body = json.dumps(payload).encode("utf-8")
    resp = MagicMock()
    resp.read.return_value = body
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = False
    return resp


def test_rpc_health_primary_success(monkeypatch):
    calls: list[str] = []

    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        payload = json.loads(req.data.decode("utf-8"))
        calls.append(payload["method"])
        if payload["method"] == "eth_chainId":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(BASE_CHAIN_ID)})
        if payload["method"] == "eth_blockNumber":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(1000)})
        if payload["method"] == "eth_getLogs":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": []})
        raise AssertionError(f"unexpected method {payload['method']}")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    health = rpc_health_check("https://mainnet.base.org")
    assert health.ok is True
    assert health.chain_id == BASE_CHAIN_ID
    assert health.latest_block == 1000


def test_rpc_health_primary_403_then_fallback_success(monkeypatch):
    state = {"count": 0}

    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        url = req.full_url
        if "bad.example" in url:
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
        payload = json.loads(req.data.decode("utf-8"))
        if payload["method"] == "eth_chainId":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(BASE_CHAIN_ID)})
        if payload["method"] == "eth_blockNumber":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(2000)})
        if payload["method"] == "eth_getLogs":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": []})
        raise AssertionError(payload["method"])

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    selected, discarded, health, fallback_used = select_rpc(
        ["https://bad.example/rpc", "https://good.example/rpc"],
        BaseRpcConfig(primary_url="https://bad.example/rpc", fallback_urls=["https://good.example/rpc"]),
    )
    assert selected == "https://good.example/rpc"
    assert fallback_used is True
    assert health and health.ok
    assert discarded[0].error_class == RECONCILIATION_RPC_FORBIDDEN


def test_rpc_health_primary_429_classified(monkeypatch):
    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    health = rpc_health_check("https://rate-limited.example/rpc")
    assert health.ok is False
    assert health.error_class == RECONCILIATION_RPC_RATE_LIMITED


def test_rpc_health_wrong_chain(monkeypatch):
    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        payload = json.loads(req.data.decode("utf-8"))
        if payload["method"] == "eth_chainId":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(1)})
        if payload["method"] == "eth_blockNumber":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(1000)})
        raise AssertionError(payload["method"])

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    health = rpc_health_check("https://mainnet.base.org")
    assert health.ok is False
    assert health.error_class == "RECONCILIATION_WRONG_CHAIN"


def test_rpc_health_malformed_json(monkeypatch):
    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        resp = MagicMock()
        resp.read.return_value = b"not-json"
        resp.__enter__.return_value = resp
        resp.__exit__.return_value = False
        return resp

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    health = rpc_health_check("https://mainnet.base.org")
    assert health.ok is False
    assert health.error_class == RECONCILIATION_INVALID_RESPONSE


def test_all_rpcs_fail_returns_unavailable(monkeypatch):
    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    ledger = run_reconciliation(
        config=BaseRpcConfig(
            primary_url="https://bad1.example/rpc",
            fallback_urls=["https://bad2.example/rpc"],
        ),
    )
    assert ledger.reconciliation_status == RECONCILIATION_RPC_FORBIDDEN
    assert ledger.safe_to_use_for_payment_verification is False
    assert ledger.unattributed_settlements_found is None


def test_rpc_failure_is_not_settlement_not_found(monkeypatch):
    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    ledger = run_reconciliation(
        config=BaseRpcConfig(primary_url="https://bad.example/rpc", fallback_urls=[]),
    )
    assert ledger.reconciliation_status != RECONCILIATION_UNATTRIBUTED_SETTLEMENTS
    assert "settlement_not_found" not in ledger.reconciliation_detail.lower()


def test_reconciliation_pass_when_unattributed_zero_and_balance_pass(monkeypatch):
    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        payload = json.loads(req.data.decode("utf-8"))
        method = payload["method"]
        if method == "eth_chainId":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(BASE_CHAIN_ID)})
        if method == "eth_blockNumber":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(5000)})
        if method == "eth_getLogs":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": []})
        if method == "eth_getTransactionByHash":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": {"blockNumber": hex(1000)}})
        if method == "eth_call":
            # 51472 atomic = 0.051472 USDC observed balance
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(51472)})
        raise AssertionError(method)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    ledger = run_reconciliation(
        config=BaseRpcConfig(primary_url="https://mainnet.base.org", fallback_urls=[]),
        window=5000,
    )
    assert ledger.reconciliation_status == RECONCILIATION_NO_NEW_SETTLEMENT
    assert ledger.unattributed_settlements_found == 0
    assert ledger.balance_identity_status == "pass"
    assert ledger.safe_to_use_for_payment_verification is True


def test_load_base_rpc_config_prefers_env_primary(monkeypatch):
    monkeypatch.setenv("TRUSTFORGE_BASE_RPC_URL", "https://primary.example/rpc")
    monkeypatch.setenv(
        "TRUSTFORGE_BASE_RPC_FALLBACK_URLS",
        "https://fallback1.example/rpc,https://fallback2.example/rpc",
    )
    cfg = load_base_rpc_config()
    assert cfg.primary_url == "https://primary.example/rpc"
    assert cfg.fallback_urls == [
        "https://fallback1.example/rpc",
        "https://fallback2.example/rpc",
    ]


def test_json_rpc_client_single_attempt(monkeypatch):
    attempts = {"count": 0}

    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        attempts["count"] += 1
        raise urllib.error.HTTPError(req.full_url, 500, "err", {}, None)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    client = JsonRpcClient("https://mainnet.base.org", max_attempts=1)
    with pytest.raises(Exception):
        client.call("eth_chainId", [])
    assert attempts["count"] == 1


def test_resolve_network_profile_sepolia():
    prof = resolve_network_profile("sepolia")
    assert prof.chain_id == SEPOLIA_CHAIN_ID
    assert prof.usdc_contract.lower() == "0x036cbd53842c5426634e7929541ec2318f3dcf7e"


def test_sepolia_rpc_wrong_chain_refused(monkeypatch):
    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        payload = json.loads(req.data.decode("utf-8"))
        if payload["method"] == "eth_chainId":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(BASE_CHAIN_ID)})
        if payload["method"] == "eth_blockNumber":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(1000)})
        raise AssertionError(payload["method"])

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    health = rpc_health_check("https://sepolia.base.org", profile=SEPOLIA_PROFILE)
    assert health.ok is False
    assert health.error_class == "RECONCILIATION_WRONG_CHAIN"


def test_sepolia_settlement_expectation_marks_proof(monkeypatch):
    pay_to = "0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392"

    def fake_urlopen(req, timeout=30):  # noqa: ARG001
        payload = json.loads(req.data.decode("utf-8"))
        method = payload["method"]
        if method == "eth_chainId":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(SEPOLIA_CHAIN_ID)})
        if method == "eth_blockNumber":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(5000)})
        if method == "eth_getLogs":
            return _rpc_response(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": [
                        {
                            "transactionHash": "0x" + "ab" * 32,
                            "blockNumber": hex(4000),
                            "logIndex": hex(0),
                            "data": hex(1000),
                            "topics": [
                                "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                                "0x" + "0" * 24 + SEPOLIA_PROFILE.wallet[2:].lower(),
                                "0x" + "0" * 24 + pay_to[2:].lower(),
                            ],
                        }
                    ],
                }
            )
        if method == "eth_getTransactionReceipt":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": {"status": "0x1"}})
        if method == "eth_getBlockByNumber":
            return _rpc_response(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {"timestamp": hex(1_700_000_000)},
                }
            )
        if method == "eth_call":
            return _rpc_response({"jsonrpc": "2.0", "id": 1, "result": hex(19_999_000)})
        raise AssertionError(method)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    ledger = run_reconciliation(
        config=BaseRpcConfig(primary_url="https://sepolia.base.org", fallback_urls=[]),
        profile=SEPOLIA_PROFILE,
        window=5000,
        settlement_expectation=SettlementExpectation(
            pay_to=pay_to,
            amount_usdc="0.001",
            amount_atomic="1000",
            balance_before_usdc="20",
        ),
    )
    assert ledger.reconciliation_status == RECONCILIATION_PASS
    assert ledger.unattributed_settlements_found == 0
    assert any(
        s.get("matched_run") == "Sepolia_settlement_proof" for s in ledger.settlements
    )


def test_global_deadline_returns_rpc_timeout(monkeypatch):
    def slow_urlopen(*_args, **_kwargs):
        raise TimeoutError("timed out")

    monkeypatch.setattr("urllib.request.urlopen", slow_urlopen)
    ledger = run_reconciliation(
        config=BaseRpcConfig(
            primary_url="https://sepolia.base.org",
            fallback_urls=[],
            timeout_ms=1000,
            max_attempts_per_endpoint=1,
        ),
        profile=SEPOLIA_PROFILE,
        max_total_runtime_seconds=1,
    )
    assert ledger.reconciliation_status in {
        RECONCILIATION_RPC_UNAVAILABLE,
        RECONCILIATION_RPC_TIMEOUT,
        RECONCILIATION_INVALID_RESPONSE,
    }
    assert ledger.safe_to_use_for_payment_verification is False
