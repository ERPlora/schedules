# Schedules — Screens

The module contributes three tabs to the hub navigation — **Hours**, **Special Days** and
**Settings** — and all three are served by the same screen, which resolves the tab internally.

## Hours — the weekly opening hours

One row per weekday (`schedules.business_hours.list`, 50 rows per page). Requires
`schedules.view_schedule`.

- **Sort and filter** by weekday, opening time, closing time, closed flag, or the break times.

### Set the hours of a day

1. Pick the **day of the week** (0 = Monday … 6 = Sunday).
2. Either mark it **closed**, or set the **opening** and **closing** times as `HH:MM`.
3. Optionally set a **break** — both a start and an end.
4. Save.

Saving a day that already exists **replaces** it; there is one row per weekday and no duplicates are
possible. The row action "edit" preloads the form with the current values.

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
2. Mark it **closed** (the default), or set opening and closing times for that day.
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
2. Either mark the period **closed**, or set the opening and closing times that apply during it.
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
