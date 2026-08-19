-- Soft-deletes every live interval of a weekday (schedules#8). Emitted by the WASM handler
-- `set_business_hours` right before it re-inserts the day's intervals: saving a day REPLACES its
-- intervals, it does not accumulate them. Runtime injects :hub_id, :current_user_id, :now.
UPDATE schedules_business_hours
SET is_deleted = 1, deleted_at = :now, updated_by = :current_user_id, updated_at = :now
WHERE hub_id = :hub_id AND day_of_week = :day_of_week AND is_deleted = 0;
