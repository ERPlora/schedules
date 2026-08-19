-- Weekly hours of the hub: EVERY live row is one opening interval of its weekday (schedules#8),
-- ordered by day (0=Monday .. 6=Sunday) and position; a row with is_closed = 1 closes the day.
-- Runtime injects :hub_id.
SELECT id, day_of_week, position, open_time, close_time, is_closed, break_start, break_end
FROM schedules_business_hours
WHERE hub_id = :hub_id AND is_deleted = 0
