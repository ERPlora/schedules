-- Weekly hours of the hub: EVERY live row is one opening interval of its weekday (schedules#8),
-- ordered by day (0=Monday .. 6=Sunday) and position; a row with is_closed = 1 closes the day.
-- Runtime injects :hub_id.
--
-- `created_by` travels with the row on purpose (schedules#36): installing the module seeds a
-- default week stamped by the installer (`system`, crates/runtime/src/seed.rs), while saving a day
-- through `schedules.business_hours.set` stamps the real user. That is how the screen tells a week
-- NOBODY has confirmed from one the business actually chose — no extra column, no extra query.
-- Additive and read-only: it is declared neither in `list.sort` nor in `list.filters`, because it
-- is neither sortable nor filterable, and every consumer reads by key.
SELECT id, day_of_week, position, open_time, close_time, is_closed, break_start, break_end, created_by
FROM schedules_business_hours
WHERE hub_id = :hub_id AND is_deleted = 0
