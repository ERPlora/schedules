-- Soft-deletes the opening intervals of a schedule override (schedules#23). Runs in the SAME
-- transaction as `override_delete.sql`, right before it — the twin of
-- `special_day_intervals_delete.sql`. Runtime injects :hub_id, :current_user_id, :now.
UPDATE schedules_exception_interval
SET is_deleted = 1,
    deleted_at = :now,
    updated_by = :current_user_id,
    updated_at = :now
WHERE hub_id = :hub_id AND exception_kind = 'override'
  AND exception_id = :override_id AND is_deleted = 0;
