#!/usr/bin/env python3
"""Check GOAL API live statistics for selected leagues and named fixtures."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import goal_api_live_statistics_test as api


def norm(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode().casefold()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def field(fixture: dict[str, Any], *names: str) -> str:
    for name in names:
        value = fixture.get(name)
        if isinstance(value, str) and value:
            return value
    return ""


def team_names(fixture: dict[str, Any]) -> tuple[str, str]:
    home = field(fixture, "homeTeamName")
    away = field(fixture, "awayTeamName")
    if not home and isinstance(fixture.get("homeTeam"), dict):
        home = str(fixture["homeTeam"].get("name", ""))
    if not away and isinstance(fixture.get("awayTeam"), dict):
        away = str(fixture["awayTeam"].get("name", ""))
    return home, away


def has_teams(fixture: dict[str, Any], first: tuple[str, ...], second: tuple[str, ...]) -> bool:
    home, away = map(norm, team_names(fixture))
    first_match = any(name in home for name in first) and any(name in away for name in second)
    reverse_match = any(name in away for name in first) and any(name in home for name in second)
    return first_match or reverse_match


def league_match(country: str, league_terms: tuple[str, ...]) -> Callable[[dict[str, Any]], bool]:
    return lambda fixture: norm(field(fixture, "countryName")) == norm(country) and all(
        term in norm(field(fixture, "leagueName")) for term in league_terms
    )


TARGETS: tuple[tuple[str, Callable[[dict[str, Any]], bool]], ...] = (
    ("Switzerland Challenge League", league_match("Switzerland", ("challenge", "league"))),
    ("Bulgaria First League", league_match("Bulgaria", ("first", "league"))),
    ("Uruguay Primera", league_match("Uruguay", ("primera",))),
    ("Treviso vs Lecco", lambda f: has_teams(f, ("treviso",), ("lecco",))),
    ("Teruel vs Madrid Castilla", lambda f: has_teams(f, ("teruel",), ("madrid castilla", "real madrid b", "castilla"))),
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Minimal GOAL API statistics check for selected live competitions.")
    parser.add_argument("--env-file", type=Path, default=Path(__file__).with_name(".env"))
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "data" / "goal_api_test" / "target_leagues")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--live-file", type=Path, help="保存済みfixtures/live生JSONを再利用（API消費0）")
    parser.add_argument("--live-received-at", help="--live-fileの正確なUTC受信時刻（ISO 8601）")
    args = parser.parse_args()
    api.load_dotenv(args.env_file)
    key = os.getenv("GOAL_API_KEY", "").strip()
    if not key:
        print("GOAL_API_KEYが未設定です。", file=sys.stderr)
        return 2

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    run_dir = args.output_dir / run_id
    request_count = 0
    if args.live_file:
        try:
            live_payload = json.loads(args.live_file.read_text(encoding="utf-8"))
            live_at = datetime.fromisoformat(args.live_received_at.replace("Z", "+00:00")) if args.live_received_at else datetime.fromtimestamp(args.live_file.stat().st_mtime, timezone.utc)
        except (OSError, json.JSONDecodeError, ValueError) as error:
            print(f"保存済みfixtures/live読込失敗: {error}", file=sys.stderr)
            return 1
        live_path = args.live_file.resolve()
        print("保存済みfixtures/liveを再利用: APIリクエスト0回")
    else:
        request_count = 1
        try:
            live_payload, live_at = api.api_get("/fixtures/live", key, args.timeout)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            print(f"fixtures/live取得失敗: {error}", file=sys.stderr)
            return 1
        live_path = api.save_json(live_payload, run_dir, "fixtures_live_raw.json")
    fixtures = api.unwrap_fixtures(live_payload)

    selected: list[tuple[str, dict[str, Any]]] = []
    seen: set[str] = set()
    print(f"fixtures/live受信: {api.iso_utc(live_at)} / {api.iso_jst(live_at)}")
    print(f"ライブ試合総数: {len(fixtures)}")
    for label, predicate in TARGETS:
        matches = [fixture for fixture in fixtures if predicate(fixture)]
        if not matches:
            print(f"- {label}: 現在ライブ該当なし")
            continue
        for fixture in matches:
            fixture_id = str(fixture.get("id", ""))
            home, away = team_names(fixture)
            print(f"- {label}: {home} vs {away} / fixture_id={fixture_id}")
            if fixture_id and fixture_id not in seen:
                selected.append((label, fixture))
                seen.add(fixture_id)
    print(f"想定APIリクエスト数: {request_count + len(selected)}回（live {request_count} + statistics {len(selected)}）", flush=True)

    summaries: list[dict[str, Any]] = []
    for label, fixture in selected:
        fixture_id = str(fixture["id"])
        request_count += 1
        try:
            payload, stats_at = api.api_get(f"/fixtures/{fixture_id}/statistics", key, args.timeout)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            print(f"{fixture_id} statistics取得失敗: {error}", file=sys.stderr)
            continue
        rows_found, full_time = api.find_key(payload, "fullTime")
        rows = api.rows_from_period(full_time) if rows_found else []
        home, away = team_names(fixture)
        raw_path = api.save_json(payload, run_dir, f"{fixture_id}_statistics_raw.json")
        fixture_path = api.save_json(fixture, run_dir, f"{fixture_id}_live_fixture_raw.json")
        summary = {
            "target": label,
            "fixtureId": fixture_id,
            "home": home,
            "away": away,
            "status": fixture.get("matchStatus"),
            "liveMinute": None,
            "liveMinuteResult": "GOAL APIから取得不可（現在分フィールドなし）",
            "score": {"home": fixture.get("homeTeamScore"), "away": fixture.get("awayTeamScore")},
            "fixturesLiveReceivedAtUtc": api.iso_utc(live_at),
            "fixturesLiveReceivedAtJst": api.iso_jst(live_at),
            "statisticsReceivedAtUtc": api.iso_utc(stats_at),
            "statisticsReceivedAtJst": api.iso_jst(stats_at),
            "statisticsAvailable": bool(rows),
            "allFullTimeStatisticsInOriginalOrder": rows,
            "rawFiles": {"liveFixture": str(fixture_path), "statistics": str(raw_path)},
        }
        summary_path = api.save_json(summary, run_dir, f"{fixture_id}_summary.json")
        summary["summaryFile"] = str(summary_path)
        summaries.append(summary)
        print(f"\n{home} vs {away} | status={summary['status']} | minute=GOAL APIから取得不可 | score={summary['score']['home']}-{summary['score']['away']}")
        print(f"statistics受信: {summary['statisticsReceivedAtJst']}")
        if not rows:
            print("statistics: 取得レスポンス内にfullTime項目なし")
        for row in rows:
            print(f"- {row['type']}: HOME={row['home']} AWAY={row['away']}")

    report = {
        "fixturesLiveReceivedAtUtc": api.iso_utc(live_at),
        "fixturesLiveReceivedAtJst": api.iso_jst(live_at),
        "requestCount": request_count,
        "targets": [label for label, _ in TARGETS],
        "matchedFixtures": summaries,
        "fixturesLiveRawFile": str(live_path),
    }
    report_path = api.save_json(report, run_dir, "report.json")
    print(f"\n使用したAPIリクエスト数: {request_count}")
    print(f"保存先: {run_dir.resolve()}")
    print(f"報告JSON: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
