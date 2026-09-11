/**
 * Request handlers must never mutate D1 schema.  Local schema changes are
 * performed by scripts/local_d1_foundation.py before the app is started.
 */
export async function ensureMonitorSchema(db: D1Database) {
  const result = await db.prepare('PRAGMA table_info(monitor_events)').all<{ name: string }>();
  const columns = new Set((result.results ?? []).map((column) => column.name));
  const required = ['client_event_id', 'connection_id', 'sequence', 'source', 'provider_timestamp', 'payload_hash', 'schema_version'];
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length) throw new Error(`Local D1 schema is not adopted. Missing monitor_events columns: ${missing.join(', ')}`);
  const snapshots = await db.prepare('PRAGMA table_info(live_snapshots)').all<{ name: string }>();
  const snapshotColumns = new Set((snapshots.results ?? []).map((column) => column.name));
  const snapshotRequired = ['provider', 'provider_fixture_id', 'provider_event_key', 'added_time', 'match_status', 'attacks_home', 'attacks_away', 'yellow_cards_home', 'yellow_cards_away', 'red_cards_home', 'red_cards_away', 'saves_home', 'saves_away', 'passes_total_home', 'passes_total_away', 'passes_accurate_home', 'passes_accurate_away'];
  const snapshotMissing = snapshotRequired.filter((name) => !snapshotColumns.has(name));
  if (snapshotMissing.length) throw new Error(`Local D1 schema is not adopted. Missing live_snapshots columns: ${snapshotMissing.join(', ')}`);
}
