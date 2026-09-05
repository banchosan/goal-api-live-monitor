import { createHash, randomUUID } from 'node:crypto';

const TERMINAL = new Set(['FT', 'FINISHED', 'AFTER_ET', 'AFTER_PEN', 'CANCELLED', 'ABANDONED', 'AWARDED']);
const providerTimestamp = (data) => data?.timestamp ?? data?.updated_at ?? data?.updatedAt ?? null;

export class GoalApiCollector {
  constructor({ apiKey, fetchImpl = fetch, WebSocketImpl = WebSocket, persist = async () => {}, schedule = setTimeout, cancelSchedule = clearTimeout, now = () => new Date().toISOString() } = {}) {
    if (!apiKey) throw new Error('GOAL_API_KEYが未設定です');
    Object.assign(this, { apiKey, fetchImpl, WebSocketImpl, persist, schedule, cancelSchedule, now });
    this.sessionId = null; this.connectionId = null; this.sequence = 0; this.socket = null;
    this.fixtures = new Map(); this.desired = false; this.authenticated = false;
    this.reconnectAttempt = 0; this.reconnectTimer = null; this.goalApiRequests = 0;
    this.connectionState = 'idle'; this.lastError = null;
    this.currentConnectionIsReconnect = false;
  }

  status() { return { active: this.desired, sessionId: this.sessionId, connectionId: this.connectionId, connectionState: this.connectionState, authenticated: this.authenticated, reconnectAttempt: this.reconnectAttempt, goalApiRequests: this.goalApiRequests, lastError: this.lastError, fixtures: [...this.fixtures.values()].map((fixture) => structuredClone(fixture)) }; }

  async start(fixtures) {
    const selected = normalizeFixtures(fixtures).slice(0, 25);
    if (!selected.length) throw new Error('監視対象fixtureがありません');
    if (this.desired) await this.stop('replaced_by_new_session');
    this.sessionId = `${Date.now()}-${randomUUID()}`; this.sequence = 0;
    this.fixtures = new Map(selected.map((fixture) => [fixture.id, initialState(fixture)]));
    this.desired = true; this.reconnectAttempt = 0; this.goalApiRequests = 0; this.lastError = null;
    await this.emitForActive('session_start', { selectedAt: this.now(), fixtureCount: selected.length }, { source: 'system' });
    void this.connect(false);
    return this.status();
  }

  async add(fixtures) {
    if (!this.desired || !this.sessionId) throw new Error('監視セッションが開始されていません');
    const additions = normalizeFixtures(fixtures).filter((fixture) => !this.fixtures.has(fixture.id)).slice(0, 25 - this.fixtures.size);
    for (const fixture of additions) {
      const state = initialState(fixture); this.fixtures.set(fixture.id, state);
      await this.emit('session_add', state, { addedAt: this.now() }, { source: 'system' });
      if (this.authenticated) this.subscribe(fixture.id, false);
    }
    return this.status();
  }

  async stop(reason = 'manual_stop') {
    if (!this.sessionId) return this.status();
    this.desired = false; this.connectionState = 'stopping';
    if (this.reconnectTimer) this.cancelSchedule(this.reconnectTimer); this.reconnectTimer = null;
    for (const fixture of this.fixtures.values()) if (!fixture.ended && this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify({ type: 'unsubscribe', resource: 'match', matchId: fixture.id }));
      await this.emit('unsubscribe', fixture, { reason }, { source: 'websocket' });
    }
    await this.emitForActive('session_stop', { stoppedAt: this.now(), reason }, { source: 'system' });
    try { this.socket?.close(1000, reason); } catch {}
    this.socket = null; this.authenticated = false; this.connectionState = 'idle';
    return this.status();
  }

  async token() {
    this.goalApiRequests += 1;
    const response = await this.fetchImpl('https://api.goal-api.com/v1/ws/token', { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' } });
    const body = await response.json();
    if (!response.ok) throw new Error(`/ws/token HTTP ${response.status}`);
    const token = body?.data?.token ?? body?.token;
    if (!token) throw new Error('/ws/tokenにtokenがありません');
    return token;
  }

  async connect(isReconnect) {
    if (!this.desired) return;
    this.connectionId = randomUUID(); this.currentConnectionIsReconnect = isReconnect; this.connectionState = isReconnect ? 'reconnecting' : 'connecting'; this.authenticated = false;
    await this.emitForActive('connection_start', { isReconnect, attempt: this.reconnectAttempt }, { source: 'system' });
    try {
      const token = await this.token(); if (!this.desired) return;
      const socket = new this.WebSocketImpl(`wss://api.goal-api.com/ws?wsToken=${encodeURIComponent(token)}`); this.socket = socket;
      socket.addEventListener('open', () => { if (!this.desired || socket !== this.socket) return; this.connectionState = 'authenticating'; void this.emitForActive('socket_open', {}, { source: 'websocket' }); socket.send(JSON.stringify({ type: 'auth', token })); });
      socket.addEventListener('message', (event) => void this.handleMessage(socket, event));
      socket.addEventListener('error', () => { if (socket !== this.socket) return; this.lastError = 'WebSocket error'; void this.emitForActive('socket_error', { error: this.lastError }, { source: 'websocket' }); });
      socket.addEventListener('close', (event) => void this.handleClose(socket, event));
    } catch (error) { this.lastError = String(error); await this.emitForActive('connection_error', { error: this.lastError }, { source: 'system' }); this.scheduleReconnect('connection_error'); }
  }

  async handleMessage(socket, event) {
    if (socket !== this.socket || !this.desired) return;
    let message; try { message = JSON.parse(String(event.data)); } catch { message = { type: 'unparsed', raw: String(event.data) }; }
    if (message.type === 'auth_success') {
      this.authenticated = true; this.connectionState = 'live'; this.reconnectAttempt = 0;
      await this.emitForActive('auth_success', message, { source: 'websocket' });
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
      if (fixture) await this.emit(type, fixture, message, { source: 'websocket' }); else await this.emitForActive(type, message, { source: 'websocket' }); return;
    }
    if (message.type !== 'match_update') { await this.emitForActive('websocket_frame', message, { source: 'websocket' }); return; }
    const data = message.data ?? {}; const fixtureId = String(data.id ?? data.fixture_id ?? data.fixtureId ?? ''); const fixture = this.fixtures.get(fixtureId); if (!fixture) return;
    const receivedAt = this.now(); const previousMinute = /^\d+$/.test(String(fixture.status)) ? Number(fixture.status) : null;
    const nextStatus = String(data.match_status ?? fixture.status); const minute = /^\d+$/.test(nextStatus) ? Number(nextStatus) : null;
    const nextStats = Array.isArray(data.statistics) ? data.statistics : fixture.stats;
    if (['HT', 'HALF_TIME', 'HALF TIME'].includes(nextStatus.toUpperCase()) && nextStats.length) fixture.htStats = structuredClone(nextStats);
    else if (!fixture.htStats && minute !== null && minute >= 46 && previousMinute !== null && previousMinute <= 45 && fixture.stats.length) fixture.htStats = structuredClone(fixture.stats);
    if (!fixture.sixtyStats && fixture.htStats && minute !== null && minute >= 60 && nextStats.length) { fixture.sixtyStats = structuredClone(nextStats); fixture.sixtyMinute = minute; }
    Object.assign(fixture, { home: data.match_hometeam_name ?? fixture.home, away: data.match_awayteam_name ?? fixture.away, homeScore: String(data.match_hometeam_score ?? fixture.homeScore), awayScore: String(data.match_awayteam_score ?? fixture.awayScore), status: nextStatus, stats: structuredClone(nextStats), updates: fixture.updates + 1, updatedAt: receivedAt, lastReceivedAt: receivedAt });
    await this.emit('match_update', fixture, message, { source: 'websocket', receivedAt, providerTimestamp: providerTimestamp(data) });
    if (TERMINAL.has(nextStatus.toUpperCase()) || String(data.match_live) === '0') await this.finishFixture(fixture, message);
  }

  subscribe(fixtureId, reconnect) {
    const fixture = this.fixtures.get(fixtureId); if (!fixture || !this.socket || this.socket.readyState !== 1) return;
    this.socket.send(JSON.stringify({ type: 'subscribe', resource: 'match', matchId: fixtureId }));
    void this.emit(reconnect ? 'resubscribe' : 'subscribe', fixture, { matchId: fixtureId }, { source: 'websocket' });
  }

  async finishFixture(fixture, raw) {
    if (fixture.ended) return; fixture.ended = true;
    await this.emit('fixture_end', fixture, raw, { source: 'websocket' });
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type: 'unsubscribe', resource: 'match', matchId: fixture.id }));
    if ([...this.fixtures.values()].every((item) => item.ended)) await this.stop('all_fixtures_finished');
  }

  async handleClose(socket, event) {
    if (socket !== this.socket) return; this.socket = null; this.authenticated = false;
    await this.emitForActive('socket_disconnect', { code: event.code, reason: event.reason, abnormal: this.desired }, { source: 'websocket' });
    if (this.desired) this.scheduleReconnect(`socket_close_${event.code}`); else this.connectionState = 'idle';
  }

  scheduleReconnect(reason) {
    if (!this.desired || this.reconnectTimer) return;
    this.reconnectAttempt += 1; const delayMs = Math.min(1000 * 2 ** Math.min(this.reconnectAttempt - 1, 5), 30_000); this.connectionState = 'reconnect_wait';
    void this.emitForActive('reconnect_scheduled', { reason, attempt: this.reconnectAttempt, delayMs }, { source: 'system' });
    this.reconnectTimer = this.schedule(() => { this.reconnectTimer = null; void this.connect(true); }, delayMs);
  }

  async emitForActive(eventType, payload, metadata = {}) { await Promise.all([...this.fixtures.values()].filter((fixture) => !fixture.ended || eventType === 'session_stop').map((fixture) => this.emit(eventType, fixture, payload, metadata))); }
  async emit(eventType, fixture, payload, metadata = {}) {
    const receivedAt = metadata.receivedAt ?? this.now(); const sequence = ++this.sequence; const serialized = JSON.stringify(payload);
    await this.persist({ clientEventId: `${this.sessionId}:${sequence}:${fixture.id}:${eventType}`, sessionId: this.sessionId, fixtureId: fixture.id, eventType, receivedAt, status: fixture.status, home: fixture.home, away: fixture.away, homeScore: fixture.homeScore, awayScore: fixture.awayScore, payload, connectionId: this.connectionId, sequence, source: metadata.source ?? 'system', providerTimestamp: metadata.providerTimestamp ?? null, payloadHash: createHash('sha256').update(serialized).digest('hex'), schemaVersion: 2 });
  }
}

function initialState(fixture) { return { ...fixture, stats: [], updates: 0, updatedAt: null, lastReceivedAt: null, ended: false, htStats: null, sixtyStats: null, sixtyMinute: null }; }
function normalizeFixtures(fixtures) { return Array.isArray(fixtures) ? fixtures.filter((fixture) => fixture?.id).map((fixture) => ({ id: String(fixture.id), league: String(fixture.league ?? ''), country: String(fixture.country ?? ''), home: String(fixture.home ?? 'Home'), away: String(fixture.away ?? 'Away'), homeScore: String(fixture.homeScore ?? '-'), awayScore: String(fixture.awayScore ?? '-'), status: String(fixture.status ?? 'LIVE') })) : []; }
