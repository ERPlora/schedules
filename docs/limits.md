# Schedules — Limits and troubleshooting

## Known limitations you should know about

- **The `is_open` verdict does not reach the caller.** The engine computes it, but the host returns
  only success and an operation count; there is no result channel for a read-only handler yet.
- **The engine does not read the database.** The caller must pass in the special days, overrides and
  business hours.
- **Point-in-time checks and slot generation are not implemented.** There is no command to ask "will
  we be open at 18:30 next Thursday" or to generate a list of open slots.
- **No holiday calendar is seeded.** Every special day is entered by you.
- **Nothing acts on the auto-close setting.** It is stored, not enforced.
- **An overnight interval of an exception stops at midnight.** `22:00–02:00` on a special day is
  honoured on that date until 24:00; the small hours of the following day are answered by the
  following day's rules. The weekly hours DO reach into the next morning.

## Errors you will actually see

Validation happens **before** anything is written, and the error comes back as a code with detail.

| Error | What happened | What to do |
|---|---|---|
| `invalid_hours` | The closing time is not after the opening time | Fix the times |
| `invalid_break` | (legacy payload) The break is not inside the opening interval | Send `intervals[]` instead: a break is the gap between two intervals |
| `overlapping` | Two intervals of the same day — or of the same special day / override — overlap (also through midnight), or two live overrides cover the same date | Fix the interval bounds / the override range |
| `missing_hours` | An open day, special day or override was sent without hours | Send at least one complete interval or mark it closed |
| `invalid_day` | The weekday is not 0–6 | Use 0 = Monday … 6 = Sunday |
| `missing_hours` | Marked open but without opening and closing times | Give both, or mark it closed |
| `missing_name` | A special day with no name | Name it |
| `invalid_date` | The date is malformed | Use `YYYY-MM-DD` |
| `already_exists` | A special day already exists for that date | Edit the existing one |
| `invalid_range` | The override's end date is before its start date | Fix the range |

## Accepted values and formats

| Field | Format |
|---|---|
| Time | `HH:MM` text |
| Date | `YYYY-MM-DD` text |
| Day of week | 0 = Monday … 6 = Sunday |
| Special day per date | one per hub |
| Business hours rows per weekday | one per interval (max 12) |
| Intervals per exception | 0..12 (a closed exception has none) |
| Settings row | one per hub |

## Caps and sizes

| Limit | Value |
|---|---|
| Rows per page (hours, special days, overrides) | 50 |
| Maximum rows a paginated request may ask for | 500 |

Bulk creation of special days is tolerant per item: invalid ones are collected as errors and the
valid ones are still created, with duplicates removed both inside the batch and against the dates you
already have.

## Permissions per action

| To do this | You need |
|---|---|
| See hours, special days, overrides and settings; ask whether the business is open | `schedules.view_schedule` |
| Create a special day or an override, bulk-create special days | `schedules.add_schedule` |
| Set the weekly hours | `schedules.change_schedule` |
| Delete a special day or an override | `schedules.delete_schedule` |
| Save the settings | `schedules.manage_settings` |

By role: **admin** and **manager** have all five. **employee** has **view only** — an employee cannot
change the opening hours, add a holiday or delete anything.

## Dependencies

**None in either direction.** Schedules depends on no module, and no module declares it as a
dependency. It can be installed and removed freely.

Its events are published on the bus for anybody who wants to react, but nothing listens to them
today.

Note the practical consequence: **other modules do not automatically respect your opening hours.**
The appointment diary has its own schedules; the till does not refuse to sell outside opening hours.
This module is the source of truth for the question, not an enforcement layer.

## When something looks wrong

**"It says we are closed and we are open."** Walk the precedence: is there a **special day** for
today, or a **recurring** one matching this month and day? Then an **override** covering today? Only
then do the weekly hours apply. The engine tells you which layer decided — read the reason.

**"The hours are shifted by one day."** Weekdays are **0 = Monday**, not 0 = Sunday.

**"A one-off closure keeps coming back every year."** It was marked **recurring yearly**. Delete it
and re-create it without the flag.

**"I cannot create a second special day for the same date."** By design — one per date. Edit the
existing one instead.

**"I set a special day with hours and it saved as closed."** A special day is closed by default and
needs **both** an opening and a closing time to be considered open.

**"Two weeks of holiday needed fourteen entries."** Use an **override** with a date range instead.

**"The break is being rejected."** It must fall inside the opening interval and needs both a start
and an end.

**"The bulk import said it created fewer than I sent."** Invalid items and duplicate dates are
skipped, and the failures come back listed. Read the errors.

**"Nothing closed automatically at closing time."** The auto-close setting is stored but nothing acts
on it.
