#!/usr/bin/env python3
"""Capture one minimal-request GOAL API snapshot for four specified matches."""

from __future__ import annotations

import sys
from pathlib import Path

import goal_api_live_statistics_test as capture


capture.TARGETS = (
    ("Lecce vs AS Roma", "cmt1fhs1376t5pd07w4x7eqva"),
    ("Levadiakos vs Panathinaikos", "cmsvp4sot9e5lpg07372wbt6i"),
    ("FC Copenhagen vs Sonderjyske", "cmt1fhubu7720pd07xwvc8c5b"),
    ("Burgos CF vs Real Sociedad B", "cmt1fhuc37722pd07sw4nwabw"),
)


def main() -> int:
    if "--output-dir" not in sys.argv:
        output_dir = Path(__file__).parent / "data" / "goal_api_test" / "four_match_snapshot"
        sys.argv.extend(("--output-dir", str(output_dir)))
    print("想定APIリクエスト数: 5回（fixtures/live 1回 + statistics 4回）", flush=True)
    return capture.main()


if __name__ == "__main__":
    raise SystemExit(main())
