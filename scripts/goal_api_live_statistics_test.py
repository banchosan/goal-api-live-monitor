#!/usr/bin/env python3
"""Compare every GOAL API statistic for two named live football fixtures.

Requests per run: one `/fixtures/live` request plus one statistics request
for each target found (at most three requests for the two configured targets).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo


BASE_URL = "https://api.goal-api.com/v1"
PERIODS = ("fullTime", "firstHalf", "secondHalf")
SHOT_STATS = (
    "Total Shots", "Shots", "On Target", "Off Target", "Blocked Shots",
    "Inside Box", "Outside Box",
)


def normalize(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value).casefold()).strip()


TARGETS = (
    ("Lecce vs AS Roma", "cmt1fhs1376t5pd07w4x7eqva"),
    ("Levadiakos vs Panathinaikos", "cmsvp4sot9e5lpg07372wbt6i"),
)


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            os.environ.setdefault(key, value)


def api_get(path: str, api_key: str, timeout: float) -> tuple[Any, datetime]:
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": "Goalise-GOAL-API-statistics-test/2.0",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
        received_at = datetime.now(timezone.utc)
    return json.loads(body), received_at


def save_json(payload: Any, directory: Path, filename: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / filename
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path.resolve()


def first_value(obj: Any, paths: Iterable[tuple[str, ...]], default: Any = "N/A") -> Any:
    for path in paths:
        value = obj
        for key in path:
            if not isinstance(value, dict) or key not in value:
                break
            value = value[key]
        else:
            if value is not None and value != "":
                return value
    return default


def unwrap_fixtures(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("data", "response", "fixtures", "results", "items"):
            if key in payload:
                found = unwrap_fixtures(payload[key])
                if found or isinstance(payload[key], list):
                    return found
    return []


def fixture_summary(fixture: dict[str, Any]) -> dict[str, Any]:
    home = first_value(fixture, (("home", "name"), ("homeTeam", "name"), ("home_team", "name"), ("teams", "home", "name"), ("homeTeamName",), ("home",), ("home_team",)))
    away = first_value(fixture, (("away", "name"), ("awayTeam", "name"), ("away_team", "name"), ("teams", "away", "name"), ("awayTeamName",), ("away",), ("away_team",)))
    home_score = first_value(fixture, (("score", "home"), ("scores", "home"), ("goals", "home"), ("homeTeamScore",), ("home_score",)))
    away_score = first_value(fixture, (("score", "away"), ("scores", "away"), ("goals", "away"), ("awayTeamScore",), ("away_score",)))
    return {
        "fixture_id": first_value(fixture, (("fixture_id",), ("fixture", "id"), ("id",))),
        "league": first_value(fixture, (("league", "name"), ("competition", "name"), ("league_name",), ("league",))),
        "home": home,
        "away": away,
        "status": first_value(fixture, (("status", "long"), ("status", "short"), ("fixture", "status", "long"), ("fixture", "status", "short"), ("matchStatus",), ("status",))),
        "score": f"{home_score} - {away_score}",
    }


def iso_utc(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_jst(value: datetime) -> str:
    return value.astimezone(ZoneInfo("Asia/Tokyo")).isoformat(timespec="milliseconds")


def collect_time_related_fields(value: Any, path: str = "$") -> dict[str, Any]:
    """Record actual fixture fields related to time/status/score; do not infer values."""
    found: dict[str, Any] = {}
    terms = ("time", "date", "status", "live", "stage", "score", "updated", "created", "kickoff", "period", "elapsed", "timer", "timestamp")
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if any(term in normalize(key).replace(" ", "") for term in terms) and not isinstance(child, (dict, list)):
                found[child_path] = child
            found.update(collect_time_related_fields(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.update(collect_time_related_fields(child, f"{path}[{index}]"))
    return found


def find_key(value: Any, wanted: str) -> tuple[bool, Any]:
    """Return the first recursively encountered key, including false/null values."""
    if isinstance(value, dict):
        if wanted in value:
            return True, value[wanted]
        wanted_norm = normalize(wanted)
        for key, child in value.items():
            if normalize(key) == wanted_norm:
                return True, child
        for child in value.values():
            found, result = find_key(child, wanted)
            if found:
                return True, result
    elif isinstance(value, list):
        for child in value:
            found, result = find_key(child, wanted)
            if found:
                return True, result
    return False, None


def rows_from_period(period: Any) -> list[dict[str, Any]]:
    """Convert a period into type/home/away rows without dropping API fields."""
    rows: list[dict[str, Any]] = []
    if isinstance(period, list):
        for item in period:
            if isinstance(item, dict):
                if "type" in item:
                    rows.append({"type": item.get("type"), "home": item.get("home"), "away": item.get("away"), "raw": item})
                else:
                    for key, value in item.items():
                        if isinstance(value, dict):
                            rows.append({"type": key, "home": value.get("home"), "away": value.get("away"), "raw": value})
                        else:
                            rows.append({"type": key, "home": None, "away": None, "raw": value})
            else:
                rows.append({"type": None, "home": None, "away": None, "raw": item})
    elif isinstance(period, dict):
        for key, value in period.items():
            if isinstance(value, dict):
                rows.append({"type": value.get("type", key), "home": value.get("home"), "away": value.get("away"), "raw": value})
            else:
                rows.append({"type": key, "home": None, "away": None, "raw": value})
    elif period is not None:
        rows.append({"type": None, "home": None, "away": None, "raw": period})
    return rows


def stat_type_set(period_rows: dict[str, list[dict[str, Any]]]) -> set[str]:
    return {
        str(row["type"])
        for rows in period_rows.values()
        for row in rows
        if row.get("type") not in (None, "")
    }


def matching_types(types: set[str], wanted: str) -> list[str]:
    aliases = {
        "Total Shots": {"total shots", "shots total"},
        "Shots": {"shots", "total shots"},
        "On Target": {"on target", "shots on target", "shots on goal"},
        "Off Target": {"off target", "shots off target", "shots off goal"},
        "Blocked Shots": {"blocked shots", "shots blocked", "blocked"},
        "Inside Box": {"inside box", "shots inside box", "shots in box"},
        "Outside Box": {"outside box", "shots outside box"},
    }
    return sorted(t for t in types if normalize(t) in aliases[wanted])


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*", value)
        if match:
            return float(match.group(1))
    return None


def fmt_number(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


def print_period(name: str, rows: list[dict[str, Any]]) -> None:
    print(f"\n{name} の全値（type / home / away）:")
    if not rows:
        print("- セクションなし、または項目なし")
        return
    for row in rows:
        print(f"- {row['type']} / {row['home']} / {row['away']}")
        raw = row["raw"]
        if isinstance(raw, dict):
            extra = {key: value for key, value in raw.items() if key not in {"type", "home", "away"}}
            if extra:
                print(f"  追加フィールド: {json.dumps(extra, ensure_ascii=False, separators=(',', ':'))}")


def print_shot_report(types: set[str], full_time_rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    report = {wanted: matching_types(types, wanted) for wanted in SHOT_STATS}
    print("\nシュート関連statsの実在判定:")
    for wanted, actual in report.items():
        print(f"- {wanted}: {'あり (' + ', '.join(actual) + ')' if actual else 'なし'}")

    on_names, off_names = set(report["On Target"]), set(report["Off Target"])
    on_rows = [row for row in full_time_rows if str(row.get("type")) in on_names]
    off_rows = [row for row in full_time_rows if str(row.get("type")) in off_names]
    only_on_off_shot_types = not any(
        report[name]
        for name in ("Total Shots", "Blocked Shots", "Inside Box", "Outside Box")
    )
    if on_rows and off_rows and only_on_off_shot_types:
        on, off = on_rows[0], off_rows[0]
        home_values = (number(on.get("home")), number(off.get("home")))
        away_values = (number(on.get("away")), number(off.get("away")))
        if None not in home_values and None not in away_values:
            home_sum = fmt_number(home_values[0] + home_values[1])  # type: ignore[operator]
            away_sum = fmt_number(away_values[0] + away_values[1])  # type: ignore[operator]
            print(f"- On Target + Off Target 参考値: home={home_sum}, away={away_sum}")
            if not report["Blocked Shots"]:
                print("  注: Blocked Shotsが存在しないため、この合計をTotal Shotsとは断定しません。")
    return report


def error_text(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:1000].replace("\n", " ").strip()
        except Exception:
            pass
        return f"HTTP {exc.code} {exc.reason}" + (f": {detail}" if detail else "")
    return str(exc)


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture a same-cycle GOAL API accuracy snapshot for two fixed fixtures.")
    parser.add_argument("--env-file", type=Path, default=Path(__file__).with_name(".env"))
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "data" / "goal_api_test" / "accuracy")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    load_dotenv(args.env_file)
    api_key = os.getenv("GOAL_API_KEY", "").strip()
    if not api_key:
        print("エラー: GOAL_API_KEYが.envまたは環境変数に設定されていません。", file=sys.stderr)
        print("使用したAPIリクエスト回数: 0", file=sys.stderr)
        return 2

    request_count = 0
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    try:
        request_count += 1
        live_payload, live_received_at = api_get("/fixtures/live", api_key, args.timeout)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"GOAL API接続/認証: 失敗（{error_text(exc)}）", file=sys.stderr)
        print(f"使用したAPIリクエスト回数: {request_count}", file=sys.stderr)
        return 1

    live_path = save_json(live_payload, args.output_dir, f"fixtures_live_{timestamp}.json")
    fixtures = unwrap_fixtures(live_payload)
    summaries = [fixture_summary(fixture) for fixture in fixtures]
    print("GOAL API接続/認証: 成功")
    print(f"ライブ試合件数: {len(fixtures)}")
    print(f"ライブ一覧HTTP受信時刻 UTC: {iso_utc(live_received_at)}")
    print(f"ライブ一覧HTTP受信時刻 JST: {iso_jst(live_received_at)}")
    print(f"ライブ一覧保存先: {live_path}")
    if not fixtures:
        print("現在ライブ試合なし")
        print("使用したAPIリクエスト回数: 1")
        return 0

    selected: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    for label, target_id in TARGETS:
        fixture_and_summary = next(
            ((fixture, summary) for fixture, summary in zip(fixtures, summaries) if str(summary["fixture_id"]) == target_id),
            None,
        )
        if fixture_and_summary is None:
            print(f"\n{label}: fixture_id={target_id} は現在のライブ一覧に存在しません")
        else:
            fixture, summary = fixture_and_summary
            selected.append((label, fixture, summary))

    results: dict[str, dict[str, Any]] = {}
    had_error = False
    saved_files: list[str] = [str(live_path)]
    for label, fixture, summary in selected:
        fixture_id = summary["fixture_id"]
        print(f"\n{'=' * 72}\n{label}\n{'=' * 72}")
        print("試合情報:")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        time_fields = collect_time_related_fields(fixture)
        print("\n/fixtures/live fixture object 生JSON（省略なし）:")
        print(json.dumps(fixture, ensure_ascii=False, indent=2))
        print("\n試合時間関連の実在フィールド:")
        for field_path, value in time_fields.items():
            print(f"- {field_path}: {json.dumps(value, ensure_ascii=False)}")
        print("live minute: GOAL APIから取得不可（現在分を表すフィールドなし）")
        print("注: $.events[].time はイベント発生分であり、現在のlive minuteではありません。")
        live_fixture_path = save_json(
            fixture,
            args.output_dir,
            f"fixture_{fixture_id}_live_{timestamp}.json",
        )
        saved_files.append(str(live_fixture_path))
        try:
            request_count += 1
            encoded_id = urllib.parse.quote(str(fixture_id), safe="")
            payload, stats_received_at = api_get(f"/fixtures/{encoded_id}/statistics", api_key, args.timeout)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            had_error = True
            print(f"statistics取得: 失敗（{error_text(exc)}）", file=sys.stderr)
            continue

        safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", str(fixture_id))
        path = save_json(payload, args.output_dir, f"fixture_{safe_id}_statistics_{timestamp}.json")
        saved_files.append(str(path))
        receive_gap_seconds = (stats_received_at - live_received_at).total_seconds()
        print("\n【基本情報】")
        print(f"API取得時刻 UTC（fixtures/live）: {iso_utc(live_received_at)}")
        print(f"API取得時刻 JST（fixtures/live）: {iso_jst(live_received_at)}")
        print(f"API取得時刻 UTC（statistics）: {iso_utc(stats_received_at)}")
        print(f"API取得時刻 JST（statistics）: {iso_jst(stats_received_at)}")
        print(f"statistics取得時刻との差: {receive_gap_seconds:.3f}秒")
        print(f"fixture_id: {fixture_id}")
        print(f"league: {summary['league']}")
        print(f"home: {summary['home']}")
        print(f"away: {summary['away']}")
        print("live minute: GOAL APIから取得不可")
        print(f"status: {summary['status']}（/fixtures/live の $.matchStatus）")
        print(f"score: {summary['score']}（/fixtures/live の $.homeTeamScore / $.awayTeamScore）")
        print(f"statistics取得: 成功\n保存先: {path}")
        print("\nstatistics 生JSON（省略なし）:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))

        period_rows: dict[str, list[dict[str, Any]]] = {}
        for period in PERIODS:
            found, value = find_key(payload, period)
            period_rows[period] = rows_from_period(value) if found else []
        types = stat_type_set(period_rows)
        print("\n全statistics項目一覧:")
        if types:
            for stat_type in sorted(types, key=str.casefold):
                periods = [period for period, rows in period_rows.items() if any(str(row.get("type")) == stat_type for row in rows)]
                print(f"- {stat_type} ({', '.join(periods)})")
        else:
            print("- なし")
        for period in PERIODS:
            print_period(period, period_rows[period])

        players_found, players = find_key(payload, "players")
        print("\nplayers statistics:")
        print(json.dumps(players, ensure_ascii=False, indent=2) if players_found else "- playersフィールドなし")
        has_found, has_statistics = find_key(payload, "hasStatistics")
        source_found, source = find_key(payload, "source")
        print(f"\nhasStatistics: {json.dumps(has_statistics, ensure_ascii=False) if has_found else 'フィールドなし'}")
        print(f"source: {json.dumps(source, ensure_ascii=False) if source_found else 'フィールドなし'}")
        shot_report = print_shot_report(types, period_rows["fullTime"])
        summary_payload = {
            "capture": {
                "fixturesLiveEndpoint": f"{BASE_URL}/fixtures/live",
                "fixturesLiveReceivedAtUtc": iso_utc(live_received_at),
                "fixturesLiveReceivedAtJst": iso_jst(live_received_at),
                "statisticsEndpoint": f"{BASE_URL}/fixtures/{fixture_id}/statistics",
                "statisticsReceivedAtUtc": iso_utc(stats_received_at),
                "statisticsReceivedAtJst": iso_jst(stats_received_at),
                "receiveTimeDifferenceSeconds": round(receive_gap_seconds, 3),
            },
            "fixture": {
                **summary,
                "live_minute": None,
                "live_minute_result": "GOAL APIから取得不可",
                "live_minute_json_field": None,
                "status_source": "/fixtures/live $.matchStatus",
                "score_source": "/fixtures/live $.homeTeamScore / $.awayTeamScore",
                "timeRelatedActualFields": time_fields,
            },
            "statistics": {
                "source_endpoint": f"/fixtures/{fixture_id}/statistics",
                "allTypes": sorted(types, key=str.casefold),
                "fullTime": period_rows["fullTime"],
                "firstHalf": period_rows["firstHalf"],
                "secondHalf": period_rows["secondHalf"],
                "players": players if players_found else None,
                "hasStatistics": has_statistics if has_found else None,
                "source": source if source_found else None,
                "shotAvailability": shot_report,
            },
            "rawFiles": {
                "liveFixture": str(live_fixture_path),
                "statistics": str(path),
            },
        }
        summary_path = save_json(summary_payload, args.output_dir, f"fixture_{safe_id}_summary_{timestamp}.json")
        saved_files.append(str(summary_path))
        print(f"比較用summary保存先: {summary_path}")
        results[label] = {"types": types, "shots": shot_report, "summary": summary_payload}

    print(f"\n{'=' * 72}\n2試合比較\n{'=' * 72}")
    if "Lecce vs AS Roma" in results and "Levadiakos vs Panathinaikos" in results:
        roma = results["Lecce vs AS Roma"]
        leva = results["Levadiakos vs Panathinaikos"]
        common = roma["types"] & leva["types"]
        roma_only = roma["types"] - leva["types"]
        leva_only = leva["types"] - roma["types"]
        for heading, values in (
            ("両方に共通して存在するstats", common),
            ("Roma戦だけにあるstats", roma_only),
            ("Levadiakos戦だけにあるstats", leva_only),
        ):
            print(f"\n{heading}:")
            print("- " + "\n- ".join(sorted(values, key=str.casefold)) if values else "- なし")
        print("\nシュート関連statsの違い:")
        for wanted in SHOT_STATS:
            roma_value = ", ".join(roma["shots"][wanted]) or "なし"
            leva_value = ", ".join(leva["shots"][wanted]) or "なし"
            print(f"- {wanted}: Roma={roma_value} / Levadiakos={leva_value}")
    else:
        print("対象2試合のstatisticsが両方揃わなかったため、比較は未実施です。")

    print(f"\n使用したAPIリクエスト回数: {request_count}")
    print("保存ファイル:")
    for saved_file in saved_files:
        print(f"- {saved_file}")
    return 1 if had_error else 0


if __name__ == "__main__":
    raise SystemExit(main())
