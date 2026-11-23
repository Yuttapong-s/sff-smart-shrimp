-- Core schema: farm structure, crop cycles, devices, users, time-series data.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------- Farm structure ----------

CREATE TABLE farms (
  id              serial PRIMARY KEY,
  code            text NOT NULL UNIQUE,          -- matches MQTT {farm}
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'Asia/Bangkok',
  gateway_online  boolean,
  gateway_seen_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Unit = one RAS (recirculating aquaculture system) shared by 1-10 ponds.
-- RAS water quality (pH, ORP, temp) is measured per unit; DO/temp per pond.
CREATE TABLE units (
  id       serial PRIMARY KEY,
  farm_id  int NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  code     text NOT NULL,                       -- matches MQTT {unit}, e.g. U01
  name     text NOT NULL,
  sort     int NOT NULL DEFAULT 0,
  UNIQUE (farm_id, code)
);

CREATE TABLE ponds (
  id        serial PRIMARY KEY,
  farm_id   int NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  unit_id   int NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  code      text NOT NULL,                       -- matches MQTT {pond}, e.g. U01-P01
  name      text,
  area_rai  numeric(6,2),
  sort      int NOT NULL DEFAULT 0,
  UNIQUE (farm_id, code)
);
CREATE INDEX ponds_unit_idx ON ponds (unit_id);

-- One RAS serves at most 10 ponds.
CREATE FUNCTION ponds_unit_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM units WHERE id = NEW.unit_id FOR UPDATE;  -- serialize concurrent inserts per unit
  IF (SELECT count(*) FROM ponds WHERE unit_id = NEW.unit_id AND id <> NEW.id) >= 10 THEN
    RAISE EXCEPTION 'unit % already has 10 ponds', NEW.unit_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ponds_unit_limit BEFORE INSERT OR UPDATE OF unit_id ON ponds
  FOR EACH ROW EXECUTE FUNCTION ponds_unit_limit();

-- Crop cycle (รอบการเลี้ยง). Water/lab data links to the cycle for FCR & yield analysis.
CREATE TABLE crop_cycles (
  id             serial PRIMARY KEY,
  pond_id        int NOT NULL REFERENCES ponds(id) ON DELETE CASCADE,
  cycle_no       int NOT NULL,
  species        text NOT NULL DEFAULT 'L. vannamei',
  stocked_at     date NOT NULL,
  stocked_count  int,
  harvested_at   date,
  harvest_kg     numeric(10,2),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'harvested', 'cancelled')),
  note           text,
  UNIQUE (pond_id, cycle_no)
);
CREATE UNIQUE INDEX crop_cycles_one_active ON crop_cycles (pond_id) WHERE status = 'active';

-- Weight sampling (สุ่มน้ำหนัก / ABW) and feeding.
CREATE TABLE growth_samples (
  id          serial PRIMARY KEY,
  cycle_id    int NOT NULL REFERENCES crop_cycles(id) ON DELETE CASCADE,
  sampled_at  timestamptz NOT NULL,
  abw_g       numeric(7,2) NOT NULL,
  survival_pct numeric(5,2),
  recorded_by int,
  note        text
);
CREATE INDEX growth_samples_cycle_idx ON growth_samples (cycle_id, sampled_at DESC);

CREATE TABLE feedings (
  id          serial PRIMARY KEY,
  cycle_id    int NOT NULL REFERENCES crop_cycles(id) ON DELETE CASCADE,
  fed_at      timestamptz NOT NULL,
  feed_kg     numeric(8,2) NOT NULL,
  feed_type   text,
  tray_check  text,                              -- ผลเช็คยอ
  recorded_by int,
  client_id   uuid UNIQUE                        -- idempotency for offline submissions
);
CREATE INDEX feedings_cycle_idx ON feedings (cycle_id, fed_at DESC);

-- ---------- Devices / control ----------

CREATE TABLE devices (
  id       serial PRIMARY KEY,
  pond_id  int NOT NULL REFERENCES ponds(id) ON DELETE CASCADE,
  code     text NOT NULL,                        -- PLC tag / MQTT device code
  kind     text NOT NULL CHECK (kind IN ('aerator', 'pump', 'feeder', 'siren', 'other')),
  name     text NOT NULL,
  UNIQUE (pond_id, code)
);

-- Actual device state from PLC feedback (aux contact / motor current), never from "command sent".
CREATE TABLE device_state (
  device_id  int PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  is_on      boolean,
  current_a  real,
  fault      boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);

-- HMI Local/Remote switch. Cloud commands are rejected unless mode = 'remote'.
CREATE TABLE pond_control (
  pond_id    int PRIMARY KEY REFERENCES ponds(id) ON DELETE CASCADE,
  mode       text NOT NULL DEFAULT 'unknown' CHECK (mode IN ('local', 'remote', 'unknown')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Users ----------

CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'manager', 'technician', 'worker')),
  phone         text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- Alarm configuration and history ----------

CREATE TABLE alarm_rules (
  id           serial PRIMARY KEY,
  farm_id      int NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  metric       text NOT NULL,
  crit_low     real,
  warn_low     real,
  warn_high    real,
  crit_high    real,
  hold_seconds int NOT NULL DEFAULT 300,         -- value must persist this long before alarming
  UNIQUE (farm_id, metric)
);

CREATE TABLE alarms (
  id          bigserial PRIMARY KEY,
  farm_id     int NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  pond_id     int REFERENCES ponds(id) ON DELETE CASCADE,
  metric      text,
  severity    text NOT NULL CHECK (severity IN ('warn', 'crit')),
  message     text NOT NULL,
  source      text NOT NULL DEFAULT 'cloud' CHECK (source IN ('cloud', 'edge')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  acked_at    timestamptz,
  acked_by    int REFERENCES users(id),
  escalation_level int NOT NULL DEFAULT 0
);
CREATE INDEX alarms_open_idx ON alarms (farm_id, started_at DESC) WHERE cleared_at IS NULL;
CREATE INDEX alarms_pond_idx ON alarms (pond_id, started_at DESC);

CREATE TABLE push_subscriptions (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  keys       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Commands and audit ----------

CREATE TABLE commands (
  id           uuid PRIMARY KEY,
  pond_id      int NOT NULL REFERENCES ponds(id) ON DELETE CASCADE,
  device_id    int NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  action       text NOT NULL CHECK (action IN ('on', 'off')),
  requested_by int NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sent', 'acked', 'rejected', 'expired', 'failed')),
  ack_at       timestamptz,
  ack_detail   jsonb
);
CREATE INDEX commands_pond_idx ON commands (pond_id, requested_at DESC);

CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  user_id int REFERENCES users(id),
  action  text NOT NULL,
  target  text,
  detail  jsonb
);

-- ---------- Sensor maintenance ----------

-- A probe sits either in a pond (DO) or in the unit's RAS (pH, ORP).
CREATE TABLE calibrations (
  id             serial PRIMARY KEY,
  pond_id        int REFERENCES ponds(id) ON DELETE CASCADE,
  unit_id        int REFERENCES units(id) ON DELETE CASCADE,
  metric         text NOT NULL,
  calibrated_at  timestamptz NOT NULL,
  next_due       date,
  calibrated_by  int REFERENCES users(id),
  note           text,
  CHECK ((pond_id IS NULL) <> (unit_id IS NULL))
);
CREATE INDEX calibrations_pond_idx ON calibrations (pond_id, calibrated_at DESC);
CREATE INDEX calibrations_unit_idx ON calibrations (unit_id, calibrated_at DESC);

-- ---------- Time-series: online sensors ----------

-- Pond DO probe. quality bit flags: 1 = do_mgl out of range, 2 = do_pct, 4 = temp,
-- 16 = backfilled from edge buffer
CREATE TABLE sensor_readings (
  time     timestamptz NOT NULL,
  pond_id  int NOT NULL,
  do_mgl   real,
  do_pct   real,                                 -- % saturation
  temp_c   real,
  quality  smallint NOT NULL DEFAULT 0
);
SELECT create_hypertable('sensor_readings', by_range('time', INTERVAL '1 day'));
-- Unique so edge buffer re-sends are idempotent (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX sensor_readings_pond_time_uq ON sensor_readings (pond_id, time DESC);

-- Latest value per pond, maintained by ingest. The overview reads this, never the hypertable.
CREATE TABLE pond_latest (
  pond_id    int PRIMARY KEY REFERENCES ponds(id) ON DELETE CASCADE,
  time       timestamptz NOT NULL,
  do_mgl     real,
  do_pct     real,
  temp_c     real,
  quality    smallint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Time-series: RAS sensors (one set per unit) ----------

-- pH probe (pH + temp) and ORP probe. quality bit flags: 1 = ph, 2 = orp, 4 = temp, 16 = backfill
CREATE TABLE ras_readings (
  time     timestamptz NOT NULL,
  unit_id  int NOT NULL,
  ph       real,
  orp_mv   real,
  temp_c   real,
  quality  smallint NOT NULL DEFAULT 0
);
SELECT create_hypertable('ras_readings', by_range('time', INTERVAL '7 days'));
CREATE UNIQUE INDEX ras_readings_unit_time_uq ON ras_readings (unit_id, time DESC);

CREATE TABLE ras_latest (
  unit_id    int PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  time       timestamptz NOT NULL,
  ph         real,
  orp_mv     real,
  temp_c     real,
  quality    smallint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Time-series: manual water tests (test kit) ----------

CREATE TABLE manual_readings (
  time        timestamptz NOT NULL,
  pond_id     int NOT NULL,
  cycle_id    int,
  param       text NOT NULL,                     -- alkalinity, nh3, no2, salinity, hardness, ...
  value       real NOT NULL,
  unit        text,
  method      text NOT NULL DEFAULT 'test_kit',
  recorded_by int,
  client_id   uuid NOT NULL,                     -- idempotency for offline submissions
  note        text
);
SELECT create_hypertable('manual_readings', by_range('time', INTERVAL '30 days'));
CREATE UNIQUE INDEX manual_readings_client_uq ON manual_readings (client_id, time);
CREATE INDEX manual_readings_pond_idx ON manual_readings (pond_id, time DESC);

-- ---------- Lab results ----------

CREATE TABLE lab_results (
  id          serial PRIMARY KEY,
  pond_id     int NOT NULL REFERENCES ponds(id) ON DELETE CASCADE,
  cycle_id    int REFERENCES crop_cycles(id),
  sampled_at  timestamptz NOT NULL,
  lab_name    text,
  param       text NOT NULL,                     -- vibrio_green, vibrio_yellow, plankton, ehp, ...
  value       real,
  value_text  text,
  unit        text,
  file_url    text,
  recorded_by int REFERENCES users(id),
  client_id   uuid UNIQUE
);
CREATE INDEX lab_results_pond_idx ON lab_results (pond_id, sampled_at DESC);
