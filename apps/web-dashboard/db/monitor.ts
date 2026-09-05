import { monitorSchema } from '@/db/schema';

let schemaReady: Promise<void> | undefined;

export async function ensureMonitorSchema(db: D1Database) {
  schemaReady ??= (async () => {
    await db.batch(monitorSchema.map((statement) => db.prepare(statement)));
    const columns = await db.prepare('PRAGMA table_info(monitor_events)').all<{ name: string }>();
    const existing = new Set((columns.results ?? []).map((column) => column.name));
    const additions = [
      ['client_event_id', 'TEXT'], ['connection_id', 'TEXT'], ['sequence', 'INTEGER'],
      ['source', "TEXT NOT NULL DEFAULT 'browser'"], ['provider_timestamp', 'TEXT'],
      ['payload_hash', 'TEXT'], ['schema_version', 'INTEGER NOT NULL DEFAULT 1'],
    ] as const;
    for (const [name, definition] of additions) {
      if (!existing.has(name)) await db.prepare(`ALTER TABLE monitor_events ADD COLUMN ${name} ${definition}`).run();
    }
    await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS monitor_events_client_event_idx ON monitor_events (client_event_id) WHERE client_event_id IS NOT NULL').run();
  })();
  await schemaReady;
}
