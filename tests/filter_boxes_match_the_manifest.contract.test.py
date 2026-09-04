#!/usr/bin/env python3
"""Every filter box this module paints is a filter the manifest actually concedes (hub#1182).

THE SYMPTOM. A column is declared `filterable`, the table draws its funnel, the person opens it and
types — and nothing happens. No error, no empty state, no «that filter did nothing»: the same rows
as before. The runtime is doing what it was told: `run_list` only sends the `f_<col>` parameters the
manifest declares under `list.filters`, and drops the rest on the floor. So a box the component
paints over a column nobody declared is a control that cannot work, and looks exactly like one that
found no matches.

WHY THIS MODULE HAS ONE WITHOUT HAVING BEEN BROKEN. hub#1182 swept seven modules and named five.
`schedules` was not one of them, and reading it column by column confirmed it: the eight filterable
columns of the special days and the overrides are all declared, and each with the operator its
control needs. That is the state today, and today is not the thing worth protecting — nothing stood
between the next edit and the silence. Adding a `filterable` column, renaming one, or tightening a
`list.filters` to «only what we use» all give back the funnel that does nothing, and no test in this
repo said a word about any of them.

The closing rule of hub#1182 is that a filter that does not filter cannot go green again. This is
that rule, for this module.

WHAT IT DOES NOT COVER. The opening-hours table is not `serverSide`: it paginates and filters in the
browser, sends no `f_*` at all, and has nothing to promise the manifest. The discovery skips it by
construction — a table with no controller — and the floor below counts only the ones that do talk to
the runtime.

## The rules, and why each one

| The box says | The manifest must say | Because |
|---|---|---|
| `filterType: 'text'` | `op: 'like'` | a free-text box invites a fragment; `eq` empties the list unless the user types the value whole |
| `filterType: 'select'` | `op: 'eq'` | a closed domain is CHOSEN, and the value chosen is exact — `like` would silently match one value inside another |
| `filterType: 'range'` / `'daterange'` | `op: 'range'` | two bounds need the operator that takes two bounds |
| `filterable: true` | the column IS in `list.filters` | otherwise the runtime drops the `f_<col>` parameter and the box does nothing (hub#1182) |
| `sortable: true` | the column IS in `list.sort` | the sort whitelist is a SECOND door: a header outside it does not sort, silently |

EVERY `filterType` a column can take is checked, not the first one written. A column may pick its
control at render time (`...(this.payMethods.length ? { filterType: 'select' } : { filterType:
'text' })`), and one `op` cannot serve both — `select` needs `eq`, `text` needs `like`. A gate that
reads only the first branch blesses the manifest for the path the user is NOT on, which is exactly
where the half-dead funnel hides. If a column can be two controls, it has to be honest as both, or
be filterable only when it is the one that works.

Usage: tests/filter_boxes_match_the_manifest.contract.test.py   (exit 0 = green)
  No Postgres, no Docker: it reads the manifest and the Web Components.
"""

import json
import pathlib
import re
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))

#: What the manifest has to declare for each kind of box the table paints.
EXPECTED_OP = {
    "text": "like",
    "select": "eq",
    "range": "range",
    "daterange": "range",
}

#: Why each one, in the words the failure message uses.
WHY = {
    "text": "a free-text box invites a FRAGMENT, and only `like` answers one; with anything else the list empties unless the value is typed whole",
    "select": "a closed domain is CHOSEN, so the match is exact; `like` would match the value inside another one",
    "range": "two bounds need the operator that takes two bounds",
    "daterange": "two bounds need the operator that takes two bounds",
}

#: `(query, painted column) -> the filters the screen really writes`. The sales history paints the
#: full timestamp and filters the DAY (`onFilterChange`, sales#125): the range the user asks for is
#: made of days, and sending it to `created_at` would cut «up to today» at 00:00 and answer empty.
#: Declaring the remap here is what keeps it from becoming an undeclared funnel again — the target
#: is checked exactly like a direct column would be.
#:
#: Empty on purpose: no box here writes a key other than its own. If one starts to — a
#: `setFilter(col === 'x' ? 'y' : col)` in the handler — it belongs HERE, or the gate reads the
#: promise the manifest never got asked for.
REMAPPED: dict[tuple[str, str], tuple[str, ...]] = {}

#: `(query, column) -> {filterType: why}`. A column that chooses its control at render time can
#: offer one the manifest's single `op` cannot serve. Skipping it silently is how the half-dead
#: funnel survives a gate, so it is written down instead, with the issue that owns the decision.
#: The entry is checked BOTH ways: if the branch stops existing, the exception is stale and this
#: gate says so, so an allowance cannot outlive the code it was granted for.
#:
#: Empty on purpose: every box this module paints is a control the manifest can serve.
UNSERVED_CONTROLS: dict[tuple[str, str], dict[str, str]] = {}

#: How many SERVER-SIDE list tables this module paints today (the special days, the overrides —
#: the opening hours filter in the browser and promise the manifest nothing). The
#: floor is the check on the check: if the discovery stops finding them, a broken sweep would pass
#: by knowing nothing.
TABLES_TODAY = 2

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def balanced_slice(src: str, open_at: int) -> str:
    """The text from the brace at `open_at` to the one that closes it, brace-counted.

    Cutting on the next `key: '` (what the sibling copies do) hands the LAST column of an array
    everything down to the end of the file — methods, templates and docstrings included — so a
    `filterType: '…'` written in a comment below gets read as that column's (taxes#54).
    """
    depth = 0
    for i in range(open_at, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_at : i + 1]
    return src[open_at:]


def column_getters(src: str) -> dict[str, str]:
    """`getter name -> its body`, for every `private get <name>(): DataTableColumn[]`."""
    bodies = {}
    for m in re.finditer(r"get\s+(\w+)\s*\(\s*\)\s*:\s*DataTableColumn\[\]\s*(\{)", src):
        bodies[m.group(1)] = balanced_slice(src, m.start(2))
    return bodies


def tables(src: str) -> list[tuple[str, str]]:
    """`(query, columns getter)` for every `ok-data-table` the component paints.

    Both halves come from the element itself: `.rows=${this.<field>?.rows}` names the controller,
    and the controller was built with its query. One file with two tables therefore pairs each set
    of columns with ITS query, which is the whole reason this gate exists here.
    """
    controllers = dict(
        re.findall(
            r"this\.(\w+)\s*=\s*createListController[^(]*\(\s*erplora\(\)\s*,\s*'([^']+)'", src
        )
    )
    found = []
    # Cut on the tag, not on `>`: the attributes carry arrow functions and generics
    # (`Record<string, unknown>) =>`), so `[^>]*` stops inside the first one and finds nothing.
    for element in re.split(r"<ok-data-table\b", src)[1:]:
        element = element.split("</ok-data-table>")[0]
        getter = re.search(r"\.columns=\$\{this\.(\w+)\}", element)
        field = re.search(r"\.rows=\$\{this\.(\w+)\??\.rows", element)
        if not getter or not field:
            continue
        query = controllers.get(field.group(1))
        if query is None:
            # A client-side table (no controller) paints no `f_*`: nothing to promise.
            continue
        found.append((query, getter.group(1)))
    return found


def declared_columns(body: str):
    """`(column, filterTypes, filterable, sortable)` for every column the getter returns.

    `filterTypes` is every control the column can render, in source order: one entry for the
    ordinary case, more when the column chooses at render time.
    """
    out = []
    for m in re.finditer(r"key: '([^']+)'", body):
        # The column object is the innermost `{` that is still open at this `key:`.
        start = body.rfind("{", 0, m.start())
        chunk = balanced_slice(body, start) if start != -1 else body[m.start() :]
        out.append(
            (
                m.group(1),
                tuple(dict.fromkeys(re.findall(r"filterType: '(\w+)'", chunk))),
                "filterable: true" in chunk,
                "sortable: true" in chunk,
            )
        )
    return out


def check(screen: pathlib.Path, query: str, columns) -> None:
    spec = (MANIFEST.get("queries") or {}).get(query)
    if spec is None:
        fail(f"{screen} drives `{query}`, which the manifest does not declare")
        return
    block = spec.get("list") or {}
    if not block:
        fail(f"`{query}` has no `list` block, but {screen} paginates it")
        return
    filters = block.get("filters") or {}
    sortable_whitelist = set(block.get("sort") or [])

    for column, kinds, filterable, sortable in columns:
        remap = REMAPPED.get((query, column))
        if remap:
            # The box does not feed its own key: check the columns it really writes instead.
            for target in remap:
                if target not in filters:
                    fail(
                        f"{screen} routes the `{column}` box to `{target}`, which `{query}` does not "
                        f"declare as a filter: the runtime drops `f_{target}` and that choice does nothing"
                    )
        elif filterable and column not in filters:
            fail(
                f"{screen} paints a filter box on `{column}` but `{query}` declares no filter for it: "
                f"the runtime drops the parameter and the box does nothing (hub#1182)"
            )
        elif filterable and not kinds:
            fail(
                f"{screen} paints `{column}` as filterable without a `filterType`: the table cannot "
                f"know what box to draw, and this gate cannot know what `{query}` should promise"
            )
        else:
            op = (filters.get(column) or {}).get("op")
            # Every control the column can render, not just the first one written: one `op` cannot
            # serve a picker AND its text fallback, and the branch that is skipped is where the
            # half-dead funnel hides.
            unserved = UNSERVED_CONTROLS.get((query, column), {})
            for stale in set(unserved) - set(kinds):
                fail(
                    f"{screen} no longer paints `{column}` as `filterType: '{stale}'`, but this gate still "
                    f"excuses that branch: delete the `UNSERVED_CONTROLS` entry — an allowance that "
                    f"outlives its code hides the next one"
                )
            for kind in kinds:
                if kind in unserved:
                    continue
                expected = EXPECTED_OP.get(kind)
                if expected is None:
                    fail(
                        f"{screen} paints `{column}` as `filterType: '{kind}'`, which this gate does not know — teach it"
                    )
                elif op != expected:
                    extra = (
                        f" — and it can also render as {', '.join(repr(k) for k in kinds if k != kind)}, "
                        f"so one `op` cannot serve every branch: make it filterable only where it works"
                        if len(kinds) > 1
                        else ""
                    )
                    fail(
                        f"{screen} paints `{column}` as `filterType: '{kind}'` but `{query}` filters it with "
                        f"`op: {op!r}` (expected `{expected}`) — {WHY[kind]}{extra}"
                    )
        if sortable and column not in sortable_whitelist:
            fail(
                f"{screen} paints `{column}` as sortable but `{query}` does not whitelist it in `list.sort`: "
                f"clicking that header does nothing"
            )


def main() -> int:
    seen = []
    for path in sorted((MODULE_DIR / "ui/components").rglob("*.ts")):
        if path.name.endswith(".test.ts"):
            continue
        src = path.read_text(encoding="utf-8")
        getters = column_getters(src)
        for query, getter in tables(src):
            body = getters.get(getter)
            if body is None:
                fail(
                    f"{path.relative_to(MODULE_DIR)} paints `{query}` with `this.{getter}`, which is not a "
                    f"`DataTableColumn[]` getter of this component: the gate cannot read that table's columns"
                )
                continue
            seen.append((path.relative_to(MODULE_DIR), query, getter))
            check(path.relative_to(MODULE_DIR), query, declared_columns(body))

    if len(seen) < TABLES_TODAY:
        print(
            f"FAIL: only {len(seen)} list table(s) discovered; this module paints at least "
            f"{TABLES_TODAY} (the special days, the overrides). The discovery is broken, and a broken "
            "sweep passes."
        )
        return 1

    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1

    covered = ", ".join(sorted({q for _, q, _ in seen}))
    print(
        f"OK: every filter box and every sortable header of {len(seen)} table(s) matches what "
        f"the manifest concedes ({covered})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
