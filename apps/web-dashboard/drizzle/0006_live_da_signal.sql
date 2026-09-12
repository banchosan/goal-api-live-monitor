-- Local D1: stable per-side signal dedupe for realtime LIVE rules.
-- Existing historical signals remain readable; new signal rows always set signal_key.
ALTER TABLE live_signals ADD COLUMN signal_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS live_signals_rule_side_dedupe_idx
  ON live_signals (fixture_id, signal_type, signal_version, signal_key)
  WHERE signal_key IS NOT NULL;
