-- ============================================================================
-- Drill: purge Learn, go Drill-native. RUN against the DRILL database.
-- Backup first: pg_dump -U divide divide > drill_backup.sql
--
-- Live-data inventory (verified 2026-09-08): 8 users, 33 drills (drill 1
-- links lab 1), 3 submissions + 3 flag_submissions + 2 first_bloods on
-- drill 1 / lab_flags 1-2, 1 score, 2 participants. Teams empty.
-- This migration preserves ALL of it:
--   * lab_flags 1-2 are COPIED into drill_flags (ids preserved), then
--     flag_submissions/first_bloods re-pointed at drill_flags.
--   * users rows stay (token-sub identity); Learn-only profile/badge/
--     session tables are dropped (empty in practice).
--   * lab_id columns become plain-integer history refs (values kept).
-- Rollback: restore from backup. One-way by design.
-- ============================================================================
BEGIN;

-- 0. Drill catalog column (idempotent).
ALTER TABLE drills ADD COLUMN IF NOT EXISTS scenario_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_drills_scenario ON drills (scenario_id);

-- 1. Drill-native flags table + migrate live lab_flags rows into it.
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

DO $$
DECLARE
    r RECORD;
    target_drill INTEGER;
    new_id INTEGER;
BEGIN
    FOR r IN SELECT * FROM lab_flags ORDER BY id LOOP
        SELECT d.id INTO target_drill
        FROM drills d WHERE d.lab_id = r.lab_id ORDER BY d.id LIMIT 1;
        IF target_drill IS NULL THEN
            RAISE NOTICE 'lab_flag % (lab %) has no drill - skipping', r.id, r.lab_id;
            CONTINUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM drill_flags WHERE id = r.id) THEN
            INSERT INTO drill_flags (id, drill_id, name, value, points,
                decay_window_seconds, sort_order, created_at)
            VALUES (r.id, target_drill, r.name, r.value, r.points,
                r.decay_window_seconds, r.sort_order, r.created_at);
        ELSE
            INSERT INTO drill_flags (drill_id, name, value, points,
                decay_window_seconds, sort_order, created_at)
            VALUES (target_drill, r.name, r.value, r.points,
                r.decay_window_seconds, r.sort_order, r.created_at)
            RETURNING id INTO new_id;
            UPDATE flag_submissions SET lab_flag_id = new_id WHERE lab_flag_id = r.id;
            UPDATE first_bloods SET lab_flag_id = new_id WHERE lab_flag_id = r.id;
            RAISE NOTICE 'lab_flag % remapped to drill_flag %', r.id, new_id;
        END IF;
    END LOOP;
    PERFORM setval('drill_flags_id_seq',
        (SELECT COALESCE(MAX(id), 0) + 1 FROM drill_flags), false);
END $$;

-- Re-point child FKs from lab_flags to drill_flags (dynamic names).
ALTER TABLE flag_submissions DROP CONSTRAINT IF EXISTS fk_flag_submissions_lab_flag_id_lab_flags;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND conrelid = 'flag_submissions'::regclass
          AND confrelid = 'lab_flags'::regclass LOOP
        EXECUTE format('ALTER TABLE flag_submissions DROP CONSTRAINT %I', r.conname);
    END LOOP;
    FOR r IN SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND conrelid = 'first_bloods'::regclass
          AND confrelid = 'lab_flags'::regclass LOOP
        EXECUTE format('ALTER TABLE first_bloods DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;
ALTER TABLE flag_submissions
    ADD CONSTRAINT flag_submissions_drill_flag_fkey
    FOREIGN KEY (lab_flag_id) REFERENCES drill_flags(id) ON DELETE CASCADE;
ALTER TABLE first_bloods
    ADD CONSTRAINT first_bloods_drill_flag_fkey
    FOREIGN KEY (lab_flag_id) REFERENCES drill_flags(id) ON DELETE CASCADE;

-- 2. Drop every FK pointing INTO a Learn table (dynamic, idempotent).
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT c.conname, c.conrelid::regclass::text AS tbl
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid::regclass::text IN (
            'labs', 'lab_objectives', 'lab_flags', 'lab_hints', 'lab_files',
            'lab_categories', 'tags', 'lab_tags', 'target_machines',
            'teams', 'team_memberships', 'team_invitations', 'team_statistics',
            'learning_paths', 'learning_path_modules', 'learning_path_labs',
            'user_learning_progress', 'lab_skills', 'user_profiles',
            'sessions', 'password_reset_tokens', 'user_activity_logs',
            'badges', 'user_badges', 'system_notifications',
            'user_notifications', 'platform_settings', 'lab_environment_logs')
    LOOP
        IF r.tbl IN ('flag_submissions', 'first_bloods')
           AND r.conname LIKE '%drill_flag%' THEN
            CONTINUE;
        END IF;
        RAISE NOTICE 'dropping FK % on %', r.conname, r.tbl;
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    END LOOP;
END $$;

ALTER TABLE drill_scenarios ALTER COLUMN lab_id DROP NOT NULL;

-- 3. Drop Learn tables (Drill keeps drills*, submissions*, scores*,
--    reports*, benchmarks, audit_logs, security_events, users).
DROP TABLE IF EXISTS
    learning_path_labs, learning_path_modules, learning_paths,
    user_learning_progress, lab_skills,
    lab_tags, target_machines, lab_hints, lab_files, lab_objectives, lab_flags, labs,
    lab_categories, tags,
    team_statistics, team_invitations, team_memberships, drill_teams, teams,
    user_badges, badges,
    user_profiles, sessions, password_reset_tokens, user_activity_logs,
    system_notifications, user_notifications, platform_settings,
    lab_environment_logs
    CASCADE;

-- 4. Verify after COMMIT: drill_flags has 2 rows; users 8; drills 33;
--    no labs/lab_flags/teams/learning_paths tables remain.
COMMIT;
