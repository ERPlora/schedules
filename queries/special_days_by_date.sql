-- Live special day(s) of the hub on :date. Authoritative read (ADR-0069) pre-loaded by the
-- runtime for the WASM handler `create_special_day` (`reads` in module.json, schedules#7):
-- the duplicate check no longer trusts the client hint `existing_dates`. The unique index
-- uq_schedules_special_day_hub_date stays as the hard backstop. Runtime injects :hub_id.
SELECT id, date, name
FROM schedules_special_day
WHERE hub_id = :hub_id AND is_deleted = 0 AND date = :date
