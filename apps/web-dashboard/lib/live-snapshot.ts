type Stat = { type?: unknown; home?: unknown; away?: unknown };

const aliases: Record<string, string[]> = {
  shots: ['shots total', 'total shots', 'shots'],
  shotsOnTarget: ['shots on goal', 'shots on target', 'on target'],
  corners: ['corners'],
  dangerousAttacks: ['dangerous attacks'],
  possession: ['ball possession', 'possession'],
  xg: ['expected goals', 'xg'],
};

function numeric(value: unknown) {
  const text = String(value ?? '').replace('%', '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstStatistic(statistics: Stat[], names: string[]) {
  return statistics.find((stat) => names.includes(String(stat.type ?? '').trim().toLowerCase())) ?? null;
}

export function projectLiveSnapshot(payload: unknown) {
  const message = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const data = message.data !== null && typeof message.data === 'object' ? message.data as Record<string, unknown> : message;
  const statistics = Array.isArray(data.statistics) ? data.statistics as Stat[] : [];
  const value = (key: keyof typeof aliases, side: 'home' | 'away') => numeric(firstStatistic(statistics, aliases[key])?.[side]);
  const minute = Number(data.match_status);
  return {
    elapsedMinute: Number.isInteger(minute) ? minute : null,
    homeScore: numeric(data.match_hometeam_score),
    awayScore: numeric(data.match_awayteam_score),
    shotsHome: value('shots', 'home'), shotsAway: value('shots', 'away'),
    shotsOnTargetHome: value('shotsOnTarget', 'home'), shotsOnTargetAway: value('shotsOnTarget', 'away'),
    cornersHome: value('corners', 'home'), cornersAway: value('corners', 'away'),
    dangerousAttacksHome: value('dangerousAttacks', 'home'), dangerousAttacksAway: value('dangerousAttacks', 'away'),
    possessionHome: value('possession', 'home'), possessionAway: value('possession', 'away'),
    xgHome: value('xg', 'home'), xgAway: value('xg', 'away'),
    rawStatistics: statistics,
  };
}
