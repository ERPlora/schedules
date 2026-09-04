#!/usr/bin/env python3
"""schedules#36 — the default opening week the module seeds when it is installed.

Why this file exists. ADR-0392 gave `is_open` the verdict `no_hours`: nobody has written a rule
for this day, so the business is NOT declared open, and the consumer is free to say «set your
opening hours» instead of painting a closed door. appointments#102/#105 wired the first real
consumer and the hole showed: with not one weekly row `appointments` cannot refuse — refusing
would turn «I have not set my hours yet» into «I cannot take bookings», an outage, not a guard —
so its door falls back to permitting (`schedules_opening` → `Ok(None)`, handler/src/lib.rs). The
fallback only disappears when `no_hours` stops being REACHABLE, and that is what the seed does.

⚠️ `no_hours` is answered PER DAY, not per hub (`is_open_answers_with_a_stable_code_and_no_baked
_english` pins a Sunday answering `no_hours` while the other days are configured). So the seed
writes ALL SEVEN days — Saturday and Sunday as explicit closed rows — or the weekend keeps
answering «nothing configured» and nothing has been fixed.

What is checked:
  1. FRESH INSTALL. Migrating and seeding leaves the seven days, Monday–Friday 09:00–18:00 open
     and the weekend closed, and every weekday has at least one live row.
  2. IDEMPOTENT. Running the seed again — which is what installing the module a second time does,
     since `register_manifest` re-applies it on every update — writes nothing new.
  3. NEVER OVERWRITES. A hub that has already set its hours keeps them, and does not grow the six
     days it never asked for. This is the one the guard exists for.
  4. NO RESURRECTION. A hub whose rows are all soft-deleted has still TOUCHED its hours: the seed
     leaves it alone (the guard deliberately does not filter by `is_deleted`).
  5. TENANCY. The seed writes only the hub it is applied to.
  6. ORDINARY ROWS. The seeded week is edited by `set_business_hours` like any other, and carries
     the hub's row contract (`is_deleted` = 0, audit stamped by the installer).

Usage: tests/seed.postgres.test.py   (exit 0 = green; SKIPPED without the container)
"""

import sys

from pg_harness import (
    HUB,
    NOW,
    OTHER_HUB,
    SEED_USER,
    ScratchDb,
    container_available,
    set_hours_ops,
)

failures: list[str] = []

# The week the module ships, as the market does it (schedules#36). Monday = 0.
WEEKDAYS = [0, 1, 2, 3, 4]
WEEKEND = [5, 6]
OPEN_TIME = "09:00"
CLOSE_TIME = "18:00"


def check(label: str, expected, actual) -> None:
    ok = expected == actual
    print(
        f"  {'ok' if ok else 'FAIL'}: {label} = {actual!r}"
        + ("" if ok else f" (expected {expected!r})")
    )
    if not ok:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


def live_hours(db: ScratchDb, hub: str = HUB) -> list[dict]:
    """The weekly rows as the AUTHORITY reads them: `schedules.business_hours.list` is the very
    query `appointments` preloads (SCHEDULES_HOURS_READ) to decide whether a booking fits."""
    return sorted(
        db.run_query("schedules.business_hours.list", hub=hub),
        key=lambda r: (r["day_of_week"], r["position"]),
    )


def seeds_the_default_week_on_a_fresh_install() -> None:
    """1 — installing the module leaves a business that already has a week."""
    db = ScratchDb("schedules_seed_fresh")
    try:
        db.create()
        check("before the seed there is not one row", [], live_hours(db))

        db.apply_seed()
        rows = live_hours(db)

        check("the seed writes one row per weekday", 7, len(rows))
        check(
            "every day of the week is covered — this is what kills `no_hours`",
            [0, 1, 2, 3, 4, 5, 6],
            [r["day_of_week"] for r in rows],
        )
        check(
            "Monday to Friday open 09:00–18:00 in a single interval",
            [(d, OPEN_TIME, CLOSE_TIME, False, 0) for d in WEEKDAYS],
            [
                (
                    r["day_of_week"],
                    r["open_time"],
                    r["close_time"],
                    bool(r["is_closed"]),
                    r["position"],
                )
                for r in rows
                if r["day_of_week"] in WEEKDAYS
            ],
        )
        check(
            "Saturday and Sunday are CLOSED rows, not missing ones",
            [(d, True) for d in WEEKEND],
            [
                (r["day_of_week"], bool(r["is_closed"]))
                for r in rows
                if r["day_of_week"] in WEEKEND
            ],
        )
        check(
            "no day carries a legacy break — a break is the gap between two intervals",
            [(None, None)] * 7,
            [(r["break_start"], r["break_end"]) for r in rows],
        )
    finally:
        db.drop()


def the_seed_is_idempotent() -> None:
    """2 — `register_manifest` re-applies the seed on every install AND every update."""
    db = ScratchDb("schedules_seed_idempotent")
    try:
        db.create()
        db.apply_seed()
        first = live_hours(db)

        db.apply_seed()
        db.apply_seed()

        check("re-installing does not duplicate the week", first, live_hours(db))
        check(
            "and writes no soft-deleted leftovers either",
            "7",
            db.scalar(
                f"SELECT count(*) FROM schedules_business_hours WHERE hub_id = '{HUB}'"
            ),
        )
    finally:
        db.drop()


def never_overwrites_a_hub_that_already_set_its_hours() -> None:
    """3 — the guard's reason to exist: a live hub updating the module keeps its own week."""
    db = ScratchDb("schedules_seed_keeps")
    try:
        db.create()
        # A salon that opens Monday 10:00–20:00 and says nothing about the rest of the week.
        db.run_intents(set_hours_ops(0, [("10:00", "20:00")], ["own-mon"]))
        before = live_hours(db)

        db.apply_seed()

        check("its Monday is untouched", before, live_hours(db))
        check(
            "and the seed did not add the six days it never asked for",
            1,
            len(live_hours(db)),
        )
    finally:
        db.drop()


def does_not_resurrect_hours_a_hub_cleared() -> None:
    """4 — all rows soft-deleted is still «this hub has touched its hours»."""
    db = ScratchDb("schedules_seed_no_resurrection")
    try:
        db.create()
        db.run_intents(set_hours_ops(0, [("10:00", "20:00")], ["own-mon"]))
        db.run_intents([("schedules._clear_business_hours_day", {"day_of_week": 0})])
        check("the hub is left with no LIVE row", [], live_hours(db))

        db.apply_seed()

        check("and the seed does not put a week back", [], live_hours(db))
    finally:
        db.drop()


def the_seed_is_scoped_to_one_hub() -> None:
    """5 — a seed is applied per hub; the neighbour is not seeded by ours."""
    db = ScratchDb("schedules_seed_tenancy")
    try:
        db.create()
        db.apply_seed(hub=HUB)

        check("ours has its week", 7, len(live_hours(db, hub=HUB)))
        check("the neighbour has nothing", [], live_hours(db, hub=OTHER_HUB))

        db.apply_seed(hub=OTHER_HUB)
        check("until it is installed there too", 7, len(live_hours(db, hub=OTHER_HUB)))
        check(
            "and ours still has exactly its own seven",
            "7",
            db.scalar(
                f"SELECT count(*) FROM schedules_business_hours WHERE hub_id = '{HUB}'"
            ),
        )
    finally:
        db.drop()


def the_seeded_week_is_an_ordinary_week() -> None:
    """6 — nothing about a seeded row is special: it is edited and stamped like any other."""
    db = ScratchDb("schedules_seed_ordinary")
    try:
        db.create()
        db.apply_seed()

        stamped = db.rows(
            "SELECT is_deleted, created_by, created_at, updated_at "
            f"FROM schedules_business_hours WHERE hub_id = '{HUB}' "
            "ORDER BY day_of_week"
        )
        check(
            "the installer signs the audit, and the row contract holds",
            [(0, SEED_USER, NOW, NOW)] * 7,
            [
                (r["is_deleted"], r["created_by"], r["created_at"], r["updated_at"])
                for r in stamped
            ],
        )

        # The owner corrects Saturday: the seeded closed row is REPLACED, not accumulated.
        db.run_intents(set_hours_ops(5, [("10:00", "14:00")], ["sat-0"]))
        saturday = [r for r in live_hours(db) if r["day_of_week"] == 5]
        check(
            "correcting a seeded day replaces it",
            [(5, "10:00", "14:00", False)],
            [
                (
                    r["day_of_week"],
                    r["open_time"],
                    r["close_time"],
                    bool(r["is_closed"]),
                )
                for r in saturday
            ],
        )
        check("and the week is still seven days", 7, len(live_hours(db)))
    finally:
        db.drop()


def main() -> int:
    if not container_available():
        print("SKIPPED: Postgres container not available")
        return 0

    for test in (
        seeds_the_default_week_on_a_fresh_install,
        the_seed_is_idempotent,
        never_overwrites_a_hub_that_already_set_its_hours,
        does_not_resurrect_hours_a_hub_cleared,
        the_seed_is_scoped_to_one_hub,
        the_seeded_week_is_an_ordinary_week,
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
