#!/usr/bin/env python3
"""Build reproducible goal-context data from local Collector JSONL (API requests: 0)."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from analysis.live_goal_context import analyze_events, load_event_files, write_result  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", action="append", type=Path, help="events.jsonl path (repeatable); defaults to all Collector sessions")
    parser.add_argument("--output", type=Path, help="derived output directory")
    parser.add_argument("--fixture-id", help="analyze one fixture only")
    parser.add_argument("--windows", default="5,10", help="comma-separated match-minute windows")
    args = parser.parse_args()

    paths = args.input or sorted((ROOT / "data/goal_api_test/collector").glob("*/events.jsonl"))
    paths = [path if path.is_absolute() else ROOT / path for path in paths]
    windows = tuple(sorted({int(value) for value in args.windows.split(",") if int(value) > 0}))
    events = load_event_files(paths)
    if args.fixture_id:
        events = [event for event in events if str(event.get("fixtureId")) == args.fixture_id]
    result = analyze_events(events, windows)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = args.output or ROOT / "data/goal_api_test/derived/goal_context" / stamp
    output = output if output.is_absolute() else ROOT / output
    write_result(result, output)
    print(f"API requests: 0")
    print(f"Input files: {len(paths)}")
    print(f"Fixtures: {result.summary['fixtureCount']}")
    print(f"Observations: {result.summary['observationCount']}")
    print(f"Goals observed during monitoring: {result.summary['goalsObservedDuringMonitoring']}")
    print(f"Analyzable goals: {result.summary['analyzableGoals']}")
    print(f"Output: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
