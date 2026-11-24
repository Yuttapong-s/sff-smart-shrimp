-- Phase 4: alert engine (Web Push + in-app), acknowledgement and escalation.

-- ---------- Alarms ----------
-- key identifies "the same problem" (e.g. pond:12:do) so it is never open twice.
ALTER TABLE alarms ADD COLUMN unit_id int REFERENCES units(id) ON DELETE CASCADE;
ALTER TABLE alarms ADD COLUMN kind text NOT NULL DEFAULT 'sensor'
  CHECK (kind IN ('sensor', 'offline', 'gateway', 'water', 'lab'));
ALTER TABLE alarms ADD COLUMN key text;
UPDATE alarms SET key = 'legacy:' || id WHERE key IS NULL;
ALTER TABLE alarms ALTER COLUMN key SET NOT NULL;
ALTER TABLE alarms ADD COLUMN value real;
ALTER TABLE alarms ADD COLUMN last_notified_at timestamptz;
ALTER TABLE alarms ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX alarms_open_key_uq ON alarms (farm_id, key) WHERE cleared_at IS NULL;
CREATE INDEX alarms_unit_idx ON alarms (unit_id, started_at DESC);
CREATE INDEX alarms_history_idx ON alarms (farm_id, started_at DESC);
CREATE INDEX alarms_key_idx ON alarms (key);

-- Who was told about what, and whether delivery worked.
CREATE TABLE alarm_notifications (
  id        bigserial PRIMARY KEY,
  alarm_id  bigint REFERENCES alarms(id) ON DELETE CASCADE,
  user_id   int REFERENCES users(id) ON DELETE CASCADE,
  reason    text NOT NULL CHECK (reason IN ('open', 'raise', 'renotify', 'escalate', 'clear', 'test')),
  sent_at   timestamptz NOT NULL DEFAULT now(),
  devices   int NOT NULL DEFAULT 0,               -- push subscriptions reached
  failed    int NOT NULL DEFAULT 0
);
CREATE INDEX alarm_notifications_alarm_idx ON alarm_notifications (alarm_id, sent_at DESC);

-- ---------- Web Push ----------
ALTER TABLE push_subscriptions ADD COLUMN user_agent text;
ALTER TABLE push_subscriptions ADD COLUMN last_ok_at timestamptz;
ALTER TABLE push_subscriptions ADD COLUMN fail_count int NOT NULL DEFAULT 0;

-- Generated VAPID keys etc. (env vars override).
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Shorter default hold for dissolved oxygen: a DO crash kills shrimp within the hour.
UPDATE alarm_rules SET hold_seconds = 120 WHERE metric = 'do' AND hold_seconds = 300;
