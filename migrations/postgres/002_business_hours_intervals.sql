-- schedules#8 — several opening intervals per weekday (split shifts, overnight, 24 h).
--
-- Until now `schedules_business_hours` held ONE row per (hub_id, day_of_week) — one open/close
-- pair plus one optional break — enforced by `uq_schedules_business_hours_hub_day`. A bar that
-- opens 10–14 and 17–20 could only say it as «a break in the middle», and a third interval was
-- impossible to represent. From here on EVERY live row of a weekday is one interval, ordered by
-- `position`; a day with a single row `is_closed = 1` is closed. The break columns stay for
-- rows written before this migration (the engine still honours them) but new writes leave them
-- NULL: a break is simply the gap between two intervals.
--
-- Append-only: the old index is dropped, `position` is added, and the rows that carried a break
-- are SPLIT in place into two intervals so nothing changes for the business on the day of the
-- update. Idempotent (IF EXISTS / IF NOT EXISTS / guarded UPDATE).
ALTER TABLE schedules_business_hours ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS uq_schedules_business_hours_hub_day;
CREATE INDEX IF NOT EXISTS idx_schedules_business_hours_hub_day
  ON schedules_business_hours (hub_id, day_of_week, is_deleted, position);

-- Split legacy rows with a break into two intervals: [open, break_start] + [break_end, close].
INSERT INTO schedules_business_hours
  (id, hub_id, day_of_week, position, open_time, close_time, is_closed, break_start, break_end,
   is_deleted, created_by, created_at, updated_by, updated_at)
SELECT id || ':pm', hub_id, day_of_week, 1, break_end, close_time, 0, NULL, NULL,
       0, created_by, created_at, updated_by, updated_at
FROM schedules_business_hours
WHERE is_deleted = 0 AND is_closed = 0
  AND break_start IS NOT NULL AND break_end IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM schedules_business_hours x WHERE x.id = schedules_business_hours.id || ':pm');

UPDATE schedules_business_hours
SET close_time = break_start, break_start = NULL, break_end = NULL, position = 0
WHERE is_deleted = 0 AND is_closed = 0
  AND break_start IS NOT NULL AND break_end IS NOT NULL
  AND EXISTS (SELECT 1 FROM schedules_business_hours x WHERE x.id = schedules_business_hours.id || ':pm');
