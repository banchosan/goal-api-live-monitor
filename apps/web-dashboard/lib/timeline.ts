export type TimelineEvent = {
  id?: number;
  sessionId: string;
  fixtureId: string;
  eventType: string;
  receivedAt: string;
  connectionId?: string | null;
  sequence?: number | null;
  source?: string | null;
  payload: unknown;
};

export type ReconstructedState = {
  fixtureId: string;
  sessionId: string | null;
  targetMinute: number;
  actualObservedMinute: number | null;
  freshnessMinutes: number | null;
  missing: boolean;
  monitoringSession: boolean;
  connectionGap: boolean;
  observedAt: string | null;
  nextObservedMinute: number | null;
  source: string | null;
  state: unknown | null;
};

const numericMinute = (event: TimelineEvent) => {
  const payload = record(event.payload);
  const data = record(payload.data);
  const value = data.match_status ?? payload.match_status ?? null;
  return /^\d+$/.test(String(value ?? '')) ? Number(value) : null;
};

export function reconstructAtMinute(events: TimelineEvent[], fixtureId: string, targetMinute: number, requestedSessionId?: string): ReconstructedState {
  const fixtureEvents = events
    .filter((event) => event.fixtureId === fixtureId && (!requestedSessionId || event.sessionId === requestedSessionId))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
  const sessionId = requestedSessionId ?? [...fixtureEvents].reverse().find((event) => event.eventType === 'session_start' || event.eventType === 'session_add')?.sessionId ?? fixtureEvents.at(-1)?.sessionId ?? null;
  const sessionEvents = sessionId ? fixtureEvents.filter((event) => event.sessionId === sessionId) : [];
  const monitoringSession = sessionEvents.some((event) => event.eventType === 'session_start' || event.eventType === 'session_add');
  const observations = sessionEvents
    .filter((event) => event.eventType === 'match_update' && numericMinute(event) !== null)
    .map((event) => ({ event, minute: numericMinute(event)! }));
  const previous = [...observations].filter((item) => item.minute <= targetMinute).at(-1) ?? null;
  const next = observations.find((item) => item.minute > targetMinute) ?? null;
  const between = previous && next
    ? sessionEvents.filter((event) => event.receivedAt > previous.event.receivedAt && event.receivedAt < next.event.receivedAt)
    : [];
  const gapStart = new Set(['socket_disconnect', 'socket_error', 'reconnect_scheduled']);
  const gapEnd = new Set(['auth_success', 'resubscribe_success', 'subscribe_success']);
  let gapOpen = false;
  for (const event of between) {
    if (gapStart.has(event.eventType)) gapOpen = true;
    if (gapEnd.has(event.eventType)) gapOpen = false;
  }
  const connectionGap = gapOpen || between.some((event) => gapStart.has(event.eventType));
  const freshnessMinutes = previous ? targetMinute - previous.minute : null;
  const missing = !monitoringSession || !previous || connectionGap;
  return {
    fixtureId,
    sessionId,
    targetMinute,
    actualObservedMinute: previous?.minute ?? null,
    freshnessMinutes,
    missing,
    monitoringSession,
    connectionGap,
    observedAt: previous?.event.receivedAt ?? null,
    nextObservedMinute: next?.minute ?? null,
    source: previous?.event.source ?? null,
    state: previous ? record(previous.event.payload).data ?? previous.event.payload : null,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
