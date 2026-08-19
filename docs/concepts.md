# Schedules — Concepts

The things people get wrong on their first day.

## Three layers, and the most specific wins

"Are we open at this moment?" is answered by walking four steps in order:

1. **Special day for that exact date.** If none, a **yearly recurring** special day whose month and
   day match.
2. **Override** whose date range covers the day.
3. **Business hours** for that weekday — open if the moment falls in **any** of its intervals
   (a split shift is two intervals; `22:00–02:00` runs past midnight into the next day;
   `00:00–00:00` is open 24 hours).
4. **Nothing configured** — the answer falls back to the `fail_open` flag.

The verdict says **which rule won**: `source` (`special_day` / `override` / `business_hours` /
`none`) and `rule_id`. Precedence, spelled out: **exact-date special day > yearly recurring special
day > override range > weekly intervals > nothing**.

A special day **beats an override**, and an override **beats the weekly hours**. That is the whole
design: a bank holiday must win over a summer timetable, which must win over "Tuesdays we open at
nine".

## A weekday has 0..N intervals, not one pair plus a break

A bar that opens `10–14` and `17–20` has **two intervals** on that day, not "one day with a break".
Each interval is a row; saving a day replaces all its rows. Intervals must not overlap. A closed
day is a single closed row; a day with no rows is *not set* (the engine treats it as unknown, and
`fail_open` decides).

Special days and overrides still carry **one** open/close pair (or closed). A dated exception with
several intervals is a follow-up, not something to fake with two special days on the same date.

## A special day is a date; an override is a range

| | Special day | Override |
|---|---|---|
| Covers | One date | A start date to an end date |
| Can repeat yearly | **Yes** | No |
| One per date | **Yes** — enforced | No, ranges may exist freely |
| Typical use | Christmas, a bank holiday, an unusual Saturday | Summer hours, refurbishment, a strike week |

Do not model "closed for two weeks in August" as fourteen special days. That is what an override is
for.

## Recurring yearly matches month and day, not the date

A special day marked recurring matches **any year** with the same month and day. A one-off closure
must not be marked recurring, or it will come back forever.

## Closed is the default for a special day

Creating a special day without times means **closed**. If you want different hours instead of a
closure, you must give both the opening and the closing time — a half-specified day is rejected.

## `fail_open` is the caller's decision, not a setting

When nothing is configured for a day, the engine does not guess. The caller says what "no
information" means:

- **fail open** — assume open. Used by other modules asking about availability, so a missing
  configuration never blocks a booking.
- **fail closed** — assume closed. Used by dashboards, so an unconfigured hub does not claim to be
  open.

The same data therefore gives two different answers depending on who asks, and that is intentional.

## The engine needs its data handed to it

The `is_open` engine is a pure calculation: it does **not** read the database. The caller reads the
three lists and passes the rows in.

And today **its verdict does not come back to the caller**: the host returns only whether the call
succeeded and how many writes happened, and there is no channel yet for a read-only result. The
engine works; plumbing it back out is pending.

## Duplicate detection is checked against what you send

When creating special days, the "this date already exists" check is done against a list of existing
dates supplied in the request — not by querying. The unique index on date is the real backstop, so a
duplicate is still impossible; you simply get the low-level failure instead of the friendly one if
the list was not passed.

## Saving hours or settings replaces, it does not accumulate

Both the weekly hours and the settings are upserts. Saving Tuesday again replaces Tuesday, and a
previously deleted row is revived rather than duplicated. There is exactly **one row per weekday**
and **one settings row per hub**.

## Times and dates are plain text

Times are `HH:MM` and dates are `YYYY-MM-DD`, stored as text. There is no timezone attached to an
individual row — the hub's timezone in the settings is the context for all of them.

## Weekdays start at Monday

**0 = Monday, 6 = Sunday.** If your hours look shifted by one day, this is almost always why.

## Deleting is a soft delete

Special days and overrides are marked deleted, not erased, so history remains readable and an upsert
can revive a row instead of colliding with it.
