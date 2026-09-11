export type LiveStatistic = { type?: unknown; home?: unknown; away?: unknown };

export type NormalizedLiveSnapshot = {
  provider: 'goal-api';
  providerFixtureId: string;
  providerEventKey: string;
  coreFixtureId: string;
  sourceClientEventId: string;
  providerTimestamp: string | null;
  capturedAt: string;
  elapsedMinute: number | null;
  addedTime: number | null;
  matchStatus: string | null;
  homeScore: number | null;
  awayScore: number | null;
  shotsHome: number | null; shotsAway: number | null;
  shotsOnTargetHome: number | null; shotsOnTargetAway: number | null;
  cornersHome: number | null; cornersAway: number | null;
  attacksHome: number | null; attacksAway: number | null;
  dangerousAttacksHome: number | null; dangerousAttacksAway: number | null;
  possessionHome: number | null; possessionAway: number | null;
  yellowCardsHome: number | null; yellowCardsAway: number | null;
  redCardsHome: number | null; redCardsAway: number | null;
  savesHome: number | null; savesAway: number | null;
  passesTotalHome: number | null; passesTotalAway: number | null;
  passesAccurateHome: number | null; passesAccurateAway: number | null;
  xgHome: number | null; xgAway: number | null;
  rawStatistics: LiveStatistic[];
};

type MonitorMatchUpdate = {
  fixtureId: string;
  receivedAt: string;
  payload: unknown;
  clientEventId?: string;
  providerTimestamp?: string | number | null;
  payloadHash?: string | null;
};

const aliases: Record<string, string[]> = {
  shots: ['shots total', 'total shots', 'shots'],
  shotsOnTarget: ['shots on goal', 'shots on target', 'on target'],
  corners: ['corners'],
  attacks: ['attacks'],
  dangerousAttacks: ['dangerous attacks'],
  possession: ['ball possession', 'possession'],
  yellowCards: ['yellow cards'],
  redCards: ['red cards'],
  saves: ['saves'],
  passesTotal: ['passes total'],
  passesAccurate: ['passes accurate'],
  xg: ['expected goals', 'xg'],
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').replace('%', '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStatus(value: unknown) {
  const matchStatus = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const match = /^(\d+)(?:\s*\+\s*(\d+))?$/.exec(matchStatus);
  return {
    matchStatus: matchStatus || null,
    elapsedMinute: match ? Number(match[1]) : null,
    addedTime: match?.[2] ? Number(match[2]) : null,
  };
}

function statistic(statistics: LiveStatistic[], names: string[]) {
  return statistics.find((item) => names.includes(String(item.type ?? '').trim().toLowerCase())) ?? null;
}

function sides(statistics: LiveStatistic[], name: keyof typeof aliases) {
  const entry = statistic(statistics, aliases[name]);
  return { home: numberOrNull(entry?.home), away: numberOrNull(entry?.away) };
}

/**
 * Converts only a GOAL `match_update` into a nullable typed fact.  Missing
 * provider values stay null; zero remains numeric zero.  Identity is supplied
 * by the caller after it resolves fixture_provider_ids, never by team names.
 */
export function normalizeGoalLiveSnapshot(event: MonitorMatchUpdate, coreFixtureId: string): NormalizedLiveSnapshot | null {
  if (!event.fixtureId || !event.receivedAt || !event.clientEventId || !coreFixtureId) return null;
  const message = record(event.payload);
  const data = record(message.data ?? message);
  const statistics = Array.isArray(data.statistics) ? data.statistics as LiveStatistic[] : [];
  const status = parseStatus(data.match_status);
  const providerTimestamp = event.providerTimestamp === undefined || event.providerTimestamp === null || event.providerTimestamp === ''
    ? null : String(event.providerTimestamp);
  const providerEventKey = event.payloadHash?.trim() || `${providerTimestamp ?? 'no-provider-timestamp'}:${event.clientEventId}`;
  if (!providerEventKey) return null;
  const shots = sides(statistics, 'shots'); const shotsOnTarget = sides(statistics, 'shotsOnTarget');
  const corners = sides(statistics, 'corners'); const attacks = sides(statistics, 'attacks');
  const dangerousAttacks = sides(statistics, 'dangerousAttacks'); const possession = sides(statistics, 'possession');
  const yellowCards = sides(statistics, 'yellowCards'); const redCards = sides(statistics, 'redCards');
  const saves = sides(statistics, 'saves'); const passesTotal = sides(statistics, 'passesTotal');
  const passesAccurate = sides(statistics, 'passesAccurate'); const xg = sides(statistics, 'xg');
  return {
    provider: 'goal-api', providerFixtureId: event.fixtureId, providerEventKey, coreFixtureId,
    sourceClientEventId: event.clientEventId, providerTimestamp, capturedAt: event.receivedAt,
    ...status, homeScore: numberOrNull(data.match_hometeam_score), awayScore: numberOrNull(data.match_awayteam_score),
    shotsHome: shots.home, shotsAway: shots.away, shotsOnTargetHome: shotsOnTarget.home, shotsOnTargetAway: shotsOnTarget.away,
    cornersHome: corners.home, cornersAway: corners.away, attacksHome: attacks.home, attacksAway: attacks.away,
    dangerousAttacksHome: dangerousAttacks.home, dangerousAttacksAway: dangerousAttacks.away,
    possessionHome: possession.home, possessionAway: possession.away, yellowCardsHome: yellowCards.home, yellowCardsAway: yellowCards.away,
    redCardsHome: redCards.home, redCardsAway: redCards.away, savesHome: saves.home, savesAway: saves.away,
    passesTotalHome: passesTotal.home, passesTotalAway: passesTotal.away,
    passesAccurateHome: passesAccurate.home, passesAccurateAway: passesAccurate.away,
    xgHome: xg.home, xgAway: xg.away, rawStatistics: statistics,
  };
}

