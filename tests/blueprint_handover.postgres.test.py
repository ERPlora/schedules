#!/usr/bin/env python3
"""schedules#36 — the seeded week is a PLACEHOLDER, and it has to lose against real hours.

Why this file exists. Seeding a default week at install time (`seed/install.postgres.sql`) broke an
invariant every other writer of opening hours was built on: **the table starts empty**. A starter
catalog / blueprint carries the hours of a REAL business — the `es/beauty` one opens Monday–Friday
09:30–20:00 with a 14:00–16:00 break and **Saturday 09:30–14:00** — and it writes them with a
per-day guard (`WHERE NOT EXISTS (… AND day_of_week = N)`) precisely because until now nothing else
could have written that day.

With the module seed in front of it, that guard flips meaning: the day already exists, so the
salon's real hours are **discarded in silence** and the business is left CLOSED on Saturdays with a
generic 09:00–18:00 it never chose. Nothing errors. Nothing warns — the screen's «this week is
ours» notice only fires while every live row is the installer's, so a half-and-half week goes mute
too. The first symptom reaches the owner as `appointments.outside_schedule` on a Saturday booking.

That is a regression this module caused, so the guard against it lives here, in the module's own
suite, and it stays.

THE CONTRACT this file pins — the handover between a placeholder and real hours:
  1. A writer of REAL hours WINS. After the module seed and then the blueprint, the hub has the
     SALON's week: Saturday open 09:30–14:00, Monday 09:30–20:00. Not the generic one.
  2. It wins WITHOUT DUPLICATING. Exactly seven live rows, one per weekday — never the seeded row
     and the real one alive at the same time for the same day. Migration 002 dropped the unique
     index `uq_schedules_business_hours_hub_day` (schedules#8, split shifts are several rows per
     day), so the database will NOT catch a double Saturday: only this check will.
  3. The module seed does NOT come back. Re-applying it — which `register_manifest` does on EVERY
     module update — must not re-plant the generic week over the salon's.
  4. The screen goes QUIET. Once real hours are in, `weekIsUnconfirmed` (every live row authored by
     `system`) must be false, or the salon would be nagged about a week it did choose.

The blueprint statements below are a VERBATIM copy of the hours block of
`blueprints/starter_catalogs/es/beauty/seed.sql` (a different repo, so it cannot be imported).
`the_fixture_still_matches_the_real_blueprint` re-reads that file when the monorepo happens to be
next to us and fails if the WEEK has drifted — in module CI it says so and skips, rather than
pretending it verified something.

Whose guard is whose: that the catalog actually takes over the placeholder is pinned in the
`blueprints` repo (`test_a_catalog_that_writes_opening_hours_takes_over_the_seeded_week`), where
the file lives and CI can run it. THIS file owns the other half — that the handover, once done,
lands on the salon's week, once, and survives a module update.

Usage: tests/blueprint_handover.postgres.test.py   (exit 0 = green; SKIPPED without the container)
"""

import pathlib
import re
import sys

from pg_harness import HUB, NOW, SEED_USER, ScratchDb, container_available

failures: list[str] = []

# The salon's real week, as `es/beauty` describes it: L–V 09:30–20:00 (break 14:00–16:00),
# Saturday 09:30–14:00, Sunday closed.
BEAUTY_WEEK = {
    0: ("09:30", "20:00", 0),
    1: ("09:30", "20:00", 0),
    2: ("09:30", "20:00", 0),
    3: ("09:30", "20:00", 0),
    4: ("09:30", "20:00", 0),
    5: ("09:30", "14:00", 0),
    6: ("00:00", "00:00", 1),
}

# Where the real file lives when the whole monorepo is checked out. Only used by the drift check.
BLUEPRINT_SEED = (
    pathlib.Path(__file__).resolve().parents[4]
    / "blueprints/starter_catalogs/es/beauty/seed.sql"
)


def beauty_hours_sql(hub: str) -> str:
    """The hours block of the `es/beauty` starter catalog, with its demo hub_id rewritten — which
    is exactly what the Hub does before applying it (`build_starter_catalog.py`: «sustituye el
    `hub_id` demo por el real»).

    Two statements per day, in this order, and the order is the whole point:

      * an UPDATE that TAKES OVER our placeholder — the row this module seeded, recognisable
        because the installer signed it (`created_by = 'system'`) and nothing else uses that
        sentinel. This is what the blueprint had to grow;
      * the original INSERT, guarded per day, untouched. It still covers the hub that has no
        placeholder to take over (one older than schedules#36).

    Both are idempotent: on a second run there is no placeholder left to take over and the guard
    sees the live row. Dropping the UPDATE from the REAL catalog is what `blueprints` guards; here
    it is the writer under test, and without it the assertions below go red — which is how this
    fixture was written in the first place.
    """
    out = []
    for day, (open_t, close_t, closed) in BEAUTY_WEEK.items():
        brk_set = (
            "break_start = '14:00', break_end = '16:00'"
            if day < 5
            else "break_start = NULL, break_end = NULL"
        )
        brk_val = "'14:00', '16:00'" if day < 5 else "NULL, NULL"
        out.append(
            f"UPDATE schedules_business_hours SET open_time = '{open_t}', "
            f"close_time = '{close_t}', is_closed = {closed}, {brk_set}, created_by = NULL, "
            "updated_by = NULL, updated_at = '2026-01-01T00:00:00+00:00'\n"
            f"WHERE hub_id = '{hub}' AND day_of_week = {day} AND is_deleted = 0 "
            "AND created_by = 'system';"
        )
        out.append(
            "INSERT INTO schedules_business_hours (id, hub_id, day_of_week, open_time, "
            "close_time, is_closed, break_start, break_end, is_deleted, created_by, created_at, "
            "updated_by, updated_at)\n"
            f"SELECT 'bh-beauty-{day}', '{hub}', {day}, '{open_t}', '{close_t}', {closed}, "
            f"{brk_val}, 0, NULL, '2026-01-01T00:00:00+00:00', NULL, "
            "'2026-01-01T00:00:00+00:00'\n"
            "WHERE NOT EXISTS (SELECT 1 FROM schedules_business_hours "
            f"WHERE hub_id = '{hub}' AND day_of_week = {day});"
        )
    return "\n".join(out)


def check(label: str, expected, actual) -> None:
    ok = expected == actual
    print(
        f"  {'ok' if ok else 'FAIL'}: {label} = {actual!r}"
        + ("" if ok else f" (expected {expected!r})")
    )
    if not ok:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


def live_hours(db: ScratchDb, hub: str = HUB) -> list[dict]:
    """The weekly rows as the AUTHORITY reads them — the same query `appointments` preloads."""
    return sorted(
        db.run_query("schedules.business_hours.list", hub=hub),
        key=lambda r: (r["day_of_week"], r["position"]),
    )


def provisioned_salon(prefix: str) -> ScratchDb:
    """A hub provisioned the way a real one is: modules installed (so the module seed runs), then
    the sector's starter catalog applied on top (ADR-0072 §3 — both go through
    `runtime/src/seed.rs`, in that order, because the catalog needs the module's tables)."""
    db = ScratchDb(prefix)
    db.create()
    db.apply_seed()
    db.psql([], db=db.name, stdin=beauty_hours_sql(HUB))
    return db


def the_salons_real_hours_survive_the_generic_seed() -> None:
    """1 + 2 — the blueprint wins, and wins without duplicating."""
    db = provisioned_salon("schedules_bp_wins")
    try:
        rows = live_hours(db)

        check("one live row per weekday, no double Saturday", 7, len(rows))
        check(
            "the week on the hub is the SALON's",
            BEAUTY_WEEK,
            {
                r["day_of_week"]: (r["open_time"], r["close_time"], r["is_closed"])
                for r in rows
            },
        )
        # Named on its own because it is THE symptom: the salon works on Saturday morning, and the
        # generic seed closes the weekend.
        sat = [r for r in rows if r["day_of_week"] == 5]
        check("Saturday is open, once", 1, len(sat))
        check("Saturday opens at 09:30", "09:30", sat[0]["open_time"] if sat else None)
        check(
            "Saturday closes at 14:00", "14:00", sat[0]["close_time"] if sat else None
        )
        check("Saturday is not marked closed", 0, sat[0]["is_closed"] if sat else None)
    finally:
        db.drop()


def a_module_update_does_not_replant_the_generic_week() -> None:
    """3 — `register_manifest` re-applies the seed on every update of the module."""
    db = provisioned_salon("schedules_bp_update")
    try:
        db.apply_seed()  # the module is updated; its seed runs again
        rows = live_hours(db)

        check("still seven live rows after the update", 7, len(rows))
        check(
            "the salon's week survived the module update",
            BEAUTY_WEEK,
            {
                r["day_of_week"]: (r["open_time"], r["close_time"], r["is_closed"])
                for r in rows
            },
        )
    finally:
        db.drop()


def the_screen_stops_calling_it_our_guess() -> None:
    """4 — `weekIsUnconfirmed` is «every live row was written by the installer». With the salon's
    hours in, it must be false: nagging the owner about a week they did pick is noise, and a week
    that is half ours and half theirs is precisely the corrupt state this file forbids."""
    db = provisioned_salon("schedules_bp_quiet")
    try:
        authors = {r["created_by"] for r in live_hours(db)}

        check(
            "no live row is left over from the installer", False, SEED_USER in authors
        )
        check("the salon's hours carry the blueprint's author", {None}, authors)
    finally:
        db.drop()


def the_fixture_still_matches_the_real_blueprint() -> None:
    """The copy above is only worth something while it is still the truth. When the monorepo is
    checked out around us, re-read the real file and compare the week it declares."""
    if not BLUEPRINT_SEED.exists():
        print(
            f"  SKIPPED: {BLUEPRINT_SEED} is not here (module CI checks out this repo alone) — "
            "the fixture could not be compared against the real blueprint"
        )
        return

    text = BLUEPRINT_SEED.read_text()
    real: dict[int, tuple[str, str, int]] = {}
    for m in re.finditer(
        r"SELECT 'bh-beauty-(\d)', '[^']+', (\d), '([^']*)', '([^']*)', (\d)", text
    ):
        real[int(m.group(2))] = (m.group(3), m.group(4), int(m.group(5)))

    check("the fixture is the week the real blueprint declares", BEAUTY_WEEK, real)

    # And that it still takes over our placeholder for EVERY day it writes. This is the assertion
    # that turns red if someone reverts the blueprint side of the fix: without it this file would
    # keep passing on its own copy while a real salon closes on Saturdays.
    taken_over = {
        int(m)
        for m in re.findall(
            r"UPDATE schedules_business_hours\b[^;]*?day_of_week\s*=\s*(\d)"
            r"[^;]*?created_by\s*=\s*'system'",
            text,
            re.S,
        )
    }
    # Reported, NOT asserted, and the difference matters. Whether the catalog takes over the
    # placeholder is `blueprints`' own business, and it is pinned there —
    # `scripts/test_build_starter_catalog.py::test_a_catalog_that_writes_opening_hours_takes_over
    # _the_seeded_week` — where the file lives and where CI actually runs it. Asserting it from
    # here would fail on a laptop with a stale sibling checkout and SKIP in module CI (this repo is
    # checked out alone), which is a guard that fires where it does not matter and stays quiet
    # where it does. What this file owns is the CONTRACT: given a writer that takes over, the
    # handover ends with the salon's week and nothing else.
    missing = sorted(set(BEAUTY_WEEK) - taken_over)
    print(
        "  info: the real blueprint takes over the placeholder on days "
        f"{sorted(taken_over)}"
        + (
            f" — days {missing} do not (that is ERPlora/blueprints' guard, not this one; "
            "if it is not merged yet, a salon on that catalog closes on Saturdays)"
            if missing
            else " (all seven)"
        )
    )


def main() -> int:
    if not container_available():
        print("SKIPPED: Postgres container not available")
        return 0

    for test in (
        the_fixture_still_matches_the_real_blueprint,
        the_salons_real_hours_survive_the_generic_seed,
        a_module_update_does_not_replant_the_generic_week,
        the_screen_stops_calling_it_our_guess,
    ):
        print(f"\n{test.__name__}:")
        test()

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("all green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
