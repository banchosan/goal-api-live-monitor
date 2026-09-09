# Local D1 schema operations

This repository currently manages **only the Miniflare local D1 database**.
No command in this document contacts Cloudflare or a remote database.

The expected application schema is `apps/web-dashboard/db/schema.ts` as
`canonicalSchema`.  `monitorSchema` is intentionally empty: HTTP requests may
not run DDL.  The local tool reads the canonical declaration, builds a clean
database model, and compares tables, columns, types, nullability, defaults,
primary-key flags, and indexes.

Run from `apps/web-dashboard`:

```bash
npm run db:local:test       # synthetic clean/adoption/integrity test suite
npm run db:local:verify     # read-only check of the real local DB
npm run db:local:fingerprint
npm run db:local:adopt      # validates, reconciles live_snapshots, then stamps
```

`db:local:adopt` is idempotent.  For an old `live_snapshots` table it first
requires every `source_event_id` to join to `monitor_events.id` with a non-null,
unique `monitor_events.client_event_id`.  Only then it rebuilds the table with
`source_client_event_id`, verifies row/session/null/timestamp aggregates, and
records `0004_local_canonical_adoption.sql` in local `d1_migrations`.

It stops without rebuilding for NULL source IDs, unmatched monitor events, NULL
client event IDs, duplicate `(session_id, client_event_id)`, or an unknown
table shape.  Historical raw data is never deleted by a successful rebuild.

Before any adoption, retain a SQLite backup.  The existing protected backup is
`/tmp/goal-api-local-d1-before-adoption.sqlite`; this tool never writes to it.
For a future schema change, update `canonicalSchema`, run the synthetic tests,
then add a named reconciliation/adoption step.  Do not restore request-time
schema bootstrap.
