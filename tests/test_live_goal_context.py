from __future__ import annotations

import unittest

from analysis.live_goal_context import analyze_events, parse_minute


def event(minute: str, home_score: str, away_score: str, statistics: list[dict], scorers: list[dict], sequence: int) -> dict:
    return {
        "eventType": "match_update", "fixtureId": "fixture-1", "sessionId": "session-1",
        "receivedAt": f"2026-09-08T10:{sequence:02d}:00.000Z", "sequence": sequence,
        "home": "Home", "away": "Away", "homeScore": home_score, "awayScore": away_score,
        "payload": {"data": {"match_status": minute, "match_hometeam_score": home_score,
            "match_awayteam_score": away_score, "statistics": statistics, "goalscorer": scorers, "cards": []}},
    }


class LiveGoalContextTests(unittest.TestCase):
    def test_parse_minute_supports_added_time_without_inventing_statuses(self) -> None:
        self.assertEqual(parse_minute("45+2"), 47)
        self.assertEqual(parse_minute("70"), 70)
        self.assertIsNone(parse_minute("HT"))

    def test_partial_statistics_merge_and_duplicate_occurrences_are_preserved(self) -> None:
        result = analyze_events([
            event("29", "0", "0", [{"type": "Corners", "home": "1", "away": "0"}, {"type": "Corners", "home": "2", "away": "1"}, {"type": "Dangerous Attacks", "home": "10", "away": "8"}], [], 1),
            event("34", "0", "0", [{"type": "Dangerous Attacks", "home": "15", "away": "9"}], [], 2),
        ])
        final = result.observations[-1]["statistics"]
        self.assertEqual(final["Corners#1"]["home"], 1.0)
        self.assertEqual(final["Corners#2"]["home"], 2.0)
        self.assertEqual(final["Dangerous Attacks#1"]["home"], 15.0)

    def test_goal_context_uses_only_pre_goal_observations_for_window_delta(self) -> None:
        scorer = {"time": "36", "score": "1 - 0", "home_scorer": "A Player", "away_scorer": ""}
        result = analyze_events([
            event("29", "0", "0", [{"type": "Dangerous Attacks", "home": "10", "away": "8"}], [], 1),
            event("34", "0", "0", [{"type": "Dangerous Attacks", "home": "15", "away": "9"}], [], 2),
            event("36", "1", "0", [{"type": "Dangerous Attacks", "home": "17", "away": "9"}], [scorer], 3),
        ])
        goal = result.goals[0]
        self.assertTrue(goal["analyzable"])
        self.assertEqual(goal["detectionMethod"], "goalscorer+score_change")
        self.assertEqual(goal["side"], "home")
        window = goal["windows"]["5"]
        self.assertTrue(window["complete"])
        self.assertEqual(window["baselineObservedMinute"], 29)
        self.assertEqual(window["endObservedMinute"], 34)
        self.assertEqual(window["statDelta"]["Dangerous Attacks#1"]["home"], 5.0)

    def test_goals_present_on_first_observation_are_historical_not_training_labels(self) -> None:
        result = analyze_events([event("70", "1", "0", [], [{"time": "20", "score": "1 - 0", "home_scorer": "A"}], 1)])
        self.assertEqual(result.goals[0]["detectionMethod"], "historical_at_first_observation")
        self.assertFalse(result.goals[0]["analyzable"])
        self.assertEqual(result.summary["goalsObservedDuringMonitoring"], 0)

    def test_delayed_scorer_detail_does_not_duplicate_an_already_observed_score_change(self) -> None:
        scorer = {"time": "36", "score": "1 - 0", "home_scorer": "A"}
        result = analyze_events([
            event("35", "0", "0", [], [], 1),
            event("36", "1", "0", [], [], 2),
            event("37", "1", "0", [], [scorer], 3),
        ])
        self.assertEqual(len(result.goals), 1)
        self.assertEqual(result.goals[0]["detectionConfidence"], "score_only")


if __name__ == "__main__":
    unittest.main()
