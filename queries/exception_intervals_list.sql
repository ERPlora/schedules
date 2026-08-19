-- Opening intervals of the EXCEPTIONS of the hub (schedules#23): every live row is one interval of
-- a special day or of an override, ordered by `position` inside its exception. Several rows for the
-- same `exception_id` = split shift; `close_time < open_time` = crosses midnight; 00:00–00:00 = 24 h.
-- An exception with NO row here still has its legacy `open_time`/`close_time` pair on its own row
-- (rows written before migration 003 and the days created by the bulk). Runtime injects :hub_id.
SELECT id, exception_kind, exception_id, position, open_time, close_time
FROM schedules_exception_interval
WHERE hub_id = :hub_id AND is_deleted = 0
