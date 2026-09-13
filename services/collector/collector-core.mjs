import { createHash, randomUUID } from 'node:crypto';

const TERMINAL = new Set(['FT', 'FINISHED', 'AFTER_ET', 'AFTER_PEN', 'CANCELLED', 'ABANDONED', 'AWARDED']);
const providerTimestamp = (data) => data?.timestamp ?? data?.updated_at ?? data?.updatedAt ?? null;
const INITIAL_RECONNECT_DELAY_MS = 5_000;
const DEGRADED_RECONNECT_DELAY_MS = 60_000;
const TOKEN_TIMEOUT_MS = 12_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STABLE_CONNECTION_MS = 120_000;
const DATA_GAP_THRESHOLD_MS = 120_000;

export class GoalApiCollector {
  constructor({ apiKey, fetchImpl = fetch, WebSocketImpl = WebSocket, persist = async () => {}, schedule = setTimeout, cancelSchedule = clearTimeout, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, now = () => new Date().toISOString(), random = Math.random, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS, stableConnectionMs = STABLE_CONNECTION_MS, dataGapThresholdMs = DATA_GAP_THRESHOLD_MS } = {}) {
    if (!apiKey) throw new Error('GOAL_API_KEYが未設定です');
    Object.assign(this, { apiKey, fetchImpl, WebSocketImpl, persist, schedule, cancelSchedule, setIntervalImpl, clearIntervalImpl, now, random, heartbeatIntervalMs, stableConnectionMs, dataGapThresholdMs });
    this.sessionId = null; this.connectionId = null; this.sequence = 0; this.socket = null;
    this.fixtures = new Map(); this.desired = false; this.authenticated = false;
    this.sessionStopped = true;
    this.reconnectAttempt = 0; this.reconnectTimer = null; this.goalApiRequests = 0;
    this.connectionState = 'idle'; this.lastError = null; this.lastSocketActivityAt = null; this.heartbeatTimer = null;
    this.connection = null; this.tokenRequestsByReason = {}; this.reconnectsByReason = {};
    this.currentConnectionIsReconnect = false;
  }

  status() { return { active: this.desired, sessionId: this.sessionId, connectionId: this.connectionId, connectionState: this.connectionState, authenticated: this.authenticated, reconnectAttempt: this.reconnectAttempt, goalApiRequests: this.goalApiRequests, tokenRequestsByReason: structuredClone(this.tokenRequestsByReason), reconnectsByReason: structuredClone(this.reconnectsByReason), lastError: this.lastError, lastSocketActivityAt: this.lastSocketActivityAt, connection: this.connection ? structuredClone(this.connection) : null, fixtures: [...this.fixtures.values()].map((fixture) => structuredClone(fixture)) }; }

  async start(fixtures) {
    const selected = normalizeFixtures(fixtures).slice(0, 25);
    if (!selected.length) throw new Error('監視対象fixtureがありません');
    if (this.desired) await this.stop('replaced_by_new_session');
    this.sessionId = `${Date.now()}-${randomUUID()}`; this.sequence = 0;
    this.fixtures = new Map(selected.map((fixture) => [fixture.id, initialState(fixture)]));
    this.desired = true; this.sessionStopped = false; this.reconnectAttempt = 0; this.goalApiRequests = 0; this.lastError = null; this.lastSocketActivityAt = null; this.tokenRequestsByReason = {}; this.reconnectsByReason = {}; this.connection = null;
    await this.emitForActive('session_start', { selectedAt: this.now(), fixtureCount: selected.length }, { source: 'system' });
    void this.connect(false);
    return this.status();
  }

  async add(fixtures) {
    if (!this.desired || !this.sessionId) throw new Error('監視セッションが開始されていません');
    const activeCount = [...this.fixtures.values()].filter((fixture) => !fixture.ended).length;
    const additions = normalizeFixtures(fixtures).filter((fixture) => !this.fixtures.has(fixture.id) || this.fixtures.get(fixture.id)?.ended).slice(0, Math.max(0, 25 - activeCount));
    for (const fixture of additions) {
      const state = initialState(fixture); this.fixtures.set(fixture.id, state);
      await this.emit('session_add', state, { addedAt: this.now() }, { source: 'system' });
      if (this.authenticated) this.subscribe(fixture.id, false);
    }
    return this.status();
  }

  async remove(fixtureId, reason = 'manual_fixture_unsubscribe') {
    const fixture = this.fixtures.get(String(fixtureId));
    if (!fixture) throw new Error('監視対象fixtureが見つかりません');
    const activeCount = [...this.fixtures.values()].filter((item) => !item.ended).length;
    if (activeCount === 1 && !fixture.ended) { await this.stop(reason); this.fixtures.delete(fixture.id); return this.status(); }
    if (!fixture.ended && this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify({ type: 'unsubscribe', resource: 'match', matchId: fixture.id }));
    }
    await this.emit('unsubscribe', fixture, { reason, matchId: fixture.id }, { source: 'websocket' });
    this.fixtures.delete(fixture.id);
    return this.status();
  }

  async refresh(fixtureId, reason = 'manual_resubscribe') {
    const fixture = this.fixtures.get(String(fixtureId));
    if (!fixture || fixture.ended) throw new Error('監視対象fixtureが見つかりません');
    if (!this.authenticated || !this.socket || this.socket.readyState !== 1) throw new Error('Socketが接続されていません');
    fixture.lastRefreshAt = this.now(); fixture.subscriptionState = 'refreshing';
    this.socket.send(JSON.stringify({ type: 'unsubscribe', resource: 'match', matchId: fixture.id }));
    await this.emit('unsubscribe', fixture, { reason, matchId: fixture.id }, { source: 'websocket' });
    this.subscribe(fixture.id, true, reason);
    return this.status();
  }

  async checkHealth() {
    // Do not treat a quiet match as a broken socket. GOAL API may legitimately send
    // no match_update for a while. Native close/error events own reconnection; a
    // timer-driven unsubscribe or REST snapshot can interrupt a healthy stream and
    // makes a static response look like live data.
    const checkedAt = this.now();
    await Promise.all([...this.fixtures.values()].filter((fixture) => !fixture.ended).map(async (fixture) => {
      const gapMs = this.fixtureGapMs(fixture, checkedAt);
      if (gapMs === null || gapMs < this.dataGapThresholdMs || fixture.lastGapReportedAt) return;
      fixture.lastGapReportedAt = checkedAt;
      await this.emit('data_gap_detected', fixture, { connectionId: this.connectionId, gapMs, thresholdMs: this.dataGapThresholdMs, lastMatchUpdateAt: fixture.lastReceivedAt, checkedAt, reason: 'match_update_silence' }, { source: 'system' });
    }));
    return this.status();
  }

  async stop(reason = 'manual_stop') {
    if (!this.sessionId || this.sessionStopped) return this.status();
    this.desired = false; this.sessionStopped = true; this.connectionState = 'stopping';
    if (this.reconnectTimer) this.cancelSchedule(this.reconnectTimer); this.reconnectTimer = null;
    this.stopHeartbeat();
    for (const fixture of this.fixtures.values()) if (!fixture.ended && this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify({ type: 'unsubscribe', resource: 'match', matchId: fixture.id }));
      await this.emit('unsubscribe', fixture, { reason }, { source: 'websocket' });
    }
    await this.emitForActive('session_stop', { stoppedAt: this.now(), reason }, { source: 'system' });
    try { this.socket?.close(1000, reason); } catch {}
    this.socket = null; this.authenticated = false; this.connectionState = 'idle';
    return this.status();
  }

  async token(reason) {
    this.goalApiRequests += 1;
    this.tokenRequestsByReason[reason] = (this.tokenRequestsByReason[reason] ?? 0) + 1;
    await this.emitForActive('token_request', { ...this.connectionMetadata(), reason, tokenRequestNumber: this.goalApiRequests, tokenRequestsByReason: this.tokenRequestsByReason }, { source: 'system' });
    const response = await this.fetchImpl('https://api.goal-api.com/v1/ws/token', { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    const raw = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    if (!response.ok) throw new Error(`/ws/token HTTP ${response.status}: ${raw.slice(0, 160)}`);
    let body; try { body = JSON.parse(raw); } catch { throw new Error('/ws/tokenがJSON以外を返しました'); }
    const token = body?.data?.token ?? body?.token;
    if (!token) throw new Error('/ws/tokenにtokenがありません');
    return token;
  }

  async connect(isReconnect) {
    if (!this.desired) return;
    this.stopHeartbeat();
    this.connectionId = randomUUID(); this.currentConnectionIsReconnect = isReconnect; this.connectionState = isReconnect ? 'reconnecting' : 'connecting'; this.authenticated = false;
    this.connection = { connectionId: this.connectionId, connectAt: this.now(), authSuccessAt: null, firstMessageAt: null, lastMessageAt: null, firstMatchUpdateAt: null, lastMatchUpdateAt: null, disconnectAt: null, closeCode: null, closeReason: null, reconnectAttempt: this.reconnectAttempt, subscribedFixtureCount: 0, heartbeatSent: 0, heartbeatPong: 0, lastPingAt: null, lastPongAt: null, tokenReason: isReconnect ? 'reconnect' : 'initial' };
    await this.emitForActive('connection_start', { ...this.connectionMetadata(), isReconnect, attempt: this.reconnectAttempt, subscribedFixtureCount: this.activeFixtureCount() }, { source: 'system' });
    try {
      const token = await this.token(this.connection.tokenReason); if (!this.desired) return;
      const socket = new this.WebSocketImpl(`wss://api.goal-api.com/ws?wsToken=${encodeURIComponent(token)}`); this.socket = socket;
      socket.addEventListener('open', () => { if (!this.desired || socket !== this.socket) return; this.connectionState = 'authenticating'; void this.emitForActive('socket_open', {}, { source: 'websocket' }); socket.send(JSON.stringify({ type: 'auth', token })); });
      socket.addEventListener('message', (event) => void this.handleMessage(socket, event));
      socket.addEventListener('error', () => { if (socket !== this.socket) return; this.lastError = 'WebSocket error'; void this.emitForActive('socket_error', { error: this.lastError, ...this.connectionMetadata() }, { source: 'websocket' }); });
      socket.addEventListener('close', (event) => void this.handleClose(socket, event));
    } catch (error) { this.lastError = String(error); await this.emitForActive('connection_error', { error: this.lastError, ...this.connectionMetadata() }, { source: 'system' }); this.scheduleReconnect('connection_error'); }
  }

  async handleMessage(socket, event) {
    if (socket !== this.socket || !this.desired) return;
    const messageAt = this.now(); this.lastSocketActivityAt = messageAt;
    if (this.connection) { this.connection.firstMessageAt ??= messageAt; this.connection.lastMessageAt = messageAt; }
    let message; try { message = JSON.parse(String(event.data)); } catch { message = { type: 'unparsed', raw: String(event.data) }; }
    if (message.type === 'auth_success') {
      this.authenticated = true; this.connectionState = 'live';
      if (this.connection) this.connection.authSuccessAt = messageAt;
      await this.emitForActive('auth_success', { ...message, connection: this.connectionMetadata() }, { source: 'websocket' });
      this.startHeartbeat(socket);
      for (const fixture of this.fixtures.values()) if (!fixture.ended) this.subscribe(fixture.id, this.currentConnectionIsReconnect);
      return;
    }
    if (message.type === 'auth_error' || (message.type === 'error' && !this.authenticated)) {
      this.lastError = JSON.stringify(message.error ?? message); await this.emitForActive('auth_failure', message, { source: 'websocket' });
      try { socket.close(4001, 'auth failure'); } catch {} return;
    }
    if (message.type === 'subscribe_response' || message.type === 'unsubscribe_response') {
      const fixtureId = String(message?.data?.matchId ?? message?.matchId ?? ''); const fixture = this.fixtures.get(fixtureId);
      const type = message.type === 'subscribe_response' ? message.success ? 'subscribe_success' : 'subscribe_failure' : message.success ? 'unsubscribe_success' : 'unsubscribe_failure';
      if (fixture && message.type === 'subscribe_response') {
        fixture.subscriptionState = message.success ? 'subscribed_waiting' : 'failed';
        fixture.subscribedAt = this.now();
      }
      if (fixture) await this.emit(type, fixture, message, { source: 'websocket' }); else await this.emitForActive(type, message, { source: 'websocket' }); return;
    }
    if (message.type === 'pong') {
      if (this.connection) { this.connection.heartbeatPong += 1; this.connection.lastPongAt = messageAt; }
      return;
    }
    if (message.type !== 'match_update') { await this.emitForActive('websocket_frame', message, { source: 'websocket' }); return; }
    const data = message.data ?? {}; const fixtureId = String(data.id ?? data.fixture_id ?? data.fixtureId ?? ''); const fixture = this.fixtures.get(fixtureId); if (!fixture) return;
    const receivedAt = this.now();
    const nextStatus = String(data.match_status ?? fixture.status);
    const nextStats = Array.isArray(data.statistics) ? mergeStatistics(fixture.stats, data.statistics) : fixture.stats;
    if (['HT', 'HALF_TIME', 'HALF TIME'].includes(nextStatus.toUpperCase()) && nextStats.length) fixture.htStats = structuredClone(nextStats);
    Object.assign(fixture, { home: data.match_hometeam_name ?? fixture.home, away: data.match_awayteam_name ?? fixture.away, homeScore: String(data.match_hometeam_score ?? fixture.homeScore), awayScore: String(data.match_awayteam_score ?? fixture.awayScore), status: nextStatus, stats: structuredClone(nextStats), updates: fixture.updates + 1, updatedAt: receivedAt, lastReceivedAt: receivedAt });
    fixture.subscriptionState = 'receiving';
    fixture.lastGapReportedAt = null;
    if (this.connection) { this.connection.firstMatchUpdateAt ??= receivedAt; this.connection.lastMatchUpdateAt = receivedAt; }
    await this.emit('match_update', fixture, message, { source: 'websocket', receivedAt, providerTimestamp: providerTimestamp(data) });
    if (TERMINAL.has(nextStatus.toUpperCase()) || String(data.match_live) === '0') await this.finishFixture(fixture, message);
  }

  subscribe(fixtureId, reconnect, reason = reconnect ? 'socket_reconnect' : 'initial_subscribe') {
    const fixture = this.fixtures.get(fixtureId); if (!fixture || !this.socket || this.socket.readyState !== 1) return;
    fixture.subscriptionState = 'pending'; fixture.subscribeRequestedAt = this.now();
    this.socket.send(JSON.stringify({ type: 'subscribe', resource: 'match', matchId: fixtureId }));
    if (this.connection) this.connection.subscribedFixtureCount = this.activeFixtureCount();
    void this.emit(reconnect ? 'resubscribe' : 'subscribe', fixture, { matchId: fixtureId, reason }, { source: 'websocket' });
  }

  async finishFixture(fixture, raw) {
    if (fixture.ended) return; fixture.ended = true;
    await this.emit('fixture_end', fixture, raw, { source: 'websocket' });
    if (this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify({ type: 'unsubscribe', resource: 'match', matchId: fixture.id }));
      await this.emit('unsubscribe', fixture, { reason: 'fixture_finished', matchId: fixture.id }, { source: 'websocket' });
    }
    if ([...this.fixtures.values()].every((item) => item.ended)) await this.stop('all_fixtures_finished');
  }

  async handleClose(socket, event) {
    if (socket !== this.socket) return; const disconnectedAt = this.now(); const wasStable = this.connectionWasStable(disconnectedAt); const reconnectAttemptBeforeClose = this.reconnectAttempt;
    this.stopHeartbeat(); this.socket = null; this.authenticated = false;
    if (wasStable) this.reconnectAttempt = 0;
    if (this.connection) Object.assign(this.connection, { disconnectAt: disconnectedAt, closeCode: event.code, closeReason: event.reason || null, durationMs: this.connectionDurationMs(disconnectedAt), wasStable });
    const closePayload = { code: event.code, reason: event.reason, abnormal: this.desired, reconnectAttemptBeforeClose, nextReconnectAttempt: this.desired ? this.reconnectAttempt + 1 : null, ...this.connectionMetadata() };
    await Promise.all([...this.fixtures.values()].filter((fixture) => !fixture.ended).map(async (fixture) => {
      const gapMs = this.fixtureGapMs(fixture, disconnectedAt);
      if (gapMs !== null && gapMs >= this.dataGapThresholdMs) await this.emit('data_gap_detected', fixture, { ...closePayload, gapMs, thresholdMs: this.dataGapThresholdMs, lastMatchUpdateAt: fixture.lastReceivedAt, reason: 'socket_disconnected_after_update_gap' }, { source: 'system' });
      await this.emit('socket_disconnect', fixture, { ...closePayload, lastNormalReceivedAt: fixture.lastReceivedAt }, { source: 'websocket' });
    }));
    if (this.desired) this.scheduleReconnect(`socket_close_${event.code}`); else this.connectionState = 'idle';
  }

  scheduleReconnect(reason) {
    if (!this.desired || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    this.reconnectsByReason[reason] = (this.reconnectsByReason[reason] ?? 0) + 1;
    const baseDelayMs = Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(0, this.reconnectAttempt - 1), DEGRADED_RECONNECT_DELAY_MS);
    const jitterFactor = 0.8 + this.random() * 0.4;
    const delayMs = Math.min(DEGRADED_RECONNECT_DELAY_MS, Math.round(baseDelayMs * jitterFactor));
    this.connectionState = 'reconnect_wait';
    void this.emitForActive('reconnect_scheduled', { reason, attempt: this.reconnectAttempt, delayMs, baseDelayMs, jitterFactor, closeCategory: closeCategory(reason), tokenRequestsByReason: this.tokenRequestsByReason }, { source: 'system' });
    this.reconnectTimer = this.schedule(() => { this.reconnectTimer = null; void this.connect(true); }, delayMs);
  }

  startHeartbeat(socket) {
    this.stopHeartbeat();
    if (!this.heartbeatIntervalMs || this.heartbeatIntervalMs < 1) return;
    this.heartbeatTimer = this.setIntervalImpl(() => {
      if (!this.desired || socket !== this.socket || !this.authenticated || socket.readyState !== 1) return;
      try { socket.send(JSON.stringify({ type: 'ping' })); if (this.connection) { this.connection.heartbeatSent += 1; this.connection.lastPingAt = this.now(); } } catch (error) { this.lastError = `heartbeat send failed: ${String(error)}`; }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer?.unref?.();
  }

  stopHeartbeat() { if (this.heartbeatTimer) this.clearIntervalImpl(this.heartbeatTimer); this.heartbeatTimer = null; }
  activeFixtureCount() { return [...this.fixtures.values()].filter((fixture) => !fixture.ended).length; }
  connectionDurationMs(at) { const started = Date.parse(this.connection?.connectAt ?? ''); const ended = Date.parse(at); return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null; }
  connectionWasStable(at) { const authenticatedAt = Date.parse(this.connection?.authSuccessAt ?? ''); const ended = Date.parse(at); return this.authenticated && Number.isFinite(authenticatedAt) && Number.isFinite(ended) && ended - authenticatedAt >= this.stableConnectionMs; }
  fixtureGapMs(fixture, at) { const last = Date.parse(fixture.lastReceivedAt ?? ''); const end = Date.parse(at); return Number.isFinite(last) && Number.isFinite(end) ? Math.max(0, end - last) : null; }
  connectionMetadata() { if (!this.connection) return { connectionId: this.connectionId }; const { connectionId, connectAt, authSuccessAt, firstMessageAt, lastMessageAt, firstMatchUpdateAt, lastMatchUpdateAt, disconnectAt, durationMs, closeCode, closeReason, reconnectAttempt, subscribedFixtureCount, heartbeatSent, heartbeatPong, lastPingAt, lastPongAt, tokenReason, wasStable } = this.connection; return { connectionId, connectAt, authSuccessAt, firstMessageAt, lastMessageAt, firstMatchUpdateAt, lastMatchUpdateAt, disconnectAt, durationMs: durationMs ?? this.connectionDurationMs(this.now()), closeCode, closeReason, reconnectAttempt, subscribedFixtureCount, heartbeatSent, heartbeatPong, lastPingAt, lastPongAt, tokenReason, wasStable: wasStable ?? false }; }

  async emitForActive(eventType, payload, metadata = {}) { await Promise.all([...this.fixtures.values()].filter((fixture) => !fixture.ended || eventType === 'session_stop').map((fixture) => this.emit(eventType, fixture, payload, metadata))); }
  async emit(eventType, fixture, payload, metadata = {}) {
    const receivedAt = metadata.receivedAt ?? this.now(); const sequence = ++this.sequence; const serialized = JSON.stringify(payload);
    await this.persist({ clientEventId: `${this.sessionId}:${sequence}:${fixture.id}:${eventType}`, sessionId: this.sessionId, fixtureId: fixture.id, eventType, receivedAt, status: fixture.status, home: fixture.home, away: fixture.away, homeScore: fixture.homeScore, awayScore: fixture.awayScore, payload, connectionId: this.connectionId, sequence, source: metadata.source ?? 'system', providerTimestamp: metadata.providerTimestamp ?? null, payloadHash: createHash('sha256').update(serialized).digest('hex'), schemaVersion: 2 });
  }
}

function closeCategory(reason) {
  if (reason === 'socket_close_1001') return 'server_shutdown';
  if (reason === 'socket_close_4000') return 'activity_timeout';
  if (reason === 'socket_close_1006') return 'abnormal_closure';
  if (reason === 'connection_error') return 'token_or_connection_error';
  return 'other';
}

function initialState(fixture) { return { ...fixture, stats: [], updates: 0, updatedAt: null, lastReceivedAt: null, lastGapReportedAt: null, ended: false, htStats: null, subscriptionState: 'not_subscribed', subscribeRequestedAt: null, subscribedAt: null, lastRefreshAt: null }; }
function normalizeFixtures(fixtures) { return Array.isArray(fixtures) ? fixtures.filter((fixture) => fixture?.id).map((fixture) => ({ id: String(fixture.id), league: String(fixture.league ?? ''), country: String(fixture.country ?? ''), home: String(fixture.home ?? 'Home'), away: String(fixture.away ?? 'Away'), homeScore: String(fixture.homeScore ?? '-'), awayScore: String(fixture.awayScore ?? '-'), status: String(fixture.status ?? 'LIVE'), kickoffUtc: fixture.kickoffUtc ? String(fixture.kickoffUtc) : null, monitorSource: String(fixture.monitorSource ?? 'manual') })) : []; }

export function mergeStatistics(previous, incoming) {
  const merged = structuredClone(Array.isArray(previous) ? previous : []);
  const seen = new Map();
  for (const stat of Array.isArray(incoming) ? incoming : []) {
    const type = String(stat?.type ?? '');
    const occurrence = seen.get(type) ?? 0;
    seen.set(type, occurrence + 1);
    let found = -1; let matched = 0;
    for (let index = 0; index < merged.length; index += 1) {
      if (String(merged[index]?.type ?? '') !== type) continue;
      if (matched === occurrence) { found = index; break; }
      matched += 1;
    }
    if (found >= 0) merged[found] = structuredClone(stat);
    else merged.push(structuredClone(stat));
  }
  return merged;
}
