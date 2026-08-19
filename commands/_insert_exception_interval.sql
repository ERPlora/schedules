-- One opening interval of an EXCEPTION — special day or override (schedules#23). Intention of the
-- WASM handlers `create_special_day` / `create_override`, one operation per interval; the handler
-- supplies :id and :exception_id from `context.new_ids` (the parent row is inserted first, in this
-- same transaction) plus :position, :open_time, :close_time. Runtime injects :hub_id,
-- :current_user_id, :now.
--
-- INSERT … SELECT with a GUARD, like `staff._insert_working_hours`: the row is written only when
-- the parent exception exists in THIS hub and is alive. The guest cannot read the database, so
-- without this an operation carrying a foreign or invented `exception_id` would write an interval
-- that belongs to somebody else's exception; here it is simply a no-op.
--
-- `close_time < open_time` = crosses midnight; 00:00–00:00 = open 24 hours (same reading as
-- `schedules_business_hours`).
INSERT INTO schedules_exception_interval
  (id, hub_id, exception_kind, exception_id, position, open_time, close_time,
   is_deleted, created_by, created_at, updated_by, updated_at)
SELECT
  :id, :hub_id, :exception_kind, e.id, :position, :open_time, :close_time,
  0, :current_user_id, :now, :current_user_id, :now
FROM (
  SELECT id, hub_id, is_deleted, 'special_day' AS kind FROM schedules_special_day
  UNION ALL
  SELECT id, hub_id, is_deleted, 'override'    AS kind FROM schedules_override
) e
WHERE e.id = :exception_id AND e.hub_id = :hub_id AND e.is_deleted = 0 AND e.kind = :exception_kind;
