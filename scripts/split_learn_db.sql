-- ============================================================================
-- Drill/Learn split migration — RUN ONLY during the cutover window.
--
-- Preconditions (do these first, in order):
--   1. Provision the Learn Postgres database.
--   2. Set DIVIDE_LEARN_DB_URL and run:
--        DIVIDE_DB_URL=... DIVIDE_LEARN_DB_URL=... python tools/export_learn_db.py
--      Verify row counts match (28 Learn tables).
--   3. Point the Learn service at the new DB and smoke-test login.
--   4. THEN run this file against the DRILL database only.
--
-- What it does:
--   * Adds drills.scenario_id / drill_scenarios.scenario_id (idempotent).
--   * Drops the FK constraints drills->labs and drill_scenarios->labs
--     (actual constraint names are resolved dynamically; the model no
--     longer declares them).
--   * Leaves lab_id columns as plain-integer read-only refs (NOT dropped)
--     so historical drills keep their Learn-catalog pointer.
--
-- Rollback: re-adding the FKs requires validating every lab_id exists in
-- the Learn DB — treat this as one-way. Restore from backup to undo.
-- ============================================================================
BEGIN;

-- 1. New Drill-catalog columns (idempotent).
ALTER TABLE drills ADD COLUMN IF NOT EXISTS scenario_id INTEGER;
ALTER TABLE drill_scenarios ADD COLUMN IF NOT EXISTS scenario_id INTEGER;
ALTER TABLE drill_scenarios ALTER COLUMN lab_id DROP NOT NULL;

-- 2. Drop FK constraints to labs (dynamic names — DO NOT hardcode).
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT conname, conrelid::regclass::text AS tbl
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid::regclass::text IN ('drills', 'drill_scenarios')
          AND confrelid::regclass::text = 'labs'
    LOOP
        RAISE NOTICE 'dropping FK % on %', r.conname, r.tbl;
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    END LOOP;
END $$;

-- 3. Drop the old uniqueness on (drill_id, lab_id) if present; the model
--    now uses a plain index on drill_id.
ALTER TABLE drill_scenarios DROP CONSTRAINT IF EXISTS uq_drill_scenarios;
CREATE INDEX IF NOT EXISTS idx_drill_scenarios_drill ON drill_scenarios (drill_id);
CREATE INDEX IF NOT EXISTS idx_drills_scenario ON drills (scenario_id);

-- 4. Verify: these queries must return zero rows after the migration.
-- SELECT conname FROM pg_constraint
--  WHERE contype='f' AND conrelid::regclass::text IN ('drills','drill_scenarios')
--    AND confrelid::regclass::text = 'labs';


-- 5. Drill-native flags (new table; Drill no longer reads Learn lab_flags
--    for submit). Idempotent.
CREATE TABLE IF NOT EXISTS drill_flags (
    id SERIAL PRIMARY KEY,
    drill_id INTEGER NOT NULL REFERENCES drills(id) ON DELETE CASCADE,
    objective_id INTEGER REFERENCES drill_objectives(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL DEFAULT 'flag',
    value VARCHAR(255) NOT NULL,
    points INTEGER NOT NULL DEFAULT 100,
    decay_window_seconds INTEGER NOT NULL DEFAULT 1800,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drill_flags_drill ON drill_flags (drill_id);

-- 6. Drop drill_objectives->lab_objectives FK (dynamic name; the column
--    stays as a read-only Learn ref).
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT conname
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'drill_objectives'::regclass
          AND confrelid = 'lab_objectives'::regclass
    LOOP
        RAISE NOTICE 'dropping FK % on drill_objectives', r.conname;
        EXECUTE format('ALTER TABLE drill_objectives DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

COMMIT;
