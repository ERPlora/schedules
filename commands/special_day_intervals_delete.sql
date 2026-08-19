-- Soft-deletes the opening intervals of a special day (schedules#23). Runs in the SAME
-- transaction as `special_day_delete.sql`, right before it: deleting the exception must take its
-- intervals with it, otherwise a date reused later would inherit the hours of the deleted day.
-- Runtime injects :hub_id, :current_user_id, :now.
UPDATE schedules_exception_interval
SET is_deleted = 1,
    deleted_at = :now,
    updated_by = :current_user_id,
    updated_at = :now
WHERE hub_id = :hub_id AND exception_kind = 'special_day'
  AND exception_id = :special_day_id AND is_deleted = 0;
