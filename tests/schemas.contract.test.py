#!/usr/bin/env python3
"""schedules#10 — every public command validates its payload on the SERVER, with a closed contract.

Why this file exists. The component tests mock the SDK: they check that the form CALLS the command
with a given object, and nothing ever runs that object through the module's JSON Schema. That is
exactly how schedules#7 shipped — the special-day form sent `existing_dates`, a key the schema
rejects with `additionalProperties: false`, so every single create failed in production while the
UI suite stayed green. A test that watches the form talk to a mock proves the form is consistent
with itself, not with the contract.

What this file proves, statically, against the module's own JSON Schemas (Draft 2020-12, the
dialect the runtime compiles — `crates/runtime/src/registry.rs`):

  1. EVERY public (non `_`) command that takes a payload declares a `schema`, the file exists, it
     parses, and it is CLOSED (`additionalProperties: false`) — an unknown key is a typo or an
     attack, never a no-op.
  2. THE EXACT PAYLOADS THE UI SENDS are accepted. They are copied from
     `ui/components/erp-schedules-hours/erp-schedules-hours.ts` (the four forms) and from the
     component tests, so the day a form grows a field this test goes red instead of production.
  3. A matrix of violations is REFUSED: an unknown key (schedules#7), a malformed hour, an
     interval missing a bound, more than 12 intervals, an empty batch, a batch over 366 items, a
     weekday outside 0–6, a slot duration outside 5–120.
  4. What JSON Schema CANNOT judge stays out of it, named: overlapping intervals, `close > open`,
     the real calendar (`2026-02-31`), the duplicate date. Those are the handler's, and they are
     pinned by the Rust tests in `handler/src/lib.rs` — this file asserts the schema does NOT
     pretend to cover them, so nobody trusts the wrong layer.

Usage: uv run --with jsonschema tests/schemas.contract.test.py   (exit 0 = green)
       (`jsonschema` is the only dependency; without it the test FAILS loudly, it does not skip —
       a validation test that skips proves nothing.)
"""

import json
import pathlib
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())

try:
    from jsonschema import Draft202012Validator
except (
    ModuleNotFoundError
):  # pragma: no cover - the dependency is the point of the test
    print(
        "✗ `jsonschema` is not importable. Run:\n"
        "    uv run --with jsonschema tests/schemas.contract.test.py\n"
        "  (skipping would turn a validation test into a green light for nothing)"
    )
    sys.exit(1)

failures: list[str] = []


def check(label: str, expected, actual) -> None:
    ok = expected == actual
    print(
        f"  {'ok' if ok else 'FAIL'}: {label} = {actual!r}"
        + ("" if ok else f" (expected {expected!r})")
    )
    if not ok:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


def validator(command: str) -> Draft202012Validator:
    schema = json.loads(
        (MODULE_DIR / MANIFEST["commands"][command]["schema"]).read_text()
    )
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def accepts(command: str, payload: dict) -> bool:
    return not list(validator(command).iter_errors(payload))


# ── 1. Every public command with a payload has a CLOSED schema ────────────────────────────

# Nothing is exempt any more. `schedules.is_open` used to be: its payload carried the rows the
# caller had read, so no closed contract could describe it. Since schedules#1 the rules come from
# the runtime (`reads`) and the payload is just the moment — so it gets a closed schema like
# everything else, and a caller can no longer smuggle in a schedule, nor a `fail_open`.
NO_SCHEMA_ON_PURPOSE: set[str] = set()


def test_every_public_command_declares_a_closed_schema() -> None:
    print("\n· every public command carries a closed schema")
    for name, cmd in MANIFEST["commands"].items():
        short = name.split(".", 1)[1]
        if short.startswith("_") or name in NO_SCHEMA_ON_PURPOSE:
            continue
        rel = cmd.get("schema")
        if not rel:
            failures.append(f"{name}: no `schema` declared")
            print(f"  FAIL: {name} declares no schema")
            continue
        path = MODULE_DIR / rel
        if not path.exists():
            failures.append(f"{name}: schema file {rel} is missing")
            print(f"  FAIL: {name} → {rel} does not exist")
            continue
        schema = json.loads(path.read_text())
        Draft202012Validator.check_schema(schema)
        closed = schema.get("additionalProperties") is False
        print(f"  {'ok' if closed else 'FAIL'}: {name} → {rel} closed = {closed}")
        if not closed:
            failures.append(f"{name}: schema is not closed (additionalProperties)")


# ── 2. The exact payloads the four forms send ─────────────────────────────────────────────

UI_PAYLOADS = {
    # `saveBusinessHours` — a split shift, a closed day, and «open 24 hours».
    "schedules.business_hours.set": [
        {
            "day_of_week": 3,
            "is_closed": False,
            "intervals": [
                {"open_time": "10:00", "close_time": "14:00"},
                {"open_time": "17:00", "close_time": "20:00"},
            ],
        },
        {"day_of_week": 6, "is_closed": True, "intervals": []},
        {
            "day_of_week": 1,
            "is_closed": False,
            "intervals": [{"open_time": "00:00", "close_time": "00:00"}],
        },
    ],
    # `createSpecialDay` — closed, and open with several intervals (schedules#23).
    "schedules.special_days.create": [
        {
            "date": "2026-12-25",
            "name": "Christmas",
            "is_closed": True,
            "open_time": None,
            "close_time": None,
            "intervals": [],
            "recurring_yearly": True,
            "notes": "Closed all day",
        },
        {
            "date": "2026-12-24",
            "name": "Christmas Eve",
            "is_closed": False,
            "open_time": "10:00",
            "close_time": "13:00",
            "intervals": [
                {"open_time": "10:00", "close_time": "13:00"},
                {"open_time": "17:00", "close_time": "19:00"},
            ],
            "recurring_yearly": False,
            "notes": "",
        },
    ],
    # `createOverride` — closed range, and open with several intervals.
    "schedules.overrides.create": [
        {
            "start_date": "2026-08-01",
            "end_date": "2026-08-15",
            "reason": "Holidays",
            "is_closed": True,
            "open_time": None,
            "close_time": None,
            "intervals": [],
        },
        {
            "start_date": "2026-08-01",
            "end_date": "2026-08-31",
            "reason": "Summer",
            "is_closed": False,
            "open_time": "10:00",
            "close_time": "13:30",
            "intervals": [
                {"open_time": "10:00", "close_time": "13:30"},
                {"open_time": "18:00", "close_time": "21:00"},
            ],
        },
    ],
    # `saveSettings`, and the two destructive row actions.
    "schedules.settings.save": [
        {
            "timezone": "Europe/Madrid",
            "week_starts_on": 1,
            "slot_duration": 30,
            "auto_close_enabled": False,
        },
    ],
    "schedules.special_days.delete": [{"special_day_id": "sd1"}],
    "schedules.overrides.delete": [{"override_id": "ov1"}],
    # The assistant / importers path.
    "schedules.bulk_create_special_days": [
        {
            "special_days": [
                {"date": "2026-01-01", "name": "New Year", "is_closed": True},
                {
                    "date": "2026-01-06",
                    "name": "Epiphany",
                    "is_closed": False,
                    "open_time": "10:00",
                    "close_time": "14:00",
                    "recurring_yearly": True,
                    "notes": "half day",
                },
            ]
        },
    ],
}


def test_the_payloads_the_ui_sends_are_accepted() -> None:
    print("\n· the exact payloads of the four forms")
    for command, payloads in UI_PAYLOADS.items():
        for i, payload in enumerate(payloads):
            check(f"{command} accepts UI payload #{i}", True, accepts(command, payload))


# ── 2b. `schedules.is_open` takes the MOMENT and nothing else (schedules#1) ────────────────

IS_OPEN_ACCEPTED = [
    ("nothing at all — «is it open right now»", {}),
    ("an RFC3339 instant", {"when": "2026-08-18T08:00:00Z"}),
    ("an instant with an offset", {"when": "2026-08-18T10:00:00+02:00"}),
    ("the shop's own wall clock", {"when": "2026-08-18T10:00"}),
]

# The rows and the switch the caller used to send. They are refused AT THE DOOR now: the schedule
# is read from the hub (`reads`), and «nothing configured» is the module's answer, not a flag the
# consumer picks — two callers used to get opposite verdicts for the same hub and instant.
IS_OPEN_REFUSED = [
    ("forged weekly hours", {"business_hours": [{"day_of_week": 0}]}),
    ("forged special days", {"special_days": [{"date": "2026-12-25"}]}),
    ("forged overrides", {"overrides": [{"start_date": "2026-08-01"}]}),
    ("forged exception intervals", {"exception_intervals": [{"position": 0}]}),
    ("the `fail_open` switch", {"fail_open": True}),
    ("a `when` that is not a date-time", {"when": "tomorrow"}),
]


def test_is_open_takes_the_moment_and_nothing_else() -> None:
    print("\n· schedules.is_open: only `when`, and the rules come from the hub")
    for label, payload in IS_OPEN_ACCEPTED:
        check(f"is_open accepts {label}", True, accepts("schedules.is_open", payload))
    for label, payload in IS_OPEN_REFUSED:
        check(f"is_open refuses {label}", False, accepts("schedules.is_open", payload))


# ── 3. Violations the schema MUST refuse ──────────────────────────────────────────────────

REFUSED = [
    # schedules#7: the client hint the form used to send. The schema is closed, so it is refused —
    # the duplicate check is an authoritative runtime read, not a list the browser supplies.
    (
        "schedules.special_days.create",
        "the `existing_dates` client hint (schedules#7)",
        {
            "date": "2026-12-25",
            "name": "Christmas",
            "is_closed": True,
            "existing_dates": ["2026-12-25"],
        },
    ),
    (
        "schedules.special_days.create",
        "a misspelled key",
        {"date": "2026-12-25", "name": "Christmas", "recurring": True},
    ),
    ("schedules.special_days.create", "no name", {"date": "2026-12-25"}),
    (
        "schedules.special_days.create",
        "an empty name",
        {"date": "2026-12-25", "name": ""},
    ),
    (
        "schedules.special_days.create",
        "a 25-hour clock",
        {
            "date": "2026-12-25",
            "name": "x",
            "is_closed": False,
            "open_time": "25:00",
            "close_time": "26:00",
        },
    ),
    (
        "schedules.special_days.create",
        "an interval missing its close",
        {
            "date": "2026-12-25",
            "name": "x",
            "is_closed": False,
            "intervals": [{"open_time": "10:00"}],
        },
    ),
    (
        "schedules.special_days.create",
        "13 intervals (the cap is 12)",
        {
            "date": "2026-12-25",
            "name": "x",
            "is_closed": False,
            "intervals": [
                {"open_time": "0%d:00" % (i % 10), "close_time": "0%d:30" % (i % 10)}
                for i in range(13)
            ],
        },
    ),
    (
        "schedules.overrides.create",
        "an unknown key",
        {
            "start_date": "2026-08-01",
            "end_date": "2026-08-15",
            "reason": "x",
            "nope": 1,
        },
    ),
    (
        "schedules.overrides.create",
        "no reason",
        {"start_date": "2026-08-01", "end_date": "2026-08-15"},
    ),
    (
        "schedules.overrides.create",
        "an interval with a malformed hour",
        {
            "start_date": "2026-08-01",
            "end_date": "2026-08-15",
            "reason": "x",
            "intervals": [{"open_time": "9:00", "close_time": "14:00"}],
        },
    ),
    ("schedules.business_hours.set", "a weekday out of range", {"day_of_week": 7}),
    ("schedules.business_hours.set", "no weekday at all", {"is_closed": True}),
    (
        "schedules.business_hours.set",
        "an unknown key",
        {"day_of_week": 0, "intervals": [], "note": "x"},
    ),
    (
        "schedules.settings.save",
        "a slot duration below the floor",
        {"slot_duration": 1},
    ),
    ("schedules.settings.save", "a week starting on day 8", {"week_starts_on": 8}),
    ("schedules.bulk_create_special_days", "an empty batch", {"special_days": []}),
    (
        "schedules.bulk_create_special_days",
        "a batch over 366 items",
        {"special_days": [{"date": "2026-01-01", "name": "x"}] * 367},
    ),
    (
        "schedules.bulk_create_special_days",
        "an item with an unknown key",
        {"special_days": [{"date": "2026-01-01", "name": "x", "colour": "red"}]},
    ),
    ("schedules.special_days.delete", "an empty id", {"special_day_id": ""}),
    ("schedules.overrides.delete", "no id at all", {}),
]


def test_the_violations_are_refused() -> None:
    print("\n· the matrix of refused payloads")
    for command, label, payload in REFUSED:
        check(f"{command} refuses {label}", False, accepts(command, payload))


# ── 4. What the schema does NOT judge, said out loud ──────────────────────────────────────

NOT_THE_SCHEMAS_JOB = [
    (
        "schedules.special_days.create",
        "an impossible calendar date (2026-02-31) — `invalid_date`",
        {"date": "2026-02-31", "name": "Nope", "is_closed": True},
    ),
    (
        "schedules.special_days.create",
        "close before open — `invalid_hours`",
        {
            "date": "2026-12-25",
            "name": "x",
            "is_closed": False,
            "open_time": "14:00",
            "close_time": "10:00",
        },
    ),
    (
        "schedules.special_days.create",
        "two overlapping intervals — `overlapping`",
        {
            "date": "2026-12-25",
            "name": "x",
            "is_closed": False,
            "intervals": [
                {"open_time": "10:00", "close_time": "14:00"},
                {"open_time": "13:00", "close_time": "19:00"},
            ],
        },
    ),
    (
        "schedules.overrides.create",
        "an inverted range — `invalid_range`",
        {
            "start_date": "2026-08-15",
            "end_date": "2026-08-01",
            "reason": "x",
            "is_closed": True,
        },
    ),
    (
        "schedules.overrides.create",
        "open with no hours at all — `missing_hours`",
        {
            "start_date": "2026-08-01",
            "end_date": "2026-08-15",
            "reason": "x",
            "is_closed": False,
        },
    ),
]


def test_the_handlers_rules_are_not_faked_by_the_schema() -> None:
    print(
        "\n· cross-field rules belong to the handler, and the schema does not pretend otherwise"
    )
    for command, label, payload in NOT_THE_SCHEMAS_JOB:
        check(
            f"{command}: schema lets through {label}", True, accepts(command, payload)
        )


def main() -> int:
    test_every_public_command_declares_a_closed_schema()
    test_the_payloads_the_ui_sends_are_accepted()
    test_is_open_takes_the_moment_and_nothing_else()
    test_the_violations_are_refused()
    test_the_handlers_rules_are_not_faked_by_the_schema()
    print()
    if failures:
        print(f"✗ {len(failures)} failure(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("✓ schemas.contract: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
