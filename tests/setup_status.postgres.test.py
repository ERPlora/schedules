#!/usr/bin/env python3
"""schedules#42 — the setup check answers «has a PERSON confirmed the opening hours?».

Runs against a REAL Postgres 18 in Docker: the answer is produced by SQL and every way of getting
it wrong is a SQL-semantics mistake — counting the neighbour's rows, counting rows the user
deleted, or counting the week the INSTALLER planted. The runtime is forgiving with a check it
cannot make (`architecture/hub/setup-status.md` §5: a failing check omits the item instead of
reporting a false pending), so none of those would go red on a live hub: the step would simply
never appear, or — far worse — appear already ticked on a hub that has never looked at its hours.
This harness is where they go red.

⚠️ THE WHOLE POINT: THE STEP CONFIRMS, IT DOES NOT CREATE. Since schedules#36 installing the module
SEEDS a default week (Mon–Fri 09:00–18:00, weekend closed), so a check shaped like every other
module's — «are there rows?» — would be ticked the instant the module is installed and would never
ask anybody anything. What distinguishes the two is who wrote the row: `apply_module_seed` stamps
`created_by` = 'system' (crates/runtime/src/seed.rs, `SEEDED_BY`), while saving a day through
`schedules.business_hours.set` stamps the real user. That is the same line the Hours screen already
draws for its «these are default hours» banner, so screen and checklist cannot drift apart.

The contract under test:

  1. ONE ROW, ALWAYS. `hub.setup.status` reads `rows.first()`. An aggregate with no GROUP BY
     answers `0` on an empty table instead of answering nothing, so «nobody has confirmed yet»
     stays distinguishable from «the check could not run» — the first is the user's task, the
     second is ours.
  2. THE SEEDED WEEK IS NOT A CONFIRMED WEEK. Seven rows written by the installer leave the step
     PENDING. This is the regression the whole issue is about.
  3. A PERSON SAVING A DAY FINISHES IT — including saving a day as CLOSED. «We do not open on
     Mondays» is a decision about the business, not the absence of one.
  4. IT IS STATE, NOT A MILESTONE. A hub that soft-deletes what it wrote is back to pending, the
     same way the floor plan of `tables` goes back to pending when the last table is removed.
  5. THE TENANT BOUNDARY. The salon next door confirming its week never ticks our step.

Usage: tests/setup_status.postgres.test.py   (exit 0 = green; SKIPPED without the container)
"""

import json
import sys
import uuid

from pg_harness import (
    HUB,
    MANIFEST,
    NOW,
    OTHER_HUB,
    ScratchDb,
    container_available,
    set_hours_ops,
)

failures: list[str] = []


def check(label: str, expected, actual) -> None:
    if expected == actual:
        print(f"  ok: {label} = {expected!r}")
    else:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")
        print(f"  FAIL: {label} — expected {expected!r}, got {actual!r}")


# ── The runtime's evaluator, in miniature ────────────────────────────────────────────────
#
# Mirrors `truthy` / `passes` / `is_configured` in hub/crates/runtime/src/setup_status.rs. What is
# under test is the DECLARED CONTRACT — the query AND its `configured_when` — not the SELECT on its
# own: a query that answers perfectly under a `configured_when` that can never pass is still a step
# nobody ever gets to tick.


def truthy(value) -> bool:
    if value is None or value is False:
        return False
    if value is True:
        return True
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        s = value.strip()
        return bool(s) and s != "0" and s.lower() != "false"
    if isinstance(value, (list, dict)):
        return bool(value)
    return True


def as_text(value) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value)


def passes(row: dict, spec: dict) -> bool:
    value = row.get(spec["field"])
    if "truthy" in spec:
        return truthy(value) == spec["truthy"]
    if "equals" in spec:
        return as_text(value) == as_text(spec["equals"])
    return False


def setup_rows(db: ScratchDb, hub: str = HUB) -> list[dict]:
    setup = MANIFEST.get("setup") or {}
    name = setup.get("query")
    if not name:
        raise AssertionError("module.json declares no `setup.query`")
    return db.run_query(name, dict(setup.get("params") or {}), hub=hub)


def is_configured(rows: list[dict]) -> bool:
    """Configured ⇔ there IS a row and every declared check passes on it (ADR-0063)."""
    setup = MANIFEST.get("setup") or {}
    if not rows:
        return False
    return all(passes(rows[0], c) for c in setup.get("configured_when", []))


def confirm_day(db: ScratchDb, day: int, hub: str = HUB, closed: bool = False) -> None:
    """A PERSON saves one weekday through the real command's intentions: the day is cleared and
    re-inserted, so the new rows carry `created_by` = the user, not the installer."""
    ids = [str(uuid.uuid4()) for _ in range(2)]
    db.run_intents(
        set_hours_ops(day, [("10:00", "20:00")], ids, closed=closed),
        hub=hub,
    )


# ── 1. One row, always — even before the module has been seeded ──────────────────────────


def the_check_answers_one_row_on_an_empty_table() -> None:
    db = ScratchDb("schedules_setup_empty")
    db.create()
    try:
        rows = setup_rows(db)
        # Zero rows would ALSO read as «not configured», so this is not about the verdict: it is
        # about the runtime being able to tell a real «nothing yet» from a check that never ran.
        check("an empty table still answers one row", 1, len(rows))
        for spec in (MANIFEST.get("setup") or {}).get("configured_when", []):
            # Guarded, so a query that answers NOTHING reports that one failure and lets the rest
            # of the run finish, instead of aborting the file on an IndexError.
            check(
                f"the row carries the `{spec['field']}` the contract evaluates",
                True,
                bool(rows) and spec["field"] in rows[0],
            )
        check("with no hours at all the step is pending", False, is_configured(rows))
    finally:
        db.drop()


# ── 2. The seeded week is not a confirmed week ───────────────────────────────────────────


def the_seeded_default_week_leaves_the_step_pending() -> None:
    db = ScratchDb("schedules_setup_seeded")
    db.create()
    try:
        db.apply_seed()
        check(
            "the module seeded the whole week",
            7,
            int(
                db.scalar(
                    f"SELECT COUNT(*) FROM schedules_business_hours "
                    f"WHERE hub_id = '{HUB}' AND is_deleted = 0"
                )
            ),
        )
        # THE regression this issue is about: a check that only counted rows would be ticked here,
        # on a hub whose owner has never seen the hours their bookings are being judged against.
        check(
            "a week nobody has looked at does NOT tick the step",
            False,
            is_configured(setup_rows(db)),
        )
        check("and it still answers exactly one row", 1, len(setup_rows(db)))
    finally:
        db.drop()


# ── 3. A person saving a day finishes it ─────────────────────────────────────────────────


def a_person_saving_one_day_confirms_the_hours() -> None:
    db = ScratchDb("schedules_setup_confirm")
    db.create()
    try:
        db.apply_seed()
        confirm_day(db, 0)
        check(
            "the owner correcting Monday ticks the step",
            True,
            is_configured(setup_rows(db)),
        )
        check("still exactly one row", 1, len(setup_rows(db)))
    finally:
        db.drop()


def closing_a_day_is_a_decision_too() -> None:
    db = ScratchDb("schedules_setup_closed")
    db.create()
    try:
        db.apply_seed()
        # «We do not open on Wednesdays» is the business deciding, not the business abstaining. A
        # check that demanded an OPEN interval would leave a salon that closes midweek stuck.
        confirm_day(db, 2, closed=True)
        check(
            "saving a day as closed ticks the step",
            True,
            is_configured(setup_rows(db)),
        )
    finally:
        db.drop()


# ── 4. State, not a milestone ────────────────────────────────────────────────────────────


def clearing_what_the_person_wrote_returns_the_step_to_pending() -> None:
    db = ScratchDb("schedules_setup_state")
    db.create()
    try:
        db.apply_seed()
        confirm_day(db, 0)
        check("confirmed", True, is_configured(setup_rows(db)))

        # The checklist reports the hub as it is now, not a milestone it once passed: a hub that
        # wipes the hours it wrote has work to do again — same shape as `tables.floor.status`.
        db.psql(
            [
                "-c",
                f"UPDATE schedules_business_hours SET is_deleted = 1, deleted_at = '{NOW}' "
                f"WHERE hub_id = '{HUB}' AND created_by <> 'system'",
            ],
            db=db.name,
        )
        check(
            "wiping what the person wrote is pending again",
            False,
            is_configured(setup_rows(db)),
        )
    finally:
        db.drop()


# ── 5. The tenant boundary ───────────────────────────────────────────────────────────────


def the_salon_next_door_never_ticks_our_step() -> None:
    db = ScratchDb("schedules_setup_tenancy")
    db.create()
    try:
        db.apply_seed(hub=HUB)
        db.apply_seed(hub=OTHER_HUB)
        confirm_day(db, 0, hub=OTHER_HUB)
        check(
            "the neighbour confirmed their week",
            True,
            is_configured(setup_rows(db, hub=OTHER_HUB)),
        )
        check(
            "ours is still pending",
            False,
            is_configured(setup_rows(db, hub=HUB)),
        )
    finally:
        db.drop()


def main() -> int:
    if not container_available():
        print("SKIPPED: Postgres container not available")
        return 0

    for test in (
        the_check_answers_one_row_on_an_empty_table,
        the_seeded_default_week_leaves_the_step_pending,
        a_person_saving_one_day_confirms_the_hours,
        closing_a_day_is_a_decision_too,
        clearing_what_the_person_wrote_returns_the_step_to_pending,
        the_salon_next_door_never_ticks_our_step,
    ):
        print(f"\n{test.__name__}:")
        test()

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("all green — the step asks whether a PERSON confirmed the hours")
    return 0


if __name__ == "__main__":
    sys.exit(main())
