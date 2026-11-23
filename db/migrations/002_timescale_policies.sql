-- Compression, continuous aggregates and retention for pond and RAS sensor data.

-- ---------- Pond DO probes ----------

ALTER TABLE sensor_readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'pond_id',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('sensor_readings', INTERVAL '7 days');

-- 5-minute buckets: used for 7-day charts.
CREATE MATERIALIZED VIEW sensor_5m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', time) AS bucket,
  pond_id,
  avg(do_mgl) AS do_mgl,
  min(do_mgl) AS do_min,
  avg(do_pct) AS do_pct,
  avg(temp_c) AS temp_c
FROM sensor_readings
GROUP BY bucket, pond_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('sensor_5m',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes');

-- 1-hour buckets: used for 30-day / whole-cycle charts.
CREATE MATERIALIZED VIEW sensor_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', time) AS bucket,
  pond_id,
  avg(do_mgl) AS do_mgl,
  min(do_mgl) AS do_min,
  avg(do_pct) AS do_pct,
  avg(temp_c) AS temp_c
FROM sensor_readings
GROUP BY bucket, pond_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('sensor_1h',
  start_offset => INTERVAL '7 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');

-- Raw data kept 1 year, 5-minute data 3 years, hourly data forever.
SELECT add_retention_policy('sensor_readings', INTERVAL '365 days');
SELECT add_retention_policy('sensor_5m', INTERVAL '1095 days');

-- ---------- RAS probes (pH, ORP, temp per unit) ----------

ALTER TABLE ras_readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'unit_id',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('ras_readings', INTERVAL '7 days');

CREATE MATERIALIZED VIEW ras_5m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', time) AS bucket,
  unit_id,
  avg(ph)     AS ph,
  avg(orp_mv) AS orp_mv,
  avg(temp_c) AS temp_c
FROM ras_readings
GROUP BY bucket, unit_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('ras_5m',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes');

CREATE MATERIALIZED VIEW ras_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', time) AS bucket,
  unit_id,
  avg(ph)     AS ph,
  avg(orp_mv) AS orp_mv,
  avg(temp_c) AS temp_c
FROM ras_readings
GROUP BY bucket, unit_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('ras_1h',
  start_offset => INTERVAL '7 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');

SELECT add_retention_policy('ras_readings', INTERVAL '365 days');
SELECT add_retention_policy('ras_5m', INTERVAL '1095 days');
