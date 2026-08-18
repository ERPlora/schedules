-- All live special-day dates of the hub. Authoritative read (ADR-0069) pre-loaded by the runtime
-- for the WASM handler `bulk_create_special_days` (`reads` in module.json, schedules#2): the batch
-- dedupes against it instead of the client hint `existing_dates`. Runtime injects :hub_id.
SELECT date
FROM schedules_special_day
WHERE hub_id = :hub_id AND is_deleted = 0
