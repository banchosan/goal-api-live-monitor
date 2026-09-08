"""Reconstruct match timelines and goal-preceding stat windows from raw events."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
import json
import re

SCHEMA_VERSION = 1
DEFAULT_WINDOWS = (5, 10)


def parse_minute(value: Any) -> int | None:
    text = str(value or "").strip()
    match = re.fullmatch(r"(\d+)(?:\+(\d*))?", text)
    if not match:
        return None
    return int(match.group(1)) + int(match.group(2) or 0)


def parse_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    text = str(value).strip().replace("%", "").replace(",", "")
    try:
        return float(text)
    except ValueError:
        return None


def stat_entries(statistics: Any) -> dict[str, dict[str, Any]]:
    """Preserve duplicate provider types using stable occurrence keys."""
    result: dict[str, dict[str, Any]] = {}
    occurrences: defaultdict[str, int] = defaultdict(int)
    for raw in statistics if isinstance(statistics, list) else []:
        if not isinstance(raw, dict):
            continue
        stat_type = str(raw.get("type") or "").strip()
        if not stat_type:
            continue
        occurrences[stat_type] += 1
        key = f"{stat_type}#{occurrences[stat_type]}"
        result[key] = {
            "type": stat_type,
            "occurrence": occurrences[stat_type],
            "homeRaw": raw.get("home"),
            "awayRaw": raw.get("away"),
            "home": parse_number(raw.get("home")),
            "away": parse_number(raw.get("away")),
        }
    return result


def merge_stats(previous: dict[str, dict[str, Any]], incoming: Any) -> dict[str, dict[str, Any]]:
    merged = {key: dict(value) for key, value in previous.items()}
    merged.update(stat_entries(incoming))
    return merged


def scorer_key(goal: dict[str, Any]) -> str:
    fields = ("time", "score", "home_scorer", "away_scorer", "home_scorer_id", "away_scorer_id", "info")
    return "|".join(str(goal.get(field) or "") for field in fields)


def goal_side(goal: dict[str, Any], before: tuple[int, int] | None, after: tuple[int, int]) -> str:
    if goal.get("home_scorer") or goal.get("home_scorer_id"):
        return "home"
    if goal.get("away_scorer") or goal.get("away_scorer_id"):
        return "away"
    if before:
        if after[0] > before[0] and after[1] == before[1]:
            return "home"
        if after[1] > before[1] and after[0] == before[0]:
            return "away"
    return "unknown"


def int_score(value: Any) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def score_from_goal(value: Any) -> tuple[int, int] | None:
    match = re.fullmatch(r"\s*(\d+)\s*-\s*(\d+)\s*", str(value or ""))
    return (int(match.group(1)), int(match.group(2))) if match else None


def stat_delta(start: dict[str, dict[str, Any]], end: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for key in sorted(set(start) | set(end)):
        earlier, later = start.get(key), end.get(key)
        home = later["home"] - earlier["home"] if earlier and later and earlier["home"] is not None and later["home"] is not None else None
        away = later["away"] - earlier["away"] if earlier and later and earlier["away"] is not None and later["away"] is not None else None
        result[key] = {
            "type": (later or earlier or {}).get("type"),
            "occurrence": (later or earlier or {}).get("occurrence"),
            "home": home,
            "away": away,
            "decreased": bool((home is not None and home < 0) or (away is not None and away < 0)),
        }
    return result


@dataclass
class AnalysisResult:
    observations: list[dict[str, Any]]
    goals: list[dict[str, Any]]
    summary: dict[str, Any]


def analyze_events(events: Iterable[dict[str, Any]], windows: tuple[int, ...] = DEFAULT_WINDOWS) -> AnalysisResult:
    grouped: defaultdict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        if event.get("fixtureId") and event.get("sessionId"):
            grouped[(str(event["fixtureId"]), str(event["sessionId"]))].append(event)

    observations: list[dict[str, Any]] = []
    goals: list[dict[str, Any]] = []
    fixtures: set[str] = set()
    stat_names: set[str] = set()
    observed_session_fixture_count = 0

    for (fixture_id, session_id), rows in sorted(grouped.items()):
        rows.sort(key=lambda row: (str(row.get("receivedAt") or ""), int(row.get("sequence") or 0)))
        state_stats: dict[str, dict[str, Any]] = {}
        prior_states: list[dict[str, Any]] = []
        seen_scorers: set[str] = set()
        detected_score_signatures: set[tuple[int, int]] = set()
        previous_score: tuple[int, int] | None = None
        gap_since_observation = False
        observed_in_group = False

        observation_index = 0
        for event in rows:
            event_type = str(event.get("eventType") or "")
            if event_type in {"socket_disconnect", "socket_error", "connection_error", "reconnect_scheduled"}:
                gap_since_observation = True
                continue
            if event_type != "match_update":
                continue
            if not observed_in_group:
                fixtures.add(fixture_id)
                observed_session_fixture_count += 1
                observed_in_group = True
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
            minute = parse_minute(data.get("match_status") or event.get("status"))
            score = (int_score(data.get("match_hometeam_score", event.get("homeScore"))), int_score(data.get("match_awayteam_score", event.get("awayScore"))))
            pre_goal_state = prior_states[-1] if prior_states else None
            state_stats = merge_stats(state_stats, data.get("statistics"))
            stat_names.update(item["type"] for item in state_stats.values())
            scorers = [item for item in data.get("goalscorer", []) if isinstance(item, dict)] if isinstance(data.get("goalscorer"), list) else []
            new_scorers = [item for item in scorers if scorer_key(item) not in seen_scorers]
            for scorer in scorers:
                seen_scorers.add(scorer_key(scorer))

            score_increase = 0 if previous_score is None else max(0, score[0] - previous_score[0]) + max(0, score[1] - previous_score[1])
            candidates: list[tuple[dict[str, Any] | None, str]] = []
            if observation_index == 0:
                candidates.extend((scorer, "historical_at_first_observation") for scorer in new_scorers)
            else:
                candidates.extend((scorer, "goalscorer+score_change" if score_increase else "goalscorer_addition") for scorer in new_scorers)
                for _ in range(max(0, score_increase - len(new_scorers))):
                    candidates.append((None, "score_change"))

            for scorer, method in candidates:
                scorer_score = score_from_goal(scorer.get("score")) if scorer else None
                # A provider can publish the score first and append the scorer in a
                # later update. Do not turn that delayed detail into a second Goal.
                if method == "goalscorer_addition" and scorer_score in detected_score_signatures:
                    continue
                goal_minute = parse_minute(scorer.get("time")) if scorer else minute
                end_state = pre_goal_state
                context: dict[str, Any] = {}
                for window in windows:
                    target = (goal_minute - window) if goal_minute is not None else None
                    baseline = None if target is None else next((state for state in reversed(prior_states) if state["minute"] is not None and state["minute"] <= target), None)
                    baseline_index = prior_states.index(baseline) if baseline else None
                    intervening = prior_states[baseline_index + 1:] if baseline_index is not None else []
                    connection_gap = bool(any(state["connectionGapSincePreviousObservation"] for state in intervening))
                    context[str(window)] = {
                        "targetMinute": target,
                        "baselineObservedMinute": baseline["minute"] if baseline else None,
                        "endObservedMinute": end_state["minute"] if end_state else None,
                        "baselineFreshnessMinutes": target - baseline["minute"] if baseline and target is not None else None,
                        "connectionGap": connection_gap,
                        "complete": bool(baseline and end_state and not connection_gap),
                        "statDelta": stat_delta(baseline["statistics"], end_state["statistics"]) if baseline and end_state else {},
                    }
                goals.append({
                    "schemaVersion": SCHEMA_VERSION,
                    "fixtureId": fixture_id,
                    "sessionId": session_id,
                    "home": event.get("home"),
                    "away": event.get("away"),
                    "goalMinute": goal_minute,
                    "firstObservedMinute": minute,
                    "firstObservedAt": event.get("receivedAt"),
                    "detectionMethod": method,
                    "detectionConfidence": (
                        "confirmed" if method == "goalscorer+score_change" else
                        "score_only" if method == "score_change" else
                        "goalscorer_only" if method == "goalscorer_addition" else "historical"
                    ),
                    "side": goal_side(scorer or {}, previous_score, score),
                    "scoreBefore": list(previous_score) if previous_score else None,
                    "scoreAfter": list(score),
                    "scorer": scorer,
                    "analyzable": method != "historical_at_first_observation" and bool(pre_goal_state),
                    "windows": context,
                })
                detected_score_signatures.add(scorer_score or score)

            snapshot = {
                "schemaVersion": SCHEMA_VERSION,
                "fixtureId": fixture_id,
                "sessionId": session_id,
                "sequence": event.get("sequence"),
                "receivedAt": event.get("receivedAt"),
                "providerTimestamp": event.get("providerTimestamp"),
                "minute": minute,
                "status": data.get("match_status") or event.get("status"),
                "home": event.get("home"),
                "away": event.get("away"),
                "score": {"home": score[0], "away": score[1]},
                "statistics": {key: dict(value) for key, value in state_stats.items()},
                "rawStatisticTypes": [str(item.get("type")) for item in data.get("statistics", []) if isinstance(item, dict)],
                "goalCount": len(scorers),
                "cardCount": len(data.get("cards", [])) if isinstance(data.get("cards"), list) else 0,
                "connectionGapSincePreviousObservation": gap_since_observation,
            }
            observations.append(snapshot)
            prior_states.append(snapshot)
            previous_score = score
            gap_since_observation = False
            observation_index += 1

    observed_goals = [goal for goal in goals if goal["detectionMethod"] != "historical_at_first_observation"]
    complete_window_counts = {str(window): sum(bool(goal["windows"][str(window)]["complete"]) for goal in observed_goals) for window in windows}
    detection_counts: defaultdict[str, int] = defaultdict(int)
    for goal in goals:
        detection_counts[str(goal["detectionConfidence"])] += 1
    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "apiRequests": 0,
        "fixtureCount": len(fixtures),
        "sessionFixtureCount": observed_session_fixture_count,
        "lifecycleSessionFixtureCount": len(grouped),
        "observationCount": len(observations),
        "goalsKnown": len(goals),
        "goalsObservedDuringMonitoring": len(observed_goals),
        "analyzableGoals": sum(bool(goal["analyzable"]) for goal in observed_goals),
        "goalDetectionCounts": dict(sorted(detection_counts.items())),
        "completeWindowCounts": complete_window_counts,
        "statTypes": sorted(stat_names),
        "windowMinutes": list(windows),
        "notes": [
            "raw events remain unchanged; all files in this result are reproducible derived data",
            "duplicate statistics are preserved as Type#occurrence",
            "missing partial-update fields carry forward only within the same monitoring session",
            "negative deltas are retained and marked as provider correction/reset candidates",
        ],
    }
    return AnalysisResult(observations, goals, summary)


def load_event_files(paths: Iterable[Path]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for path in paths:
        with path.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, +1):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"{path}:{line_number}: invalid JSON") from error
                if isinstance(event, dict):
                    events.append(event)
    return events


def write_result(result: AnalysisResult, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "summary.json").write_text(json.dumps(result.summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for filename, rows in (("observations.jsonl", result.observations), ("goal_contexts.jsonl", result.goals)):
        with (output_dir / filename).open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
