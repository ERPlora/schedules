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
4. **Nothing configured** — not open, with the code `no_hours` so the caller can tell it apart
   from a day that is deliberately closed.

The verdict says **which rule won**: `source` (`special_day` / `override` / `business_hours` /
`none`) and `rule_id`. Precedence, spelled out: **exact-date special day > yearly recurring special
day > override range > weekly intervals > nothing**.

A special day **beats an override**, and an override **beats the weekly hours**. That is the whole
design: a bank holiday must win over a summer timetable, which must win over "Tuesdays we open at
nine".

## A weekday has 0..N intervals, not one pair plus a break

A bar that opens `10–14` and `17–20` has **two intervals** on that day, not "one day with a break".
Each interval is a row; saving a day replaces all its rows. Intervals must not overlap. A closed
day is a single closed row; a day with no rows is *not set* — the engine answers `no_hours`, which
is «nobody configured this», not «closed today».

## An exception has 0..N intervals too

The same holds for a **special day** and for an **override**: a holiday that opens `10–13` and
`17–19` is ONE exception with two intervals, never two special days on the same date (that is
rejected anyway — one special day per date). The rules are the ones above: order does not matter,
intervals must not overlap (through midnight either), `close < open` runs past midnight and
`00:00–00:00` is open 24 hours. Marking the exception **closed** drops its intervals.

An exception written before this existed — and every day created by the bulk — carries no interval
of its own, only the `open_time`/`close_time` pair on its own row. That pair keeps deciding for it,
so nothing changed for the businesses that were already running.

One boundary worth knowing: an overnight interval on an exception (`22:00–02:00` on New Year's Eve)
is honoured **on the exception's own date, until midnight**. The small hours that follow belong to
the next date and are answered by that date's rules.

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

## "Nothing configured" has one answer, and it is the module's

The caller used to choose it (a `fail_open` flag), so the same hub at the same instant could be
open for one screen and closed for another. It does not any more: with no rule for that day the
business is **not** declared open, and the verdict carries the code `no_hours` — «nobody has set
the hours yet», which is not the same as «closed today» (`closed_today`). A booking screen can act
on that by offering to set the hours, instead of showing a shut door.

## The engine reads the hub's own rules, and the shop's own clock

The caller says **when**, and nothing else. The weekly hours, the special days, the overrides and
their intervals are pre-loaded by the runtime from this hub (`reads`), so no caller can invent a
schedule it does not have — and two callers cannot get different answers for the same instant.

And the moment is read on **the business's clock**: the hub's timezone (Hub settings, deduced from
the country when nobody set it) reaches the engine already resolved, and the conversion honours
daylight saving. At 23:30 UTC a shop in Madrid is already answering with **tomorrow's** hours. The
verdict says which timezone it used.

`when` follows one rule: with an offset (`2026-08-18T08:00:00Z`, `…+02:00`) it is an instant and
gets converted; without one (`2026-08-18T10:00`) it already is the shop's own wall clock.

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
individual row: they are all read in **the timezone of the hub**, which belongs to the core (Hub
settings) and reaches the engine already resolved. "We open at 09:00" means 09:00 in the shop,
whatever the clock of the server or of the device asking.

## Weekdays start at Monday

**0 = Monday, 6 = Sunday.** If your hours look shifted by one day, this is almost always why.

## Deleting is a soft delete

Special days and overrides are marked deleted, not erased, so history remains readable and an upsert
can revive a row instead of colliding with it.
