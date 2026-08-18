-- Live overrides whose date range intersects [:start_date, :end_date]. Authoritative read
-- (ADR-0069) pre-loaded by the runtime for the WASM handler `create_override` (schedules#2):
-- two live overrides must not cover the same date, otherwise `is_open` would pick one by list
-- order. Dates are TEXT 'YYYY-MM-DD' (lexicographic order is chronological). Runtime injects :hub_id.
SELECT id, start_date, end_date, reason
FROM schedules_override
WHERE hub_id = :hub_id AND is_deleted = 0
  AND start_date <= :end_date AND :start_date <= end_date
