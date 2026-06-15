"""Offline tests for onchain_settlement_reconciliation (no live RPC)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "trustforge"))

from onchain_settlement_reconciliation import (  # noqa: E402
    BUYER_WALLET,
    atomic_to_usdc,
    paginate_range,
    pad_topic_address,
    sum_usdc,
    unpad_topic_address,
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
    # initial - net_out should equal current for this synthetic fixture
    initial_micro = int(float(initial) * 1_000_000)
    out_micro = int(float(net_out) * 1_000_000)
    current_micro = int(float(current) * 1_000_000)
    assert initial_micro - out_micro == current_micro
