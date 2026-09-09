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
}
