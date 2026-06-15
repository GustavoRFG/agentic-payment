#!/usr/bin/env python3
"""CLI runner for read-only on-chain USDC settlement reconciliation."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "trustforge"))

from onchain_settlement_reconciliation import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
