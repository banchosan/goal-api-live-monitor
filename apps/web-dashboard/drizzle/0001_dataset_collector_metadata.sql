ALTER TABLE monitor_events ADD COLUMN client_event_id TEXT;
ALTER TABLE monitor_events ADD COLUMN connection_id TEXT;
ALTER TABLE monitor_events ADD COLUMN sequence INTEGER;
ALTER TABLE monitor_events ADD COLUMN source TEXT NOT NULL DEFAULT 'browser';
ALTER TABLE monitor_events ADD COLUMN provider_timestamp TEXT;
ALTER TABLE monitor_events ADD COLUMN payload_hash TEXT;
ALTER TABLE monitor_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX monitor_events_client_event_idx
  ON monitor_events (client_event_id)
  WHERE client_event_id IS NOT NULL;
