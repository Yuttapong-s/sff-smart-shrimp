-- Phase 3: offline-first manual records.
-- Every record carries a client_id generated on the phone, so a re-sent outbox item is a no-op.

-- ---------- Test-kit water tests: measured on the RAS (shared water), not per pond ----------

DROP INDEX IF EXISTS manual_readings_pond_idx;
DROP INDEX IF EXISTS manual_readings_client_uq;
ALTER TABLE manual_readings RENAME COLUMN pond_id TO unit_id;
ALTER TABLE manual_readings DROP COLUMN cycle_id;
ALTER TABLE manual_readings ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
-- One submission (client_id) holds several params measured at the same time.
CREATE UNIQUE INDEX manual_readings_client_uq ON manual_readings (client_id, param, time);
CREATE INDEX manual_readings_unit_idx ON manual_readings (unit_id, time DESC);

-- ---------- Lab results: RAS water (unit) or shrimp sample (pond) ----------

ALTER TABLE lab_results ALTER COLUMN pond_id DROP NOT NULL;
ALTER TABLE lab_results ADD COLUMN unit_id int REFERENCES units(id) ON DELETE CASCADE;
ALTER TABLE lab_results ADD CONSTRAINT lab_results_target_chk CHECK ((pond_id IS NULL) <> (unit_id IS NULL));
ALTER TABLE lab_results ADD COLUMN note text;
ALTER TABLE lab_results ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE lab_results DROP CONSTRAINT lab_results_client_id_key;
ALTER TABLE lab_results ALTER COLUMN client_id SET NOT NULL;
CREATE UNIQUE INDEX lab_results_client_uq ON lab_results (client_id, param);
CREATE INDEX lab_results_unit_idx ON lab_results (unit_id, sampled_at DESC);

-- ---------- Crop cycles ----------

ALTER TABLE crop_cycles ADD COLUMN client_id uuid UNIQUE;
ALTER TABLE crop_cycles ADD COLUMN created_by int REFERENCES users(id);
ALTER TABLE crop_cycles ADD COLUMN closed_by int REFERENCES users(id);
ALTER TABLE crop_cycles ADD COLUMN closed_client_id uuid UNIQUE;
-- At most one running cycle per pond.
CREATE UNIQUE INDEX crop_cycles_active_uq ON crop_cycles (pond_id) WHERE status = 'active';

-- ---------- Feeding and growth sampling ----------

ALTER TABLE feedings ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE feedings ADD COLUMN note text;
ALTER TABLE feedings ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE feedings ADD CONSTRAINT feedings_kg_chk CHECK (feed_kg >= 0);

ALTER TABLE growth_samples ADD COLUMN client_id uuid NOT NULL UNIQUE;
ALTER TABLE growth_samples ADD COLUMN sample_count int;
ALTER TABLE growth_samples ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE growth_samples ADD CONSTRAINT growth_abw_chk CHECK (abw_g > 0);
