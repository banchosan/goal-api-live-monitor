#!/usr/bin/env python3
"""Track duplicate GOAL API statistics across a small number of live cycles."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


BASE_URL = "https://api.goal-api.com/v1"
TARGETS = (
    ("Lecce vs AS Roma", "cmt1fhs1376t5pd07w4x7eqva"),
    ("Levadiakos vs Panathinaikos", "cmsvp4sot9e5lpg07372wbt6i"),
)
TRACKED_TYPES = (
    "On Target", "Shots On Goal", "Off Target", "Shots Off Goal",
    "Corners", "Ball Possession", "Shots Total", "Shots Blocked",
    "Shots Inside Box", "Shots Outside Box",
)


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            os.environ.setdefault(key, value)


def request_json(path: str, api_key: str, timeout: float) -> tuple[Any, datetime]:
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": "Goalise-GOAL-API-duplicate-statistics-test/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read()
        received = datetime.now(timezone.utc)
    return json.loads(body), received


def iso_utc(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_jst(value: datetime) -> str:
    return value.astimezone(ZoneInfo("Asia/Tokyo")).isoformat(timespec="milliseconds")


def save_json(value: Any, directory: Path, filename: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / filename
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path.resolve()


def find_key(value: Any, key: str) -> tuple[bool, Any]:
    if isinstance(value, dict):
        if key in value:
            return True, value[key]
        for child in value.values():
            found, result = find_key(child, key)
            if found:
                return True, result
    elif isinstance(value, list):
        for child in value:
            found, result = find_key(child, key)
            if found:
                return True, result
    return False, None


def fixtures(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        for key in ("data", "response", "fixtures"):
            if isinstance(payload.get(key), list):
                return [item for item in payload[key] if isinstance(item, dict)]
    return [item for item in payload if isinstance(item, dict)] if isinstance(payload, list) else []


def full_time_rows(payload: Any) -> list[dict[str, Any]]:
    found, value = find_key(payload, "fullTime")
    if not found or not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def occurrences(rows: list[dict[str, Any]], stat_type: str) -> list[dict[str, Any]]:
    return [
        {"position": index + 1, "occurrence": count + 1, "home": row.get("home"), "away": row.get("away")}
        for count, (index, row) in enumerate(
            (item for item in enumerate(rows) if item[1].get("type") == stat_type)
        )
    ]


def numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*%?\s*", value)
        if match:
            return float(match.group(1))
    return None


def first_pair(rows: list[dict[str, Any]], stat_type: str) -> dict[str, Any] | None:
    return next((row for row in rows if row.get("type") == stat_type), None)


def equation_check(rows: list[dict[str, Any]], parts: tuple[str, ...]) -> dict[str, Any]:
    total = first_pair(rows, "Shots Total")
    selected_parts = [first_pair(rows, name) for name in parts]
    result: dict[str, Any] = {"equation": f"Shots Total = {' + '.join(parts)}", "home": {}, "away": {}}
    for side in ("home", "away"):
        total_value = numeric(total.get(side)) if total else None
        values = [numeric(row.get(side)) if row else None for row in selected_parts]
        if total_value is None or any(value is None for value in values):
            result[side] = {"status": "MISSING", "total": total_value, "parts": values, "difference": None}
        else:
            part_sum = sum(value for value in values if value is not None)
            difference = total_value - part_sum
            result[side] = {
                "status": "EXACT" if difference == 0 else "DIFFERENT",
                "total": total_value,
                "parts": values,
                "partsSum": part_sum,
                "difference": difference,
            }
    return result


def fixture_snapshot(live_payload: Any, fixture_id: str) -> dict[str, Any] | None:
    return next((item for item in fixtures(live_payload) if str(item.get("id")) == fixture_id), None)


def fmt_pair(items: list[dict[str, Any]]) -> str:
    if not items:
        return "MISSING"
    return " | ".join(f"#{item['occurrence']}@{item['position']}={item['home']}-{item['away']}" for item in items)


def main() -> int:
    parser = argparse.ArgumentParser(description="Track duplicate GOAL API statistics without using Goalise.")
    parser.add_argument("--cycles", type=int, choices=(1, 2, 3), default=2)
    parser.add_argument("--interval", type=float, default=60.0)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--env-file", type=Path, default=Path(__file__).with_name(".env"))
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "data" / "goal_api_test" / "duplicate_tracking")
    args = parser.parse_args()
    if args.interval < 0:
        parser.error("--interval は0以上にしてください")

    load_dotenv(args.env_file)
    api_key = os.getenv("GOAL_API_KEY", "").strip()
    if not api_key:
        print("GOAL_API_KEYが未設定です。", file=sys.stderr)
        return 2

    expected = args.cycles * (1 + len(TARGETS))
    print(f"想定APIリクエスト数: {expected}回（{args.cycles}サイクル × 3回）", flush=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    run_dir = args.output_dir / run_id
    history: dict[str, list[dict[str, Any]]] = {label: [] for label, _ in TARGETS}
    request_count = 0
    saved: list[str] = []

    try:
        for cycle in range(1, args.cycles + 1):
            print(f"\n=== Cycle {cycle}/{args.cycles} ===", flush=True)
            request_count += 1
            live_payload, live_at = request_json("/fixtures/live", api_key, args.timeout)
            live_path = save_json(live_payload, run_dir, f"cycle_{cycle:02d}_fixtures_live_raw.json")
            saved.append(str(live_path))
            print(f"fixtures/live受信: {iso_utc(live_at)} / {iso_jst(live_at)}", flush=True)

            for label, fixture_id in TARGETS:
                fixture = fixture_snapshot(live_payload, fixture_id)
                request_count += 1
                stats_payload, stats_at = request_json(f"/fixtures/{fixture_id}/statistics", api_key, args.timeout)
                stats_path = save_json(stats_payload, run_dir, f"cycle_{cycle:02d}_{fixture_id}_statistics_raw.json")
                saved.append(str(stats_path))
                rows = full_time_rows(stats_payload)
                tracked = {name: occurrences(rows, name) for name in TRACKED_TYPES}
                checks = [
                    equation_check(rows, ("Shots On Goal", "Shots Off Goal", "Shots Blocked")),
                    equation_check(rows, ("Shots Inside Box", "Shots Outside Box")),
                ]
                record = {
                    "cycle": cycle,
                    "label": label,
                    "fixtureId": fixture_id,
                    "fixturesLiveReceivedAtUtc": iso_utc(live_at),
                    "fixturesLiveReceivedAtJst": iso_jst(live_at),
                    "statisticsReceivedAtUtc": iso_utc(stats_at),
                    "statisticsReceivedAtJst": iso_jst(stats_at),
                    "receiveDifferenceSeconds": round((stats_at - live_at).total_seconds(), 3),
                    "liveFixtureFound": fixture is not None,
                    "liveFixture": fixture,
                    "fullTimeInOriginalOrder": rows,
                    "trackedOccurrences": tracked,
                    "internalConsistency": checks,
                    "rawFiles": {"fixturesLive": str(live_path), "statistics": str(stats_path)},
                }
                summary_path = save_json(record, run_dir, f"cycle_{cycle:02d}_{fixture_id}_summary.json")
                saved.append(str(summary_path))
                history[label].append(record)
                print(f"{label}: statistics受信 {iso_utc(stats_at)} / 差={(stats_at-live_at).total_seconds():.3f}秒")
                for name in ("On Target", "Shots On Goal", "Off Target", "Shots Off Goal", "Corners", "Ball Possession"):
                    print(f"  {name}: {fmt_pair(tracked[name])}")
                for check in checks:
                    print(f"  {check['equation']}: HOME={check['home']['status']} AWAY={check['away']['status']}")

            if cycle < args.cycles:
                print(f"次のサイクルまで{args.interval:g}秒待機します。", flush=True)
                time.sleep(args.interval)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        print(f"GOAL API取得失敗: {error}", file=sys.stderr)
        print(f"使用したAPIリクエスト数: {request_count}", file=sys.stderr)
        return 1

    combined = {
        "runId": run_id,
        "cycles": args.cycles,
        "intervalSeconds": args.interval,
        "requestCount": request_count,
        "history": history,
    }
    combined_path = save_json(combined, run_dir, "time_series_summary.json")
    saved.append(str(combined_path))

    print("\n=== 時系列表（出現順を保持） ===")
    for label, records in history.items():
        print(f"\n{label}")
        print("Cycle | JST | On Target | Shots On Goal | Off Target | Shots Off Goal | Corners | Ball Possession")
        for record in records:
            values = record["trackedOccurrences"]
            print(" | ".join((
                str(record["cycle"]), record["statisticsReceivedAtJst"],
                fmt_pair(values["On Target"]), fmt_pair(values["Shots On Goal"]),
                fmt_pair(values["Off Target"]), fmt_pair(values["Shots Off Goal"]),
                fmt_pair(values["Corners"]), fmt_pair(values["Ball Possession"]),
            )))

    print(f"\n使用したAPIリクエスト数: {request_count}")
    print(f"時系列summary: {combined_path}")
    print(f"保存ディレクトリ: {run_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
