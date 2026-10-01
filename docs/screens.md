# Schedules — Screens

The module contributes three tabs to the hub navigation — **Hours**, **Special Days** and
**Settings** — served by one Web Component that reads the section from the route it is mounted on
(`/m/schedules/hours`, `/m/schedules/special_days`, `/m/schedules/settings`). The hub's tabbar is
the only navigation: deep links and Back/Forward land on the right section, and the screen paints
no tabs of its own. On phones and tablets (≤ 834 px) every list opens as cards so the status,
the effective hours and the actions of each row stay readable; deleting a special day or an
override asks for confirmation first.

When the hub refuses a save made from a panel (a day's hours, a special day, an override) — or an
open interval is missing one of its hours — the message appears **inside that form**, next to its
button, and the form scrolls to it once; on a phone the panel covers the whole screen, so a message
behind it would never be seen. What fails outside a panel (confirming the week, deleting an
exception, saving Settings, loading the week) is shown at the top of the page.

## Hours — the weekly opening hours

The seven weekdays are always listed, each with its opening **intervals**
(`schedules.business_hours.list`, one row per interval). Requires `schedules.view_schedule`.

A day reads as `10:00–14:00 · 17:00–20:00` (split shift), `Open 24 hours`, `Closed` or `Not set`.
Hours are shown in the clock of the hub's language — 24 h in Spanish (`17:00`), AM/PM in English
(`05:00 PM`) — here, in the edit panel and in the special days and temporary changes lists alike.

### Set the hours of a day

1. Use the row action **edit** on the day (there is no "add": the seven days already exist).
2. Either mark it **closed**, tick **Open 24 hours**, or fill one line per **interval** — opening
   and closing time, typed the way the screen shows it (`14:30`, `2:30 pm`) or as digits only
   (`1430`, handy on a phone keypad); leaving the field repaints it in the hub's clock. A time that is
   not complete yet is not saved. **+ Add interval** appends a line, the ✕ removes one. A closing time
   earlier than the opening one runs past midnight (`22:00–02:00`).
3. Save.

Saving a day **replaces** its intervals. Intervals must not overlap (also through midnight) and
they are stored sorted. The old "break" is now simply the gap between two intervals; rows created
before this change are split into two intervals automatically.

Requires `schedules.change_schedule`. Validation happens before anything is written — see
[limits.md](limits.md) for the codes.

## Special Days

Dated exceptions: holidays, closures, or a date with different hours
(`schedules.special_days.list`, 50 rows per page). Requires `schedules.view_schedule`. Sorted by
name.

- **Search** by name.
- **Filter** by date range, name, closed flag, times, recurring flag or notes.

The hours column of this list and of the temporary changes list folds every interval of each
exception (`schedules.exception_intervals.list`). If the hub cannot answer that read, both lists
say the hours could not be loaded, with **Retry** — they never show a split day as its first
interval alone.

### Create a special day

Open the form with **+ New special day** in that list's toolbar. Each of the two lists names its
own toolbar buttons ("View special days as list", "Filter overrides"…), so a screen reader tells
them apart.

1. Give it a **date** and a **name** — both required. Dates are shown and typed in the order of
   the hub's language, whatever the browser's: day first in Spanish (`24/12/2026`), month first in
   English (`12/24/2026`). Digits only (`24122026`, handy on a phone keypad) and an ISO date
   (`2026-12-24`) are read too; leaving the field repaints it. A date that is not complete or does
   not exist is not saved.
2. Mark it **closed** (the default), or fill one line per **interval** — the same editor as the
   weekly hours: **+ Add interval** appends a line, the ✕ removes one. A holiday that opens
   `10:00–13:00` and `17:00–19:00` is one special day with two intervals.
3. Tick **recurring yearly** if it falls on the same month and day every year — Christmas Day, for
   instance.
4. Optionally add notes.

Only **one special day per date** exists per hub; a second one for the same date is rejected.
Requires `schedules.add_schedule`.

### Create many special days at once

Bulk creation is **tolerant per item**: each is validated, duplicates are removed both within the
batch and against the dates you already have, and the failures come back as a list while the valid
ones are created. Requires `schedules.add_schedule`.

### Delete a special day

Destructive, requires `schedules.delete_schedule`.

## Overrides

A temporary change of hours over a **date range** — summer hours, a refurbishment
(`schedules.overrides.list`, 50 rows per page). Requires `schedules.view_schedule`.

- **Filter** by start date range, end date range, reason, times or closed flag.

### Create an override

Open the form with **+ New override** in that list's toolbar.

1. Set the **start date** and the **end date** — typed as on special days, in the order of the
   hub's language. The end cannot be before the start.
2. Either mark the period **closed**, or fill one line per **interval** that applies during it —
   same editor, same rules as the weekly hours (no overlaps, `close` before `open` runs past
   midnight, `00:00–00:00` is 24 hours).
3. Add the reason.

Requires `schedules.add_schedule`. Deleting one requires `schedules.delete_schedule`.

## Settings

The per-hub configuration, read with `schedules.settings.get` and saved with
`schedules.settings.save`.

| Setting | Meaning | Default |
|---|---|---|
| Week starts on | Which day the weekly table begins with — Monday or Sunday | Monday |

Above it, **read-only**, the screen shows the **business timezone**: the clock the whole schedule is
read with. It belongs to the hub — declared in its Settings or deduced from the country of the
business — so it is shown here and changed there, with a button that takes you to it. There is no
timezone of "the module": a second one would be a value nothing obeys.

Two settings were **removed** in schedules#9 because nothing read them: *slot duration* (the length
of an appointment belongs to the service, and Reservations has its own) and *auto close* (nothing
ever closed anything). A control with no effect is worse than a missing one.

Viewing needs `schedules.view_schedule`; saving needs `schedules.manage_settings`.

## Asking whether the business is open

The module exposes an `is_open` engine. Give it the moment (or let it use now) and it answers with a
verdict **and a reason** — which of the four layers decided.

Two things to know about how it is wired:

- **You only pass the moment.** The rules are read from this hub by the runtime, so a caller cannot
  send a schedule of its own — and everyone gets the same answer for the same instant.
- **It answers on the shop's clock.** The hub's timezone is applied before the rules are read, DST
  included, and the verdict names the timezone it used along with the local date and time.

Requires `schedules.view_schedule`.
