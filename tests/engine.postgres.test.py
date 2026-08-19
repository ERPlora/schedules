#!/usr/bin/env python3
"""schedules#10 — the module's SQL against a REAL Postgres, with real rows.

Why this file exists. Until now the only permanent tests of `schedules` were the handler's Rust
units (pure logic, no database) and component tests that mock the SDK. Between those two there was
NOTHING: no test ever ran a migration, an INSERT or a list query. Three of the bugs the module
shipped lived exactly there — an impossible calendar date PERSISTED (#2), an open override written
without hours that read as «open 24 h» (#7), a UI payload the schema rejected (#7). And migration
003 (schedules#23) carries a BACKFILL, the kind of statement that is either right on the day it
runs or wrong forever.

The seam. A Tier 2 command has no `sql[]`: the WASM handler returns INTENTIONS. Which intentions,
with which params, is pinned by the Rust unit tests in `handler/src/lib.rs`; this file takes those
very intentions and runs them against the database, so both halves of a Tier 2 command are covered
and the join between them is written down instead of assumed.

What is checked:
  1. MIGRATIONS. 001→003 build the four tables; 003 is IDEMPOTENT and its backfill turns the pair
     of every live open exception into its interval 0 — including the rows a hub already had.
  2. WEEKLY HOURS. `set_business_hours`'s intentions REPLACE the day (clear + N inserts), a closed
     day is a single closed row, and the list query returns one row per interval.
  3. EXCEPTIONS (schedules#23). A special day / override writes its 0..N intervals; the guard of
     `_insert_exception_interval` refuses a foreign or invented parent; deleting the exception
     takes its intervals with it.
  4. UNIQUENESS + BULK. One special day per date is enforced by the index, and the bulk's
     `ON CONFLICT DO NOTHING` skips instead of aborting the batch.
  5. AUTHORITATIVE READS (ADR-0069). `special_days.by_date`, `special_days.dates` and
     `overrides.overlapping` answer what the handler decides on — including the edges.
  6. TENANCY. Every query and every write is scoped by `hub_id`, proven with a LIVE neighbour hub
     holding rows that would otherwise match.

Usage: tests/engine.postgres.test.py   (exit 0 = green; SKIPPED without the container)
"""

import sys

from pg_harness import HUB, NOW, OTHER_HUB, ScratchDb, container_available

failures: list[str] = []


def check(label: str, expected, actual) -> None:
    ok = expected == actual
    print(
        f"  {'ok' if ok else 'FAIL'}: {label} = {actual!r}"
        + ("" if ok else f" (expected {expected!r})")
    )
    if not ok:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


# ── The intentions the WASM handlers return. Pinned by the Rust tests named on each one. ──


def set_hours_ops(
    day: int, intervals: list[tuple[str, str]], ids: list[str], closed: bool = False
):
    """`set_business_hours` → clear the day + one insert per interval (or one closed row).
    Pinned by `set_hours_with_two_intervals_clears_the_day_and_inserts_one_row_per_interval`."""
    ops = [("schedules._clear_business_hours_day", {"day_of_week": day})]
    if closed:
        return ops + [
            (
                "schedules._insert_business_hours",
                {
                    "id": ids[0],
                    "day_of_week": day,
                    "position": 0,
                    "open_time": "00:00",
                    "close_time": "00:00",
                    "is_closed": 1,
                    "break_start": None,
                    "break_end": None,
                },
            )
        ]
    for i, (o, c) in enumerate(intervals):
        ops.append(
            (
                "schedules._insert_business_hours",
                {
                    "id": ids[i],
                    "day_of_week": day,
                    "position": i,
                    "open_time": o,
                    "close_time": c,
                    "is_closed": 0,
                    "break_start": None,
                    "break_end": None,
                },
            )
        )
    return ops


def create_special_day_ops(
    day_id: str,
    date: str,
    name: str,
    intervals: list[tuple[str, str]],
    interval_ids: list[str],
    closed: bool = False,
    recurring: int = 0,
):
    """`create_special_day` → the day (id from `context.new_ids[0]`) + one interval per tramo.
    Pinned by `special_day_with_intervals_writes_the_day_plus_one_child_row_per_interval`."""
    first = intervals[0] if intervals and not closed else (None, None)
    ops = [
        (
            "schedules._insert_special_day",
            {
                "id": day_id,
                "date": date,
                "name": name,
                "is_closed": 1 if closed else 0,
                "open_time": first[0],
                "close_time": first[1],
                "recurring_yearly": recurring,
                "notes": "",
            },
        )
    ]
    if closed:
        return ops
    for i, (o, c) in enumerate(intervals):
        ops.append(
            (
                "schedules._insert_exception_interval",
                {
                    "id": interval_ids[i],
                    "exception_kind": "special_day",
                    "exception_id": day_id,
                    "position": i,
                    "open_time": o,
                    "close_time": c,
                },
            )
        )
    return ops


def create_override_ops(
    ov_id: str,
    start: str,
    end: str,
    reason: str,
    intervals: list[tuple[str, str]],
    interval_ids: list[str],
    closed: bool = False,
):
    """`create_override` → the override + its intervals. Pinned by
    `override_with_intervals_writes_the_override_plus_one_child_row_per_interval`."""
    first = intervals[0] if intervals and not closed else (None, None)
    ops = [
        (
            "schedules._insert_override",
            {
                "id": ov_id,
                "start_date": start,
                "end_date": end,
                "reason": reason,
                "open_time": first[0],
                "close_time": first[1],
                "is_closed": 1 if closed else 0,
            },
        )
    ]
    if closed:
        return ops
    for i, (o, c) in enumerate(intervals):
        ops.append(
            (
                "schedules._insert_exception_interval",
                {
                    "id": interval_ids[i],
                    "exception_kind": "override",
                    "exception_id": ov_id,
                    "position": i,
                    "open_time": o,
                    "close_time": c,
                },
            )
        )
    return ops


# ── 1. Migrations ──────────────────────────────────────────────────────────────────────────


def test_migration_003_backfills_the_pair_of_every_live_open_exception() -> None:
    print("\n· migration 003: the pair of a live open exception becomes its interval 0")
    db = ScratchDb("schedules_mig")
    try:
        # The world BEFORE schedules#23: only 001 + 002 exist.
        db.create(upto=2)
        check(
            "003 has not run yet",
            "f",
            db.scalar("SELECT to_regclass('schedules_exception_interval') IS NOT NULL"),
        )
        for sql in [
            # An open special day, a closed one, and an open override — as a live hub had them.
            f"""INSERT INTO schedules_special_day (id, hub_id, date, name, is_closed, open_time,
                 close_time, recurring_yearly, notes, is_deleted, created_at)
                VALUES ('sd-open','{HUB}','2026-12-24','Eve',0,'10:00','13:00',0,'',0,'{NOW}'),
                       ('sd-shut','{HUB}','2026-12-25','Christmas',1,NULL,NULL,1,'',0,'{NOW}'),
                       ('sd-gone','{HUB}','2026-11-01','Deleted',0,'09:00','14:00',0,'',1,'{NOW}')""",
            f"""INSERT INTO schedules_override (id, hub_id, start_date, end_date, reason, open_time,
                 close_time, is_closed, is_deleted, created_at)
                VALUES ('ov-open','{HUB}','2026-08-01','2026-08-31','Summer','10:00','14:00',0,0,'{NOW}'),
                       ('ov-shut','{OTHER_HUB}','2026-08-01','2026-08-31','Holidays',NULL,NULL,1,0,'{NOW}')""",
        ]:
            db.psql([], db=db.name, stdin=sql + ";")

        db.migrate(2)
        got = db.rows(
            "SELECT id, hub_id, exception_kind, exception_id, position, open_time, close_time "
            "FROM schedules_exception_interval ORDER BY id"
        )
        check("only the LIVE OPEN exceptions were backfilled", 2, len(got))
        check(
            "the special day's pair is its interval 0",
            {
                "id": "sd-open:0",
                "hub_id": HUB,
                "exception_kind": "special_day",
                "exception_id": "sd-open",
                "position": 0,
                "open_time": "10:00",
                "close_time": "13:00",
            },
            got[1],
        )
        check("the override's pair too", "ov-open:0", got[0]["id"])
        check("the hub of each row is preserved", HUB, got[0]["hub_id"])

        # Running it twice must not duplicate anything (a hub can replay a migration).
        db.migrate(2)
        check(
            "003 is idempotent",
            2,
            int(db.scalar("SELECT count(*) FROM schedules_exception_interval")),
        )
    finally:
        db.drop()


# ── 2..6. The engine on a fully migrated database ─────────────────────────────────────────


def test_weekly_hours_are_replaced_not_accumulated(db: ScratchDb) -> None:
    print("\n· weekly hours: saving a day REPLACES its intervals")
    db.run_intents(set_hours_ops(0, [("09:00", "18:00")], ["m-0"]))
    check(
        "one interval on Monday", 1, len(db.run_query("schedules.business_hours.list"))
    )
    # Same day again, now a split shift: the old row must be gone, not kept alongside.
    db.run_intents(
        set_hours_ops(0, [("10:00", "14:00"), ("17:00", "20:00")], ["m-1", "m-2"])
    )
    rows = [
        r
        for r in db.run_query("schedules.business_hours.list")
        if r["day_of_week"] == 0
    ]
    check("the day now has exactly its two new intervals", 2, len(rows))
    check(
        "in position order",
        [(0, "10:00"), (1, "17:00")],
        sorted((r["position"], r["open_time"]) for r in rows),
    )
    check(
        "the replaced row is soft-deleted, not erased",
        1,
        int(
            db.scalar(
                "SELECT count(*) FROM schedules_business_hours WHERE id = 'm-0' AND is_deleted = 1"
            )
        ),
    )
    # A closed day is ONE closed row, and it also replaces what was there.
    db.run_intents(set_hours_ops(6, [], ["s-0"], closed=True))
    sunday = [
        r
        for r in db.run_query("schedules.business_hours.list")
        if r["day_of_week"] == 6
    ]
    check("a closed day is a single closed row", [1], [r["is_closed"] for r in sunday])


def test_a_special_day_writes_its_intervals_and_the_guard_holds(db: ScratchDb) -> None:
    print("\n· special day: 0..N intervals, with the parent guard (schedules#23)")
    db.run_intents(
        create_special_day_ops(
            "sd1",
            "2026-12-24",
            "Christmas Eve",
            [("10:00", "13:00"), ("17:00", "19:00")],
            ["i1", "i2"],
        )
    )
    rows = db.run_query("schedules.exception_intervals.list")
    check("two intervals hanging from the day", 2, len(rows))
    check(
        "both point at it, in order",
        [("special_day", "sd1", 0), ("special_day", "sd1", 1)],
        sorted((r["exception_kind"], r["exception_id"], r["position"]) for r in rows),
    )
    check(
        "the pair on the parent mirrors the FIRST interval",
        "10:00",
        db.scalar("SELECT open_time FROM schedules_special_day WHERE id = 'sd1'"),
    )

    # The guard of `_insert_exception_interval`: the guest cannot read the database, so an
    # operation naming an exception that is not ours must write NOTHING.
    for label, params in [
        (
            "an invented parent",
            {
                "id": "bad-1",
                "exception_kind": "special_day",
                "exception_id": "does-not-exist",
                "position": 0,
                "open_time": "10:00",
                "close_time": "11:00",
            },
        ),
        (
            "the wrong kind for a real parent",
            {
                "id": "bad-2",
                "exception_kind": "override",
                "exception_id": "sd1",
                "position": 9,
                "open_time": "10:00",
                "close_time": "11:00",
            },
        ),
    ]:
        written = db.run_intents([("schedules._insert_exception_interval", params)])
        check(f"guard refuses {label}", 0, written)
    check(
        "nothing extra was written",
        2,
        len(db.run_query("schedules.exception_intervals.list")),
    )


def test_deleting_an_exception_takes_its_intervals(db: ScratchDb) -> None:
    print("\n· delete: the exception and its intervals go together")
    db.run_intents(
        create_override_ops(
            "ov1",
            "2026-08-01",
            "2026-08-31",
            "Summer",
            [("10:00", "13:30"), ("18:00", "21:00")],
            ["oi1", "oi2"],
        )
    )
    check(
        "the override has two intervals",
        2,
        len(
            [
                r
                for r in db.run_query("schedules.exception_intervals.list")
                if r["exception_kind"] == "override"
            ]
        ),
    )
    db.run_command("schedules.overrides.delete", {"override_id": "ov1"})
    check(
        "the override is gone from the list",
        0,
        len(db.run_query("schedules.overrides.list")),
    )
    check(
        "and so are its intervals",
        0,
        len(
            [
                r
                for r in db.run_query("schedules.exception_intervals.list")
                if r["exception_kind"] == "override"
            ]
        ),
    )
    check(
        "soft-deleted, not erased",
        2,
        int(
            db.scalar(
                "SELECT count(*) FROM schedules_exception_interval WHERE exception_id = 'ov1' AND is_deleted = 1"
            )
        ),
    )
    # Deleting the special day of the previous test does the same for `special_day` rows.
    db.run_command("schedules.special_days.delete", {"special_day_id": "sd1"})
    check(
        "no interval survives its special day",
        0,
        len(db.run_query("schedules.exception_intervals.list")),
    )


def test_one_special_day_per_date_and_the_bulk_skips_instead_of_aborting(
    db: ScratchDb,
) -> None:
    print("\n· uniqueness per date + the bulk's skip semantics")
    db.run_intents(
        create_special_day_ops("sd-x", "2026-01-06", "Epiphany", [], [], closed=True)
    )
    # The unique index is the hard backstop: a second row for the same date must not exist.
    duplicated = False
    try:
        db.run_intents(
            create_special_day_ops(
                "sd-y", "2026-01-06", "Duplicate", [], [], closed=True
            )
        )
        duplicated = True
    except RuntimeError:
        pass
    check(
        "a second special day on the same date is rejected by the index",
        False,
        duplicated,
    )
    # The bulk uses the tolerant insert: the taken date is SKIPPED, the new one is created.
    written = db.run_intents(
        [
            (
                "schedules._insert_special_day_skip",
                {
                    "date": "2026-01-06",
                    "name": "Again",
                    "is_closed": 1,
                    "open_time": None,
                    "close_time": None,
                    "recurring_yearly": 0,
                    "notes": "",
                },
            ),
            (
                "schedules._insert_special_day_skip",
                {
                    "date": "2026-01-07",
                    "name": "New one",
                    "is_closed": 1,
                    "open_time": None,
                    "close_time": None,
                    "recurring_yearly": 0,
                    "notes": "",
                },
            ),
        ]
    )
    check("the batch wrote only the free date", 1, written)
    check(
        "the taken date kept its original name",
        "Epiphany",
        db.scalar(
            "SELECT name FROM schedules_special_day WHERE date = '2026-01-06' AND is_deleted = 0"
        ),
    )


def test_the_authoritative_reads_answer_what_the_handler_decides_on(
    db: ScratchDb,
) -> None:
    print("\n· authoritative reads (ADR-0069): by_date, dates, overlapping")
    check(
        "by_date finds the live day of that date",
        ["2026-01-06"],
        [
            r["date"]
            for r in db.run_query(
                "schedules.special_days.by_date", {"date": "2026-01-06"}
            )
        ],
    )
    check(
        "and answers empty for a free one",
        [],
        db.run_query("schedules.special_days.by_date", {"date": "2026-03-03"}),
    )
    check(
        "dates lists every live special day",
        ["2026-01-06", "2026-01-07"],
        sorted(r["date"] for r in db.run_query("schedules.special_days.dates")),
    )

    db.run_intents(
        create_override_ops(
            "ov-live", "2026-06-10", "2026-06-20", "Refurb", [], [], closed=True
        )
    )
    cases = [
        ("a range strictly inside", "2026-06-12", "2026-06-15", 1),
        ("a range touching the first day", "2026-06-01", "2026-06-10", 1),
        ("a range touching the last day", "2026-06-20", "2026-06-30", 1),
        ("a range ending the day before", "2026-06-01", "2026-06-09", 0),
        ("a range starting the day after", "2026-06-21", "2026-06-30", 0),
    ]
    for label, start, end, expected in cases:
        got = db.run_query(
            "schedules.overrides.overlapping", {"start_date": start, "end_date": end}
        )
        check(f"overlapping: {label}", expected, len(got))


def test_every_read_and_write_is_scoped_by_hub(db: ScratchDb) -> None:
    print("\n· tenancy: a LIVE neighbour hub holds rows that would otherwise match")
    # The neighbour gets the same dates and the same weekday, so a missing `hub_id` shows up.
    db.run_intents(set_hours_ops(0, [("08:00", "16:00")], ["n-m0"]), hub=OTHER_HUB)
    db.run_intents(
        create_special_day_ops(
            "n-sd", "2026-01-06", "Neighbour's Epiphany", [("11:00", "12:00")], ["n-i1"]
        ),
        hub=OTHER_HUB,
    )
    db.run_intents(
        create_override_ops(
            "n-ov",
            "2026-06-10",
            "2026-06-20",
            "Neighbour's refurb",
            [],
            [],
            closed=True,
        ),
        hub=OTHER_HUB,
    )

    check(
        "business_hours.list shows only ours",
        ["10:00", "17:00"],
        sorted(
            r["open_time"]
            for r in db.run_query("schedules.business_hours.list")
            if r["day_of_week"] == 0
        ),
    )
    check(
        "special_days.dates shows only ours",
        ["2026-01-06", "2026-01-07"],
        sorted(r["date"] for r in db.run_query("schedules.special_days.dates")),
    )
    check(
        "by_date does not leak the neighbour's day on the same date",
        1,
        len(db.run_query("schedules.special_days.by_date", {"date": "2026-01-06"})),
    )
    check(
        "exception_intervals.list shows only ours",
        0,
        len(db.run_query("schedules.exception_intervals.list")),
    )
    check(
        "overlapping does not see the neighbour's override",
        1,
        len(
            db.run_query(
                "schedules.overrides.overlapping",
                {"start_date": "2026-06-12", "end_date": "2026-06-15"},
            )
        ),
    )
    # And a write aimed at our hub cannot touch the neighbour's row.
    db.run_command("schedules.special_days.delete", {"special_day_id": "n-sd"})
    check(
        "deleting the neighbour's id from our hub does nothing",
        0,
        int(
            db.scalar(
                f"SELECT count(*) FROM schedules_special_day WHERE id = 'n-sd' AND is_deleted = 1"
            )
        ),
    )
    check(
        "the neighbour's interval is untouched too",
        1,
        int(
            db.scalar(
                f"SELECT count(*) FROM schedules_exception_interval WHERE hub_id = '{OTHER_HUB}' AND is_deleted = 0"
            )
        ),
    )


def test_settings_is_a_singleton_per_hub(db: ScratchDb) -> None:
    print("\n· settings: upsert, one row per hub")
    db.run_command(
        "schedules.settings.save",
        {
            "timezone": "Europe/Madrid",
            "week_starts_on": 1,
            "slot_duration": 30,
            "auto_close_enabled": 0,
        },
    )
    db.run_command(
        "schedules.settings.save",
        {
            "timezone": "Atlantic/Canary",
            "week_starts_on": 7,
            "slot_duration": 15,
            "auto_close_enabled": 1,
        },
    )
    rows = db.run_query("schedules.settings.get")
    check("still ONE row after two saves", 1, len(rows))
    check(
        "and it holds the last values",
        ("Atlantic/Canary", 7, 15, 1),
        (
            rows[0]["timezone"],
            rows[0]["week_starts_on"],
            rows[0]["slot_duration"],
            rows[0]["auto_close_enabled"],
        ),
    )
    db.run_command(
        "schedules.settings.save",
        {
            "timezone": "Europe/Lisbon",
            "week_starts_on": 1,
            "slot_duration": 60,
            "auto_close_enabled": 0,
        },
        hub=OTHER_HUB,
    )
    check(
        "the neighbour has its own singleton",
        "Atlantic/Canary",
        db.run_query("schedules.settings.get")[0]["timezone"],
    )


def main() -> int:
    if not container_available():
        print(
            "SKIPPED: the test Postgres container is not running "
            "(docker start erplora-test-pg-5433)"
        )
        return 0

    test_migration_003_backfills_the_pair_of_every_live_open_exception()

    db = ScratchDb("schedules_engine")
    try:
        db.create()
        test_weekly_hours_are_replaced_not_accumulated(db)
        test_a_special_day_writes_its_intervals_and_the_guard_holds(db)
        test_deleting_an_exception_takes_its_intervals(db)
        test_one_special_day_per_date_and_the_bulk_skips_instead_of_aborting(db)
        test_the_authoritative_reads_answer_what_the_handler_decides_on(db)
        test_every_read_and_write_is_scoped_by_hub(db)
        test_settings_is_a_singleton_per_hub(db)
    finally:
        db.drop()

    print()
    if failures:
        print(f"✗ {len(failures)} failure(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("✓ engine.postgres: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
