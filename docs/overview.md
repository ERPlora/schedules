# Schedules — Overview

## What this module does

Schedules answers one question for the whole hub: **are we open?** It holds the regular weekly
opening hours, the **special days** (a bank holiday, Christmas Eve with different hours), and the
**overrides** — a date range where the normal hours are replaced, like a summer timetable.

It also carries an engine that resolves all three into a yes or no for a given moment.

## These are the business's hours, not anyone's shift

This is the distinction to get right immediately.

- **Schedules** = when the **business** is open to the public.
- **Staff schedules** (in the `staff` module) = when a **person** works.
- **Appointment schedules** (in `appointments`) = when slots can be **booked**.

Three different calendars for three different questions. This module knows nothing about employees.

## What this module does NOT do

- **It does not manage employee shifts, rotas or time off.** That is `staff`.
- **It does not offer bookable slots.** That is `appointments`.
- **It does not close the till by itself.** There is a setting for automatic closing, but nothing in
  this module acts on it. <!-- TODO: verify -->
- **It does not know about holidays in your country.** Special days are entered by you; nothing is
  seeded.

## Modules it connects to

**Depends on nothing**, and nothing depends on it. Its events are on the bus for anybody who wants
them; no module declares a listener today.

**Events it emits**

| Event | When |
|---|---|
| `schedules.business_hours.updated` | the weekly hours change |
| `schedules.special_day.created` / `.deleted` | a special day is added or removed |
| `schedules.override.created` / `.deleted` | an override is added or removed |
| `schedules.settings.saved` | the settings are saved |

**Events it listens to** — none.

## How "are we open" is resolved

Precedence, highest first:

1. **Special day** for that exact date — and if none, a **yearly recurring** special day matching the
   month and day.
2. **Override** whose range covers that date.
3. **Business hours** for that weekday — any of its intervals (split shifts, overnight, 24 h).
4. **Nothing configured** — the answer depends on the `fail_open` flag the caller passes.

A special day beats everything. That is the point of it.

## Where its numbers come from

- **Times are text, `HH:MM`.** Dates are text, `YYYY-MM-DD`.
- **Days of the week are 0 = Monday … 6 = Sunday.**
- **Default timezone** is `Europe/Madrid`, the week starts on Monday, and the default slot duration
  is 30 minutes.
