-- One opening interval of a weekday (schedules#8), or the single `is_closed = 1` row of a closed
-- day. Emitted by the WASM handler `set_business_hours` after `_clear_business_hours_day`; the
-- handler supplies :id (from context.new_ids) and :position. Runtime injects :hub_id,
-- :current_user_id, :now. `close_time < open_time` = crosses midnight; 00:00–00:00 = 24 hours.
INSERT INTO schedules_business_hours
  (id, hub_id, day_of_week, position, open_time, close_time, is_closed, break_start, break_end,
   is_deleted, created_by, created_at, updated_by, updated_at)
VALUES
  (:id, :hub_id, :day_of_week, :position, :open_time, :close_time, :is_closed, :break_start, :break_end,
   0, :current_user_id, :now, :current_user_id, :now);
