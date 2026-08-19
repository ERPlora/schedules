# Schedules — Screens

The module contributes three tabs to the hub navigation — **Hours**, **Special Days** and
**Settings** — served by one Web Component that reads the section from the route it is mounted on
(`/m/schedules/hours`, `/m/schedules/special_days`, `/m/schedules/settings`). The hub's tabbar is
the only navigation: deep links and Back/Forward land on the right section, and the screen paints
no tabs of its own. On phones and tablets (≤ 834 px) every list opens as cards so the status,
the effective hours and the actions of each row stay readable; deleting a special day or an
override asks for confirmation first.

## Hours — the weekly opening hours

The seven weekdays are always listed, each with its opening **intervals**
(`schedules.business_hours.list`, one row per interval). Requires `schedules.view_schedule`.

A day reads as `10:00–14:00 · 17:00–20:00` (split shift), `Open 24 hours`, `Closed` or `Not set`.

### Set the hours of a day

1. Use the row action **edit** on the day (there is no "add": the seven days already exist).
2. Either mark it **closed**, tick **Open 24 hours**, or fill one line per **interval** — opening
   and closing time as `HH:MM`. **+ Add interval** appends a line, the ✕ removes one. A closing time
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

### Create a special day

1. Give it a **date** and a **name** — both required.
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

1. Set the **start date** and the **end date**. The end cannot be before the start.
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
| Timezone | The timezone the hours are expressed in | `Europe/Madrid` |
| Week starts on | Which day the week begins | Monday |
| Slot duration | Minutes per slot | 30 |
| Auto close | Whether closing is automated | off |

Viewing needs `schedules.view_schedule`; saving needs `schedules.manage_settings`.

## Asking whether the business is open

The module exposes an `is_open` engine. Give it the moment (or let it use now) and it answers with a
verdict **and a reason** — which of the four layers decided.

Two things to know about how it is wired today:

- **You must pass it the rows.** The runtime does not pre-load them, so the caller reads the three
  lists first and sends them in.
- **Its answer does not currently reach the caller.** The engine computes the verdict, but the host
  returns only "ok" and how many operations ran; there is no channel yet for a read-only result.

Requires `schedules.view_schedule`.
