-- Phase 5: remote device commands (app -> MQTT cmd -> PLC ack -> real state), expiry, audit.

ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_action_check;
ALTER TABLE commands ADD CONSTRAINT commands_action_check CHECK (action IN ('on', 'off', 'auto'));
ALTER TABLE commands ADD COLUMN sent_at timestamptz;          -- broker PUBACK received
ALTER TABLE commands ADD COLUMN reason text;                  -- reject / fail / expiry reason code
ALTER TABLE commands ADD COLUMN context jsonb;                -- pond DO, mode, device state at request time

CREATE INDEX commands_device_idx ON commands (device_id, requested_at DESC);
-- At most one command per device waiting for the PLC; the api sweeper expires them.
CREATE UNIQUE INDEX commands_inflight_uq ON commands (device_id) WHERE status IN ('pending', 'sent');

-- PLC reports whether a device runs on its automatic logic or on a manual override.
ALTER TABLE device_state ADD COLUMN auto boolean;
