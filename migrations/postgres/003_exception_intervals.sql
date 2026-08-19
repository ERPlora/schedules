-- schedules#23 — 0..N opening intervals for the EXCEPTIONS (special days and overrides).
--
-- Migration 002 gave several intervals to the WEEKLY hours, but the exceptions kept a single
-- `open_time`/`close_time` pair: a holiday with a split shift (10–13 and 17–19) or a summer
-- override with a siesta could not be expressed, and the only way out was «open» with one wide
-- interval — which reads as OPEN during the hours the business is shut.
--
-- The weekly table solved it with N rows per day because a weekday is not an entity of its own.
-- An exception IS one: `schedules_special_day` is unique per `(hub_id, date)` (the bulk relies on
-- that index for its `ON CONFLICT … DO NOTHING`) and an override is one dated range that the
-- overlap check treats as a single object. So the intervals go to a CHILD table instead, and the
-- parent rows stay exactly as they were.
--
-- Append-only and idempotent: the table is created, and every live OPEN exception that carries a
-- pair is copied into its interval 0 (id = `<parent id>:0`), so nothing changes for the business
-- on the day of the update. The pair stays on the parent as the legacy fallback — a reader that
-- finds no interval rows for an exception still honours it, which is also how the days created by
-- `schedules.bulk_create_special_days` (one pair, no intervals) keep working.
CREATE TABLE IF NOT EXISTS schedules_exception_interval (
    id             TEXT PRIMARY KEY,
    hub_id         TEXT NOT NULL,
    exception_kind TEXT NOT NULL,             -- 'special_day' | 'override'
    exception_id   TEXT NOT NULL,             -- schedules_special_day.id / schedules_override.id
    position       INTEGER NOT NULL DEFAULT 0,
    open_time      TEXT NOT NULL,             -- 'HH:MM'
    close_time     TEXT NOT NULL,             -- 'HH:MM' (< open_time = crosses midnight; 00:00–00:00 = 24 h)
    is_deleted     INTEGER NOT NULL DEFAULT 0,
    deleted_at     TEXT,
    created_by     TEXT,
    created_at     TEXT NOT NULL,
    updated_by     TEXT,
    updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_exception_interval_owner
  ON schedules_exception_interval (hub_id, exception_kind, exception_id, is_deleted, position);
CREATE INDEX IF NOT EXISTS idx_schedules_exception_interval_hub
  ON schedules_exception_interval (hub_id, is_deleted);

-- Backfill: the pair of every live OPEN special day becomes its interval 0.
INSERT INTO schedules_exception_interval
  (id, hub_id, exception_kind, exception_id, position, open_time, close_time,
   is_deleted, created_by, created_at, updated_by, updated_at)
SELECT id || ':0', hub_id, 'special_day', id, 0, open_time, close_time,
       0, created_by, created_at, updated_by, updated_at
FROM schedules_special_day
WHERE is_deleted = 0 AND is_closed = 0
  AND open_time IS NOT NULL AND close_time IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM schedules_exception_interval x WHERE x.id = schedules_special_day.id || ':0');

-- Same for the overrides.
INSERT INTO schedules_exception_interval
  (id, hub_id, exception_kind, exception_id, position, open_time, close_time,
   is_deleted, created_by, created_at, updated_by, updated_at)
SELECT id || ':0', hub_id, 'override', id, 0, open_time, close_time,
       0, created_by, created_at, updated_by, updated_at
FROM schedules_override
WHERE is_deleted = 0 AND is_closed = 0
  AND open_time IS NOT NULL AND close_time IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM schedules_exception_interval x WHERE x.id = schedules_override.id || ':0');
