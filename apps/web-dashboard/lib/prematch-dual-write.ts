import { normalizeOdds } from './prematch-backfill.ts';

type Summary = { saved: number; existing: number; skipped: number; error: number; conflicts?: number; markets?: number; captureRuns?: number; unsupported?: number; malformed?: number };
type FormRow = { teamId?: string; status?: string; wins?: number | null; draws?: number | null; played?: number | null; [key: string]: unknown };
type OddsSource = { apiFixtureId: string; coreFixtureId: string; raw: unknown };
type ResultRecord = Record<string, unknown>;

const first = <T>(db: D1Database, sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).first<T>();
const rows = <T>(db: D1Database, sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).all<T>();

/** Pure eligibility rule shared by the route and its regression tests. */
export function formTypedEligibility(items: FormRow[], mappedTeamIds: Set<string>) {
  return items.map((item) => ({ item, eligible: item.status === 'success' && !!item.teamId && mappedTeamIds.has(String(item.teamId)) }));
}

/** Raw form history is written before this function is invoked. */
export async function saveTypedFormObservations(db: D1Database, input: { runId: string; observedAt: string; checked: FormRow[] }): Promise<Summary> {
  const summary: Summary = { saved: 0, existing: 0, skipped: 0, error: 0 };
  const mappings = new Set<string>();
  for (const item of input.checked) if (item.status === 'success' && item.teamId) {
    const found = await first<{ team_id: string }>(db, 'SELECT team_id FROM team_provider_ids WHERE provider=? AND external_team_id=?', 'goal-api', String(item.teamId));
    if (found) mappings.add(String(item.teamId));
  }
  const eligible = formTypedEligibility(input.checked, mappings);
  const statements: D1PreparedStatement[] = [];
  for (const { item, eligible: isEligible } of eligible) {
    if (!isEligible) { summary.skipped += 1; continue; }
    const existing = await first<{ id: number }>(db, 'SELECT id FROM prematch_form_observations WHERE form_run_id=? AND provider=? AND external_team_id=?', input.runId, 'goal-api', String(item.teamId));
    if (existing) { summary.existing += 1; continue; }
    statements.push(db.prepare(`INSERT INTO prematch_form_observations
      (form_run_id,provider,external_team_id,observed_at,status,wins,draws,played,result_json)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(input.runId, 'goal-api', String(item.teamId), input.observedAt, 'success', item.wins ?? null, item.draws ?? null, item.played ?? null, JSON.stringify(item)));
  }
  if (statements.length) { await db.batch(statements); summary.saved = statements.length; }
  return summary;
}

/** Pure normalization plan; it deliberately accepts only fixtures already SAFE-bridged by the caller. */
export function typedOddsPlan(capturedAt: string, sources: OddsSource[]) {
  const candidates: Array<ReturnType<typeof normalizeOdds>['candidates'][number]> = [];
  let unsupported = 0, malformed = 0, duplicate = 0;
  const seen = new Set<string>();
  for (const source of sources) {
    const normalized = normalizeOdds(source.coreFixtureId, capturedAt, source.raw);
    unsupported += normalized.skipped.UNSUPPORTED_MARKET;
    malformed += normalized.skipped.MALFORMED_ODDS;
    duplicate += normalized.skipped.DUPLICATE_CANDIDATE;
    for (const candidate of normalized.candidates) {
      const key = [candidate.fixtureId, candidate.bookmaker, candidate.marketType, candidate.period, candidate.statType, candidate.side, candidate.rawSelectionName, candidate.line, candidate.odds].join('|');
      if (seen.has(key)) { duplicate += 1; continue; }
      seen.add(key); candidates.push(candidate);
    }
  }
  return { candidates, unsupported, malformed, duplicate };
}

/** Raw odds snapshots are written first. A run and all of its values are then committed in one D1 batch. */
export async function saveTypedOdds(db: D1Database, input: { legacyRunId: string; capturedAt: string; apiRequests: number; sources: OddsSource[]; raw: unknown }): Promise<Summary> {
  const prior = await first<{ id: string }>(db, 'SELECT id FROM odds_capture_runs_v2 WHERE legacy_run_id=?', input.legacyRunId);
  if (prior) return { saved: 0, existing: 1, skipped: 0, error: 0, captureRuns: 0, markets: 0 };
  const plan = typedOddsPlan(input.capturedAt, input.sources);
  const captureId = `legacy:${input.legacyRunId}`;
  const statements: D1PreparedStatement[] = [db.prepare('INSERT INTO odds_capture_runs_v2 (id,legacy_run_id,provider,captured_at,api_requests,raw_json) VALUES (?,?,?,?,?,?)').bind(captureId, input.legacyRunId, 'api-football', input.capturedAt, input.apiRequests, JSON.stringify(input.raw))];
  for (const value of plan.candidates) statements.push(db.prepare(`INSERT INTO odds_market_values
    (capture_run_id,fixture_id,bookmaker,market,period,stat_type,side,selection,line,odds,captured_at,raw_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(captureId, value.fixtureId, value.bookmaker, value.marketType, value.period, value.statType, value.side, value.rawSelectionName, value.line, value.odds, input.capturedAt, JSON.stringify(value.raw)));
  await db.batch(statements);
  return { saved: plan.candidates.length, existing: 0, skipped: plan.duplicate, error: 0, captureRuns: 1, markets: plan.candidates.length, unsupported: plan.unsupported, malformed: plan.malformed };
}

function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function integer(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
function resultCandidate(value: ResultRecord) {
  const fixture = object(value.fixture), goals = object(value.goals), score = object(value.score), status = object(fixture.status);
  const externalFixtureId = fixture.id === undefined || fixture.id === null ? null : String(fixture.id);
  const providerStatus = status.short === undefined || status.short === null ? null : String(status.short);
  const finished = providerStatus !== null && ['FT', 'AET', 'PEN'].includes(providerStatus);
  const home = integer(goals.home), away = integer(goals.away), halftime = object(score.halftime);
  return { externalFixtureId, providerStatus, finished, home, away, homeHalftime: integer(halftime.home), awayHalftime: integer(halftime.away), valid: !!externalFixtureId && finished && home !== null && away !== null };
}

/** Finished API-Football facts only. Existing contradictory results are surfaced, never overwritten. */
export async function saveTypedResults(db: D1Database, input: { capturedAt: string; fixtures: ResultRecord[] }): Promise<Summary> {
  const summary: Summary = { saved: 0, existing: 0, skipped: 0, error: 0, conflicts: 0 };
  const statements: D1PreparedStatement[] = [];
  for (const raw of input.fixtures) {
    const candidate = resultCandidate(raw);
    if (!candidate.valid) { summary.skipped += 1; continue; }
    const mapping = await first<{ fixture_id: string }>(db, 'SELECT fixture_id FROM fixture_provider_ids WHERE provider=? AND external_fixture_id=?', 'api-football', candidate.externalFixtureId!);
    if (!mapping) { summary.skipped += 1; continue; }
    const existing = await first<{ provider: string; provider_status: string | null; home_goals: number | null; away_goals: number | null; home_halftime_goals: number | null; away_halftime_goals: number | null }>(db, 'SELECT provider,provider_status,home_goals,away_goals,home_halftime_goals,away_halftime_goals FROM match_results_v2 WHERE fixture_id=?', mapping.fixture_id);
    if (existing) {
      const same = existing.provider === 'api-football' && existing.provider_status === candidate.providerStatus && existing.home_goals === candidate.home && existing.away_goals === candidate.away && existing.home_halftime_goals === candidate.homeHalftime && existing.away_halftime_goals === candidate.awayHalftime;
      if (same) summary.existing += 1; else summary.conflicts = (summary.conflicts ?? 0) + 1;
      continue;
    }
    statements.push(db.prepare(`INSERT INTO match_results_v2
      (fixture_id,provider,provider_status,home_goals,away_goals,home_halftime_goals,away_halftime_goals,finalized_at,captured_at,raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(mapping.fixture_id, 'api-football', candidate.providerStatus, candidate.home, candidate.away, candidate.homeHalftime, candidate.awayHalftime, input.capturedAt, input.capturedAt, JSON.stringify(raw)));
  }
  if (statements.length) { await db.batch(statements); summary.saved = statements.length; }
  return summary;
}

export function resultTypedEligibility(value: ResultRecord) { return resultCandidate(value); }
