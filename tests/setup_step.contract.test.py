#!/usr/bin/env python3
"""schedules#42 — the onboarding step that asks the business to CONFIRM its opening hours.

Why this file exists. Until appointments#117 the checklist item «Your working hours» was declared
by `appointments`, at slot 101, and it measured that module's OWN hour tables. ADR-0392 made
`schedules` the single authority for the business hours, so those tables stopped being writable
and the step could never be ticked again; #117 removed it. Slot 101 was left with no owner and
`schedules` declares no `setup` block, so whoever sets up a salon today gets NO step asking about
opening hours at all — while the hub happily takes bookings against a week nobody has looked at.

What the step must be, and what this file pins statically (no services needed):

  1. THE STEP EXISTS AND IS THIS MODULE'S. `setup` is declared, its `query` is one this manifest
     declares (the runtime refuses a `setup.query` it cannot resolve), and its SQL file is on disk.

  2. IT LEADS WHERE THE HOURS ARE EDITED. `route` resolves to a navigation entry of THIS module.
     The step it replaces pointed at `/m/appointments/appointments` — an agenda with nothing to
     configure — which is half of why it was useless. A route nobody can act on is a dead step.

  3. THE PERMISSION IS THE ONE THAT CAN ACT. `setup.permission` is declared by the module and
     granted to at least one role. Per `architecture/hub/setup-status.md` §6 it is deliberately
     narrower than the permission to READ: an employee who can only look at the hours must not be
     handed a task they cannot finish.

  4. IT TAKES THE SLOT THAT WAS FREED, NOT A NEW ONE. `order` 101 is the hole appointments left
     (§6, «Los huecos reservados»); the scale belongs to the core and a module does not invent a
     position for itself. `required: false` — 🟡 recommended, because the seed of schedules#36
     means the business is never left WITHOUT hours: confirming them is important, not blocking.

  5. THE CONTRACT CAN PASS. Every `configured_when` check carries a `field` and EXACTLY ONE of
     `truthy` / `equals`; with neither, the runtime's evaluator returns false forever
     (`setup-status.md` §6) and the step would be permanently pending — a checklist item nobody
     can ever complete, which is worse than no item at all.

  6. IT SPEAKS SPANISH TOO. `title`/`description` are canonical English in the manifest (ADR-0055)
     AND translated in `locales/es.json` under `setup`, with the Spanish actually different from
     the English — a catalogue that copies the English string is an untranslated screen that
     passes a presence check.

Usage: tests/setup_step.contract.test.py   (exit 0 = green)
"""

import json
import pathlib
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())

# The slot `appointments` freed when ADR-0392 moved the hours here (appointments#117). The scale is
# the core's: `architecture/hub/setup-status.md` §6.
FREED_SLOT = 101

failures: list[str] = []


def check(label: str, expected, actual) -> None:
    if expected == actual:
        print(f"  ok: {label} = {expected!r}")
    else:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")
        print(f"  FAIL: {label} — expected {expected!r}, got {actual!r}")


def setup_block() -> dict:
    return MANIFEST.get("setup") or {}


def test_the_step_is_declared_and_reads_this_module() -> None:
    print("\n1. the step exists and asks THIS module:")
    setup = setup_block()
    check("module.json declares a `setup` block", True, bool(setup))
    if not setup:
        return

    name = setup.get("query")
    queries = MANIFEST.get("queries") or {}
    check("`setup.query` is declared by this manifest", True, name in queries)
    if name in queries:
        rel = queries[name].get("sql")
        check(
            f"the SQL of `{name}` is on disk",
            True,
            bool(rel) and (MODULE_DIR / rel).exists(),
        )
        # A `list` wrapper paginates and sorts; `hub.setup.status` reads `rows.first()` of the base
        # SELECT. Declaring one here would mean the step is measured by a screen's list contract.
        check(f"`{name}` is not a paginated list", False, "list" in queries[name])


def test_the_route_leads_to_a_screen_of_this_module() -> None:
    print("\n2. the route leads where the hours are edited:")
    setup = setup_block()
    route = setup.get("route")
    check("`setup.route` is declared", True, bool(route))
    if not route:
        return

    entries = [n["id"] for n in MANIFEST.get("navigation") or []]
    allowed = [f"/m/{MANIFEST['id']}/{nav}" for nav in entries]
    check(
        f"`{route}` is one of this module's screens ({', '.join(allowed)})",
        True,
        route in allowed,
    )


def test_the_permission_is_one_that_can_finish_the_step() -> None:
    print("\n3. the permission is the one that can act:")
    setup = setup_block()
    permission = setup.get("permission")
    declared = MANIFEST.get("permissions") or []
    check("`setup.permission` is declared", True, bool(permission))
    if not permission:
        return

    check(f"`{permission}` is a permission of this module", True, permission in declared)
    granted = {
        p
        for perms in (MANIFEST.get("role_permissions") or {}).values()
        for p in (declared if perms == ["*"] else perms)
    }
    check(f"`{permission}` is granted to at least one role", True, permission in granted)
    # Reading the week is not finishing the step: the item is only offered to whoever can save it.
    read_only = (MANIFEST.get("role_permissions") or {}).get("employee") or []
    check("a view-only role is not handed the task", False, permission in read_only)


def test_it_takes_the_slot_appointments_freed() -> None:
    print("\n4. it takes the freed slot, at the level the seed makes honest:")
    setup = setup_block()
    check("`order` is the slot appointments left free", FREED_SLOT, setup.get("order"))
    check("the step is recommended (🟡), not functional", False, setup.get("required"))


def test_the_contract_can_ever_pass() -> None:
    print("\n5. the contract is one that can be satisfied:")
    setup = setup_block()
    checks = setup.get("configured_when") or []
    check("`configured_when` carries at least one check", True, len(checks) > 0)
    for i, c in enumerate(checks):
        check(f"check #{i} names a field", True, bool(c.get("field")))
        # `field` + neither `truthy` nor `equals` never passes: the step would stay pending forever.
        check(
            f"check #{i} carries exactly one of truthy/equals",
            1,
            ("truthy" in c) + ("equals" in c),
        )


def test_the_step_is_translated() -> None:
    print("\n6. the step speaks Spanish too:")
    setup = setup_block()
    for field in ("title", "description"):
        english = setup.get(field)
        check(f"the manifest carries the canonical English `{field}`", True, bool(english))
        for locale in ("en", "es"):
            path = MODULE_DIR / "locales" / f"{locale}.json"
            catalogue = json.loads(path.read_text()).get("setup") or {}
            check(
                f"locales/{locale}.json translates the step `{field}`",
                True,
                bool(catalogue.get(field)),
            )
        spanish = (
            json.loads((MODULE_DIR / "locales" / "es.json").read_text()).get("setup") or {}
        ).get(field)
        # Presence is not translation: a catalogue that echoes the English string leaves the
        # checklist in English for every Spanish hub while passing a "the key exists" check.
        check(
            f"the Spanish `{field}` is not the English one",
            True,
            bool(spanish) and spanish != english,
        )


def main() -> int:
    for test in (
        test_the_step_is_declared_and_reads_this_module,
        test_the_route_leads_to_a_screen_of_this_module,
        test_the_permission_is_one_that_can_finish_the_step,
        test_it_takes_the_slot_appointments_freed,
        test_the_contract_can_ever_pass,
        test_the_step_is_translated,
    ):
        test()

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("all green — the onboarding step is declared, routed, permissioned and translated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
