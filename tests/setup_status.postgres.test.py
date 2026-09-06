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
`created_by` with the literal 'system' (crates/runtime/src/seed.rs), while saving a day through
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
  6. THE INSTALLER IS THE ONLY AUTHOR THAT DOES NOT COUNT. A starter catalog signs its hours
     `created_by = NULL`, and NULL is where SQL quietly disagrees with the screen: `NULL <>
     'system'` is NULL, not TRUE. A provisioned salon must tick the step, or it is left with a
     pending item and a silent screen — nothing asking for the very thing being demanded.

Usage: tests/setup_status.postgres.test.py   (exit 0 = green; SKIPPED without the container)
"""

import sys
import uuid

from pg_harness import (
    HUB,
    MANIFEST,
    NOW,
    OTHER_HUB,
    SEED_USER,
    USER,
    ScratchDb,
    confirm_week_ops,
    container_available,
    is_configured,
    screen_calls_the_week_ours,
    set_hours_ops,
    setup_rows,
)

failures: list[str] = []


def check(label: str, expected, actual) -> None:
    if expected == actual:
        print(f"  ok: {label} = {expected!r}")
    else:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")
        print(f"  FAIL: {label} — expected {expected!r}, got {actual!r}")


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


# ── 6. The week a blueprint wrote ────────────────────────────────────────────────────────


def hours_a_blueprint_wrote_tick_the_step() -> None:
    """A starter catalog is neither the installer nor a person, and it signs its rows
    `created_by = NULL` (`blueprints/starter_catalogs/es/beauty/seed.sql`: it takes over the
    placeholder with `SET … created_by = NULL`).

    NULL is where a check written the obvious way goes wrong without failing: in SQL
    `NULL <> 'system'` is NULL, not TRUE, so the blueprint week counts as ZERO and the step stays
    pending on a hub whose hours are already the salon's — while the Hours screen, which asks the
    same question in TypeScript (`created_by === 'system'`), has already gone quiet. Nothing on
    screen would ask the owner for anything, and the step would never clear.

    The es/beauty week is not generic either — 09:30–20:00 with a 14:00–16:00 break and Saturday
    morning — so «the business chose these hours» is a statement about the real world, not a
    technicality about a column."""
    db = ScratchDb("schedules_setup_blueprint")
    db.create()
    try:
        db.apply_seed()
        # The takeover statement of the real catalog, in miniature: the blueprint claims the
        # placeholder the installer planted and stamps the row as its own (NULL author).
        db.psql(
            [
                "-c",
                f"UPDATE schedules_business_hours SET open_time = '09:30', close_time = '20:00', "
                f"created_by = NULL, updated_at = '{NOW}' "
                f"WHERE hub_id = '{HUB}' AND is_deleted = 0 AND created_by = 'system'",
            ],
            db=db.name,
        )
        check(
            "the installer's signature is gone from every live row",
            0,
            int(
                db.scalar(
                    f"SELECT COUNT(*) FROM schedules_business_hours "
                    f"WHERE hub_id = '{HUB}' AND is_deleted = 0 AND created_by = 'system'"
                )
            ),
        )
        check(
            "the week the salon was provisioned with ticks the step",
            True,
            is_configured(setup_rows(db)),
        )
        # And the two surfaces still agree: the screen is quiet on this same state.
        check(
            "the screen is quiet about it too",
            False,
            screen_calls_the_week_ours(
                db.run_query("schedules.business_hours.list", hub=HUB)
            ),
        )
    finally:
        db.drop()


# ── 7. Saying «yes, this is my week» finishes the step without editing anything ───────────


WEEK_COLUMNS = "day_of_week, position, open_time, close_time, is_closed, break_start, break_end"


def live_week(db: ScratchDb, hub: str = HUB) -> list[dict]:
    return db.rows(
        f"SELECT {WEEK_COLUMNS}, created_by FROM schedules_business_hours "
        f"WHERE hub_id = '{hub}' AND is_deleted = 0 ORDER BY day_of_week, position"
    )


def hours_only(week: list[dict]) -> list[tuple]:
    return [tuple(row[c] for c in WEEK_COLUMNS.split(", ")) for row in week]


def confirming_the_default_week_ticks_the_step_without_moving_an_hour() -> None:
    """schedules#43 — the gesture the step was missing.

    Before this, the ONLY way to finish a step that asks «are these your hours?» was to open a day
    and save it back unchanged: a business the default week fits had to pretend to edit something.
    `schedules.business_hours.confirm_week` re-signs the seven days in one transaction, and the two
    readings of the state — the checklist and the screen's «these are default hours» notice — have
    to flip TOGETHER, or the owner is left with a pending task and nothing on screen asking for it.
    """
    db = ScratchDb("schedules_setup_confirm_week")
    db.create()
    try:
        db.apply_seed()
        before = live_week(db)
        check("the seeded week is pending", False, is_configured(setup_rows(db)))
        check("and the screen calls it ours", True, screen_calls_the_week_ours(before))

        ids = [str(uuid.uuid4()) for _ in before]
        db.run_intents(confirm_week_ops(before, ids))

        after = live_week(db)
        # THE PROMISE: the person said yes, they did not edit. Every hour, every closed day and
        # every legacy break column comes back identical — only the signature changed.
        check("not one opening hour moved", hours_only(before), hours_only(after))
        check("the week is still seven days", 7, len(after))
        check(
            "and every row is now signed by the person",
            {USER},
            {row["created_by"] for row in after},
        )
        check(
            "the installer no longer owns a live row",
            0,
            sum(1 for row in after if row["created_by"] == SEED_USER),
        )

        # The two readings flip together, which is the whole reason schedules#42 put the screen's
        # rule in this harness instead of leaving it in the component.
        check("the step is done", True, is_configured(setup_rows(db)))
        check("and the notice goes quiet", False, screen_calls_the_week_ours(after))

        # The seeded rows are soft-deleted, not gone: the audit still holds who wrote what.
        check(
            "the week the installer wrote is kept as history",
            7,
            int(
                db.scalar(
                    f"SELECT COUNT(*) FROM schedules_business_hours "
                    f"WHERE hub_id = '{HUB}' AND is_deleted = 1 "
                    f"AND created_by = '{SEED_USER}'"
                )
            ),
        )
    finally:
        db.drop()


def confirming_never_reaches_the_salon_next_door() -> None:
    """The command writes seven days with no `day_of_week` filter of its own beyond the one in each
    intention — the `hub_id` in every statement is the only thing keeping the neighbour's week out
    of it. A tenancy hole here would re-sign somebody else's hours in their own name."""
    db = ScratchDb("schedules_confirm_week_tenancy")
    db.create()
    try:
        db.apply_seed(hub=HUB)
        db.apply_seed(hub=OTHER_HUB)
        neighbour_before = live_week(db, hub=OTHER_HUB)

        ours = live_week(db)
        db.run_intents(confirm_week_ops(ours, [str(uuid.uuid4()) for _ in ours]), hub=HUB)

        check("our step is done", True, is_configured(setup_rows(db)))
        check(
            "the neighbour's is untouched and still pending",
            False,
            is_configured(setup_rows(db, hub=OTHER_HUB)),
        )
        check(
            "and their week is byte for byte the one they had",
            neighbour_before,
            live_week(db, hub=OTHER_HUB),
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
        hours_a_blueprint_wrote_tick_the_step,
        confirming_the_default_week_ticks_the_step_without_moving_an_hour,
        confirming_never_reaches_the_salon_next_door,
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
