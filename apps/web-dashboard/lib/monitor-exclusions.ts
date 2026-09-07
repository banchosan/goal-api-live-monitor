export type MonitorExclusionInput = {
  fixtureId: string;
  home: string;
  away: string;
  reason: string;
};

export function normalizeMonitorExclusionInput(value: unknown): MonitorExclusionInput {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const fixtureId = String(input.fixtureId ?? '').trim();
  if (!fixtureId) throw new Error('fixtureIdが必要です');
  return {
    fixtureId,
    home: String(input.home ?? '').trim(),
    away: String(input.away ?? '').trim(),
    reason: String(input.reason ?? 'manual_monitor_remove').trim() || 'manual_monitor_remove',
  };
}
