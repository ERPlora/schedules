-- Canonical seed of the `schedules` module (ADR-0147, schedules#36): the DEFAULT OPENING WEEK a
-- hub has the moment the module is installed. Per-hub idempotent DML, applied by the installer
-- after migrating with :hub_id/:now/:current_user_id injected (crates/runtime/src/seed.rs).
--
-- WHY A HUB IS NEVER LEFT WITHOUT HOURS. ADR-0392 decision 4 keeps `no_hours` as a verdict of its
-- own: with no rule for the day the business is NOT declared open, and the consumer may offer
-- «set your opening hours» rather than paint a closed door. That is still true — what changes
-- here is that the state stops being REACHABLE. `appointments` (its booking door, #102/#105) has
-- to permit everything while the hub has not one weekly row, because refusing there would turn
-- «I have not set my hours yet» into «I cannot take bookings» — an outage, not a guard. A door
-- that cannot refuse is not a door, so the hours have to exist from minute one.
--
-- ⚠️ ALL SEVEN DAYS, weekend included. `no_hours` is answered PER DAY, not per hub: seeding only
-- Monday–Friday would leave Saturday and Sunday still answering «nothing configured», and the
-- consumer's fallback would stay alive for two days a week. The weekend is seeded as explicit
-- CLOSED rows, which read as `closed_today`.
--
-- THE WEEK ITSELF IS THE MARKET'S, NOT OURS (skill `market-decision`, 10 references in the issue).
-- Every product that ships a default calendar ships the same shape — Monday–Friday working,
-- weekend non-working, one continuous daytime window: Odoo's «Standard 40 hours/week», Google
-- Calendar's pre-checked Mon–Fri 9–17, Microsoft Bookings' 8–17, Business Central's base calendar
-- («a base calendar would typically list all Saturdays as non-working days»). The close time is
-- the hospitality end of that range: Lightspeed Reservations defaults to 09:00–19:00, and the
-- cost of a default is asymmetric — too NARROW refuses bookings the business could have served,
-- too wide only shows an hour it will correct. 09:00–18:00 sits between the office default and
-- the hospitality one. No lunch break: only Odoo splits its default, and a siesta the business
-- does not take is an invented refusal in the middle of the day (a break is simply the gap
-- between two intervals since schedules#8, so the owner adds one by splitting the row).
--
-- IT IS A STARTING POINT, NOT A CONSTANT OF OURS. The hours are a fact about the business, so the
-- Hours screen flags the week as unconfirmed until somebody saves it (`created_by` = 'system' is
-- what the installer stamps, and what tells the two apart).
--
-- 🔴 THE GUARD IS THE WHOLE TABLE, ON PURPOSE. `WHERE NOT EXISTS (… WHERE hub_id = :hub_id)` and
-- nothing else: the seed runs again on EVERY update of the module (`register_manifest` re-applies
-- it), so a per-day guard would keep planting the days a live hub had deliberately left alone —
-- a salon that only ever set Monday would wake up with six days it never wrote. It does not
-- filter `is_deleted` either: rows are soft-deleted here, so a hub that cleared its week has
-- still TOUCHED its hours and the seed must not put one back. One statement, not seven, because
-- the guard sees the rows the previous statement wrote: seven guarded INSERTs would plant Monday
-- and skip the rest. The runtime reads this guard as «this table, in this hub», declares NO
-- natural key from it (`parse_seed_guard` returns none when the only column is `hub_id`) and that
-- is correct — the week is one object, not seven independent reference rows.
INSERT INTO schedules_business_hours
  (id, hub_id, day_of_week, position, open_time, close_time, is_closed, break_start, break_end,
   is_deleted, created_by, created_at, updated_by, updated_at)
SELECT (:hub_id || '|schedhours|' || d.day_of_week), :hub_id, d.day_of_week, 0,
       d.open_time, d.close_time, d.is_closed, NULL, NULL,
       0, :current_user_id, :now, :current_user_id, :now
FROM (VALUES
    (0, '09:00', '18:00', 0),   -- Monday
    (1, '09:00', '18:00', 0),   -- Tuesday
    (2, '09:00', '18:00', 0),   -- Wednesday
    (3, '09:00', '18:00', 0),   -- Thursday
    (4, '09:00', '18:00', 0),   -- Friday
    (5, '00:00', '00:00', 1),   -- Saturday — closed
    (6, '00:00', '00:00', 1)    -- Sunday — closed
  ) AS d(day_of_week, open_time, close_time, is_closed)
WHERE NOT EXISTS (SELECT 1 FROM schedules_business_hours WHERE hub_id = :hub_id);
