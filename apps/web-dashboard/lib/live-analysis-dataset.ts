import { calculateLiveDelta, resolveCheckpoint, type LiveSnapshot } from './live-delta.ts';

export type DatasetSide = 'HOME' | 'AWAY';
export type GoalLabel = 0 | 1 | null;
export type LiveAnalysisRow = {
  core_fixture_id: string; provider_fixture_id: string | null; kickoff_utc: string | null; home_team: string; away_team: string;
  side: DatasetSide; checkpoint: 55 | 60 | 65; checkpoint_actual_minute: number; checkpoint_captured_at: string;
  ht_da: number | null; checkpoint_da: number | null; da_delta: number | null;
  opponent_ht_da: number | null; opponent_checkpoint_da: number | null; opponent_da_delta: number | null; pressure_diff: number | null;
  ht_shots: number | null; checkpoint_shots: number | null; shots_delta: number | null;
  ht_sot: number | null; checkpoint_sot: number | null; sot_delta: number | null;
  ht_corners: number | null; checkpoint_corners: number | null; corners_delta: number | null;
  ht_attacks: number | null; checkpoint_attacks: number | null; attacks_delta: number | null;
  ht_possession: number | null; checkpoint_possession: number | null; possession_change: number | null;
  score_for: number | null; score_against: number | null;
  goal_for_next_5m: GoalLabel; goal_for_next_10m: GoalLabel; goal_for_next_15m: GoalLabel;
  goal_against_next_5m: GoalLabel; goal_against_next_10m: GoalLabel; goal_against_next_15m: GoalLabel;
  anomaly_flags: string | null;
};

export type FixtureMetadata = { coreFixtureId: string; providerFixtureId: string | null; kickoffUtc: string | null; homeTeam: string; awayTeam: string };
export type DatasetSkip = { coreFixtureId: string; checkpoint: number; reason: string };
export type DatasetResult = { rows: LiveAnalysisRow[]; skips: DatasetSkip[] };

const checkpoints = [55, 60, 65] as const;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const sideValue = (snapshot: LiveSnapshot, side: DatasetSide, home: keyof LiveSnapshot, away: keyof LiveSnapshot) => finite(snapshot[side === 'HOME' ? home : away]);
const opponent = (side: DatasetSide) => side === 'HOME' ? 'AWAY' : 'HOME';

function score(snapshot: LiveSnapshot, side: DatasetSide) {
  return { own: sideValue(snapshot, side, 'home_score', 'away_score'), opponent: sideValue(snapshot, side, 'away_score', 'home_score') };
}

/**
 * Labels deliberately use only a score observed at or before the window end.
 * If that boundary lacks a close causal observation, the label is unknown,
 * rather than incorrectly treated as no goal.
 */
function labels(snapshots: LiveSnapshot[], checkpoint: number, start: LiveSnapshot, side: DatasetSide) {
  const base = score(start, side); const result: Record<string, GoalLabel> = {};
  for (const window of [5, 10, 15] as const) {
    const end = resolveCheckpoint(snapshots, checkpoint + window, 1).snapshot;
    const finish = end ? score(end, side) : null;
    const valid = base.own !== null && base.opponent !== null && finish !== null && finish.own !== null && finish.opponent !== null
      && finish.own >= base.own && finish.opponent >= base.opponent;
    result[`goal_for_next_${window}m`] = valid ? (finish!.own > base.own ? 1 : 0) : null;
    result[`goal_against_next_${window}m`] = valid ? (finish!.opponent > base.opponent ? 1 : 0) : null;
  }
  return result as Pick<LiveAnalysisRow, 'goal_for_next_5m' | 'goal_for_next_10m' | 'goal_for_next_15m' | 'goal_against_next_5m' | 'goal_against_next_10m' | 'goal_against_next_15m'>;
}

function values(snapshot: LiveSnapshot, side: DatasetSide) {
  return {
    da: sideValue(snapshot, side, 'dangerous_attacks_home', 'dangerous_attacks_away'), shots: sideValue(snapshot, side, 'shots_home', 'shots_away'),
    sot: sideValue(snapshot, side, 'shots_on_target_home', 'shots_on_target_away'), corners: sideValue(snapshot, side, 'corners_home', 'corners_away'),
    attacks: sideValue(snapshot, side, 'attacks_home', 'attacks_away'), possession: sideValue(snapshot, side, 'possession_home', 'possession_away'),
  };
}

/** Pure read-model builder. It never modifies snapshots or derives identity from names. */
export function buildLiveAnalysisDataset(fixtures: { metadata: FixtureMetadata; snapshots: LiveSnapshot[] }[]): DatasetResult {
  const rows: LiveAnalysisRow[] = []; const skips: DatasetSkip[] = [];
  for (const { metadata, snapshots } of fixtures) for (const checkpoint of checkpoints) {
    const ht = resolveCheckpoint(snapshots, 'HT').snapshot;
    if (!ht) { skips.push({ coreFixtureId: metadata.coreFixtureId, checkpoint, reason: 'missing_actual_ht' }); continue; }
    const selected = resolveCheckpoint(snapshots, checkpoint).snapshot;
    if (!selected) { skips.push({ coreFixtureId: metadata.coreFixtureId, checkpoint, reason: 'missing_causal_checkpoint' }); continue; }
    const delta = calculateLiveDelta(snapshots, 'HT', checkpoint);
    if (!delta.home || !delta.away) { skips.push({ coreFixtureId: metadata.coreFixtureId, checkpoint, reason: 'missing_delta' }); continue; }
    for (const side of ['HOME', 'AWAY'] as const) {
      const own = side === 'HOME' ? delta.home : delta.away; const other = side === 'HOME' ? delta.away : delta.home;
      const start = values(ht, side); const end = values(selected, side); const againstStart = values(ht, opponent(side)); const againstEnd = values(selected, opponent(side));
      const flags = delta.anomalies.filter((item) => (side === 'HOME' ? item.side === 'home' : item.side === 'away')).map((item) => item.field);
      const scoreAtCheckpoint = score(selected, side);
      rows.push({
        core_fixture_id: metadata.coreFixtureId, provider_fixture_id: metadata.providerFixtureId, kickoff_utc: metadata.kickoffUtc, home_team: metadata.homeTeam, away_team: metadata.awayTeam,
        side, checkpoint, checkpoint_actual_minute: selected.elapsed_minute!, checkpoint_captured_at: selected.captured_at,
        ht_da: start.da, checkpoint_da: end.da, da_delta: own.dangerousAttacks.delta,
        opponent_ht_da: againstStart.da, opponent_checkpoint_da: againstEnd.da, opponent_da_delta: other.dangerousAttacks.delta,
        pressure_diff: own.dangerousAttacks.delta === null || other.dangerousAttacks.delta === null ? null : own.dangerousAttacks.delta - other.dangerousAttacks.delta,
        ht_shots: start.shots, checkpoint_shots: end.shots, shots_delta: own.shots.delta,
        ht_sot: start.sot, checkpoint_sot: end.sot, sot_delta: own.shotsOnTarget.delta,
        ht_corners: start.corners, checkpoint_corners: end.corners, corners_delta: own.corners.delta,
        ht_attacks: start.attacks, checkpoint_attacks: end.attacks, attacks_delta: own.attacks.delta,
        ht_possession: start.possession, checkpoint_possession: end.possession, possession_change: own.possession.change,
        score_for: scoreAtCheckpoint.own, score_against: scoreAtCheckpoint.opponent,
        ...labels(snapshots, checkpoint, selected, side), anomaly_flags: flags.length ? flags.join('|') : null,
      });
    }
  }
  return { rows, skips };
}

export function daBucket(value: number | null) { if (value === null || value < 0) return null; if (value <= 4) return '0-4'; if (value <= 9) return '5-9'; if (value <= 14) return '10-14'; if (value <= 19) return '15-19'; return '20+'; }
