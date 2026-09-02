#!/usr/bin/env python3
"""Analyze only locally saved GOAL API data. This script sends zero API requests."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "goal_api_test"
OUTPUT = DATA / "analysis"


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def add_observation(target: list[dict[str, Any]], *, fixture_id: Any, home: Any, away: Any,
                    status: Any, score: Any, minute: Any, stats: Any, timestamp: Any, source: Path) -> None:
    if not fixture_id:
        return
    if isinstance(score, dict):
        score = f"{score.get('home', '?')}-{score.get('away', '?')}"
    target.append({
        "fixtureId": str(fixture_id), "home": home, "away": away, "status": status,
        "score": score, "minute": minute, "timestamp": timestamp,
        "statistics": stats if isinstance(stats, list) else [],
        "source": str(source.relative_to(ROOT)),
    })


def collect_observations() -> list[dict[str, Any]]:
    observations: list[dict[str, Any]] = []
    for path in DATA.rglob("*.json"):
        if OUTPUT in path.parents:
            continue
        data = load_json(path)
        if not data:
            continue
        fixture = data.get("fixture") if isinstance(data.get("fixture"), dict) else {}
        statistics = data.get("statistics") if isinstance(data.get("statistics"), dict) else {}
        if fixture.get("fixture_id"):
            add_observation(observations, fixture_id=fixture.get("fixture_id"), home=fixture.get("home"), away=fixture.get("away"),
                            status=fixture.get("status"), score=fixture.get("score"), minute=fixture.get("live_minute"),
                            stats=statistics.get("fullTime"), timestamp=(data.get("capture") or {}).get("statisticsReceivedAtUtc"), source=path)
        elif data.get("fixtureId"):
            live_fixture = data.get("liveFixture") if isinstance(data.get("liveFixture"), dict) else {}
            add_observation(observations, fixture_id=data.get("fixtureId"), home=data.get("home") or live_fixture.get("homeTeamName"),
                            away=data.get("away") or live_fixture.get("awayTeamName"), status=data.get("status") or live_fixture.get("matchStatus"),
                            score=data.get("score"), minute=data.get("liveMinute"),
                            stats=data.get("allFullTimeStatisticsInOriginalOrder") or data.get("fullTimeInOriginalOrder"),
                            timestamp=data.get("statisticsReceivedAtUtc"), source=path)
        matches = data.get("matches")
        if isinstance(matches, dict):
            for fixture_id, match in matches.items():
                if not isinstance(match, dict):
                    continue
                info = match.get("fixture") if isinstance(match.get("fixture"), dict) else {}
                latest = match.get("latest") if isinstance(match.get("latest"), dict) else {}
                received = latest.get("receivedAt") if isinstance(latest.get("receivedAt"), dict) else {}
                add_observation(observations, fixture_id=fixture_id, home=info.get("home"), away=info.get("away"),
                                status=info.get("status"), score=latest.get("score") or info.get("score"), minute=latest.get("minute"),
                                stats=latest.get("statistics"), timestamp=received.get("utc"), source=path)
        current = data.get("current")
        if data.get("fixtureId") and isinstance(current, dict):
            stat_map = current.get("stats") if isinstance(current.get("stats"), dict) else {}
            stats = [{"type": key, **value} for key, value in stat_map.items() if isinstance(value, dict)]
            add_observation(observations, fixture_id=data.get("fixtureId"), home=current.get("home"), away=current.get("away"),
                            status=current.get("status"), score=f"{current.get('homeScore', '?')}-{current.get('awayScore', '?')}", minute=None,
                            stats=stats, timestamp=data.get("finishedAt"), source=path)
    return observations


def count_jsonl_lines(name: str) -> int:
    total = 0
    for path in DATA.rglob(name):
        try:
            with path.open(encoding="utf-8") as handle:
                total += sum(1 for line in handle if line.strip())
        except OSError:
            pass
    return total


def main() -> None:
    files = [path for path in DATA.rglob("*") if path.is_file() and OUTPUT not in path.parents]
    observations = collect_observations()
    by_fixture: dict[str, list[dict[str, Any]]] = defaultdict(list)
    duplicate_types: Counter[str] = Counter()
    for observation in observations:
        by_fixture[observation["fixtureId"]].append(observation)
        types = Counter(str(stat.get("type")) for stat in observation["statistics"] if isinstance(stat, dict) and stat.get("type"))
        duplicate_types.update({name: 1 for name, count in types.items() if count > 1})

    fixtures = []
    for fixture_id, items in sorted(by_fixture.items()):
        ordered = sorted(items, key=lambda item: item.get("timestamp") or "")
        last = ordered[-1]
        fixtures.append({
            "fixtureId": fixture_id, "home": last.get("home"), "away": last.get("away"),
            "latestScore": last.get("score"), "latestStatus": last.get("status"), "latestMinute": last.get("minute"),
            "observations": len(items), "firstTimestamp": ordered[0].get("timestamp"), "lastTimestamp": last.get("timestamp"),
            "latestStatisticsFields": [stat.get("type") for stat in last["statistics"] if isinstance(stat, dict)],
        })

    completed = [item for item in fixtures if str(item.get("latestStatus", "")).lower() in {"ft", "finished", "full time"}]
    report = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "apiRequests": 0,
        "archive": {
            "files": len(files), "bytes": sum(path.stat().st_size for path in files),
            "jsonFiles": sum(path.suffix == ".json" for path in files),
            "jsonlFiles": sum(path.suffix == ".jsonl" for path in files),
        },
        "fixturesObserved": len(fixtures),
        "observationsExtracted": len(observations),
        "completedFixturesDetected": len(completed),
        "websocketRawFrames": count_jsonl_lines("raw_messages.jsonl") + count_jsonl_lines("events.jsonl"),
        "recordedStatChanges": count_jsonl_lines("stat_changes.jsonl"),
        "manualSnapshots": 0,
        "duplicateTypesSeenAcrossObservations": dict(duplicate_types.most_common()),
        "fixtures": fixtures,
        "outcomeAnalysisReadiness": {
            "ready": False,
            "reason": "過去データには監視候補にした時点の手動スナップと、予測ラベル（得点・コーナー・逆転）が揃っていないため、的中率はまだ算出できません。",
            "nowRecorded": ["全match_update", "手動スナップ", "試合status", "score", "監視開始・追加・終了"],
            "nextNeeded": ["検知ルール名", "検知対象チーム", "検知時刻・分", "その後の得点・コーナー・逆転結果"],
        },
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "latest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        "# GOAL API 保存データ分析", "", f"生成時刻: {report['generatedAtUtc']}", "API requests: 0", "",
        f"- 保存ファイル: {report['archive']['files']}件 ({report['archive']['bytes'] / 1024 / 1024:.2f} MiB)",
        f"- 識別できた試合: {report['fixturesObserved']}試合", f"- 抽出した観測点: {report['observationsExtracted']}件",
        f"- 生WebSocket記録: {report['websocketRawFrames']}行", f"- stats変化記録: {report['recordedStatChanges']}行",
        f"- 完了状態を確認できた試合: {report['completedFixturesDetected']}試合", "",
        "## 現時点の結論", "",
        report["outcomeAnalysisReadiness"]["reason"],
        "今回追加した永続保存により、これからの監視では時系列データと手動スナップを蓄積できます。",
    ]
    (OUTPUT / "latest.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
