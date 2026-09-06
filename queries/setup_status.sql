-- Setup check of the module (schedules#42). Read by `hub.setup.status`, slot 101 of the onboarding
-- checklist — contract in `architecture/hub/setup-status.md` §6. The runtime injects :hub_id.
--
-- THE QUESTION IS «HAS A PERSON CONFIRMED THIS?», NOT «ARE THERE ROWS?». Every other module can ask
-- the second one because a fresh hub owns nothing; this one cannot. Since schedules#36 installing
-- the module SEEDS a default week (Mon–Fri 09:00–18:00, weekend closed) so that `no_hours` stops
-- being reachable and the booking door of `appointments` can refuse at all. A row count would
-- therefore be ticked the moment the module lands and would never ask the business anything —
-- which is exactly the salon that opens at 10:00 taking 09:00 Monday bookings it never agreed to.
--
-- WHAT TELLS THE TWO APART IS THE AUTHOR. `apply_module_seed` binds `:current_user_id` = 'system'
-- (crates/runtime/src/seed.rs, `SEEDED_BY`), so the seeded week carries `created_by` = 'system';
-- `schedules.business_hours.set` clears the day and re-inserts it stamped with the real user
-- (`commands/_insert_business_hours.sql`), so anything a person saved carries their id. This is the
-- SAME line the Hours screen already draws for its «these are default hours» banner
-- (`erp-schedules-hours.ts`, `SEED_AUTHOR`), on purpose: screen and checklist must not drift.
--
-- SOFT-DELETED ROWS ARE GONE. The checklist reports the hub as it is now, not a milestone it once
-- passed — a hub that wiped the hours it had written has the work to do again.
--
-- A CLOSED DAY COUNTS. `is_closed` is not filtered: «we do not open on Mondays» is the business
-- deciding, and demanding an open interval would leave a salon that closes midweek unable to
-- finish a step it has, in fact, finished.
--
-- COUNT() with no GROUP BY answers exactly ONE row, `0` included. `hub.setup.status` reads the
-- first row and omits an item whose check could not run, so answering `0` rather than answering
-- nothing is what keeps «nobody has confirmed yet» distinguishable from «the check failed».
SELECT COUNT(*) AS confirmed_hours
FROM schedules_business_hours
WHERE hub_id = :hub_id AND is_deleted = 0 AND created_by <> 'system'
