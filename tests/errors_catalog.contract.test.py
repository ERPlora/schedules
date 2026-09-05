#!/usr/bin/env python3
"""Every domain error this handler can refuse with is DECLARED in the manifest (ADR-0398, #39).

THE SYMPTOM. Ten different refusals — a slot that overlaps another, a special day that already
exists, a range whose end falls before its start — travel to the screen as a stable code so the UI
can say, in the person's language, what went wrong. None of them was written down anywhere. The day
one is renamed or retired nothing breaks visibly: it just stops existing, and whoever was
translating it or showing it is left with a hole that no check reports.

WHY THIS MODULE NEEDS ITS OWN GUARD, WHEN THE TOOLKIT ALREADY HAS ONE. `erplora validate` scans the
handler for literals shaped `"schedules.<snake_case>"` (ADR-0398 says so out loud: the scan is
LEXICAL, and a code built at runtime is invisible to it). This handler never writes that shape. It
builds every code through one helper:

    fn domain(code: &str, message: impl Display) -> DomainError {
        DomainError::new(format!("schedules.{code}"), message.to_string())
    }

so the literal at each call site is the bare `"overlapping"`, not `"schedules.overlapping"`. What
the validator actually found — and reported as «emits 10 domain error code(s)» — are the assertions
inside `#[cfg(test)]`, which DO spell the full code. The two sets happen to agree today. That
agreement is a coincidence, not a mechanism: an eleventh code added without a test asserting its
full string is invisible to the validator, and with the catalog present the runtime is STRICT — the
refusal comes back to the hub as `unexpected` and the person sees nothing useful.

This test closes that gap the only way it can be closed from inside the repo: it reads the
PRODUCTION half of the handler (everything before `#[cfg(test)]`, so a test fixture cannot vote) and
demands that every `domain("…")` call site is declared, and that every declared code carries its
`en` (source) and `es` text — ADR-0055, because the UI translates by code.

And it refuses the one shape that would slip past BOTH guards: a refusal whose code is not a
snake_case literal at the call site — `domain(code, …)`, or a `DomainError::…` built anywhere but
inside the helper. Check 1 cannot read a variable any more than `erplora validate` can, so the rule
is the same one ADR-0127 §1 gives events: the identifier is a literal, or it is an error.

Usage: tests/errors_catalog.contract.test.py   (exit 0 = green)
"""

import json
import pathlib
import re
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())
MODULE_ID = MANIFEST["id"]

# The handler's production half. Everything from `#[cfg(test)]` on is fixtures and assertions: it
# names codes it does not emit, so counting it would let a deleted refusal keep voting for itself.
_SOURCE = (MODULE_DIR / "handler" / "src" / "lib.rs").read_text()
PRODUCTION = _SOURCE.split("#[cfg(test)]")[0]

# ADR-0055: the message lives in the locale catalogue, never in the manifest.
REQUIRED_LOCALES = ("en", "es")


def emitted_codes() -> dict[str, int]:
    """`<module>.<code>` -> line of the `domain("<code>", …)` call that raises it."""
    found: dict[str, int] = {}
    for m in re.finditer(r'\bdomain\(\s*"([a-z][a-z0-9_]*)"', PRODUCTION):
        code = f"{MODULE_ID}.{m.group(1)}"
        found.setdefault(code, PRODUCTION[: m.start()].count("\n") + 1)
    return found


def non_literal_refusals() -> list[tuple[int, str]]:
    """(line, why) for every refusal whose code check 1 cannot read: a `domain(` call whose first
    argument is not a `"snake_case"` literal, or a `DomainError::` constructed outside `fn domain`."""
    found: list[tuple[int, str]] = []
    helper = re.search(r"^fn domain\(.*?^}", PRODUCTION, re.M | re.S)
    helper_span = (helper.start(), helper.end()) if helper else (-1, -1)

    def line_of(pos: int) -> int:
        return PRODUCTION[:pos].count("\n") + 1

    for m in re.finditer(r'(?<!fn )(?<![.\w])domain\((?!\s*"[a-z][a-z0-9_]*")', PRODUCTION):
        found.append((line_of(m.start()), "`domain(` whose code is not a snake_case string literal"))
    for m in re.finditer(r"\bDomainError::", PRODUCTION):
        if helper_span[0] <= m.start() < helper_span[1]:
            continue
        found.append((line_of(m.start()), "`DomainError::` built outside `fn domain`"))
    return sorted(found)


def expect_rows_codes() -> dict[str, str]:
    """`<module>.<code>` -> the command whose `expect_rows` raises it."""
    found: dict[str, str] = {}
    for name, command in (MANIFEST.get("commands") or {}).items():
        code = ((command or {}).get("expect_rows") or {}).get("error")
        if isinstance(code, str):
            found.setdefault(code, name)
    return found


def locale_errors(lang: str) -> dict[str, str]:
    path = MODULE_DIR / "locales" / f"{lang}.json"
    if not path.exists():
        return {}
    section = json.loads(path.read_text()).get("errors")
    return section if isinstance(section, dict) else {}


def main() -> int:
    failures: list[str] = []

    declared = MANIFEST.get("errors")
    if not isinstance(declared, dict):
        print(
            "FAIL: module.json has no `errors` catalog, so every refusal this handler raises is "
            "undeclared and retiring one is invisible (ADR-0398)"
        )
        return 1

    # 1 · Emitted must be declared. This is the half `erplora validate` cannot see here.
    for code, line in sorted(emitted_codes().items()):
        if code not in declared:
            failures.append(
                f"handler/src/lib.rs:{line}: raises `{code}`, which the `errors` catalog does "
                f"not declare (ADR-0398) — with the catalog present the runtime is strict and "
                f"this refusal reaches the hub as `unexpected`"
            )
    for code, command in sorted(expect_rows_codes().items()):
        if code not in declared:
            failures.append(
                f"commands.{command}: `expect_rows.error` raises `{code}`, which the `errors` "
                f"catalog does not declare (ADR-0398)"
            )

    # 1b · Every code is a literal at its call site, or neither this test nor `erplora validate`
    # can see it — and with the catalog present the runtime is strict (ADR-0127 §1 rule).
    for line, why in non_literal_refusals():
        failures.append(
            f"handler/src/lib.rs:{line}: {why} — this refusal is invisible to the catalog guards "
            f"and reaches the hub as `unexpected`; raise it as `domain(\"<snake_case>\", …)`"
        )

    # 2 · Declared must be translatable, source and Spanish (ADR-0055).
    for lang in REQUIRED_LOCALES:
        texts = locale_errors(lang)
        for code in sorted(declared):
            if not isinstance(texts.get(code), str) or not texts[code].strip():
                failures.append(
                    f"locales/{lang}.json: no `errors.{code}` text — the UI translates domain "
                    f"errors by code (ADR-0055)"
                )

    # 3 · A code is `<module>.<snake_case>` and belongs to this module (ADR-0205).
    for code in sorted(declared):
        if not re.fullmatch(rf"{re.escape(MODULE_ID)}\.[a-z][a-z0-9_]*", code):
            failures.append(
                f"errors: `{code}` is not a domain code of this module "
                f"(expected `{MODULE_ID}.<snake_case>`, ADR-0205)"
            )

    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1

    print(
        f"OK: the {len(declared)} declared error code(s) cover every refusal the handler raises, "
        f"and each one reads in {' + '.join(REQUIRED_LOCALES)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
