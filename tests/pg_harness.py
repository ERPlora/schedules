"""Shared plumbing for the module's Postgres tests — the runtime, in miniature.

Runs the manifest's own SQL against a REAL Postgres 18 in Docker (the `erplora-test-pg-5433`
container of the workspace), building a scratch database from this module's own migrations and
DROPPING it at the end, pass or fail. Same harness as the ones in `staff/tests/` and
`services/tests/` (each module is its own repo, so it travels with the module).

What is reproduced of the dispatcher, and only that:
  * `:name` placeholders bound as literals in ONE pass (a value carrying a colon — an ISO
    timestamp — is never rescanned);
  * params absent from the payload bind as NULL (`DynNull`, crates/db/src/lib.rs);
  * the portable helper `erp_date(x)` is rewritten to its Postgres form, like `crates/db` does;
  * a command's `sql[]` runs inside one BEGIN/COMMIT with the system params (`hub_id`,
    `current_user_id`, `now`, one `new_id` per statement) injected;
  * `run_command` returns the rows AFFECTED by the command's `sql[]`, so a test can check the
    `expect_rows` gate the way the runtime evaluates it (sum of affected rows vs `n`);
  * `apply_seed` runs the manifest's `seed.postgres` block the way `apply_module_seed` does
    (crates/runtime/src/seed.rs): after the migrations, statement by statement, with `:hub_id`,
    `:now` and `:current_user_id` = `system` bound — the seed is written by the installer, not by
    a person. Idempotency is the SQL's own job there and here: the runtime adds no guard.

What is NOT reproduced, on purpose:
  * JSON Schema validation of the payload — that is `tests/schemas.contract.test.py`, statically,
    against the module's own schemas;
  * the WASM handlers. A Tier 2 command has no `sql[]`: it returns INTENTIONS (the `_`-prefixed
    commands) that the host validates and runs. So the handler's DECISIONS are pinned by the Rust
    unit tests in `handler/src/lib.rs` (which assert the exact command + params of every
    operation), and THIS file runs those very intentions against a real database. The seam is
    named in each test that crosses it.
"""

import json
import os
import pathlib
import re
import subprocess
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
CONTAINER = os.environ.get("SCHEDULES_TEST_PG_CONTAINER", "erplora-test-pg-5433")
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())

HUB = "hub-under-test"
OTHER_HUB = "hub-next-door"
USER = "u-owner"
# What `apply_module_seed` binds as `:current_user_id`: «la semilla la escribe el sistema, no un
# usuario» (crates/runtime/src/seed.rs).
SEED_USER = "system"
NOW = "2026-08-18T10:00:00Z"

PARAM = re.compile(r":([a-z_][a-z0-9_]*)", re.IGNORECASE)


def container_available() -> bool:
    try:
        subprocess.run(
            ["docker", "inspect", CONTAINER], capture_output=True, check=True, text=True
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


ERP_DATE = re.compile(r"\berp_date\(([^()]*)\)")
ERP_DOW_MON0 = re.compile(r"\berp_dow_mon0\(([^()]*)\)")


def rewrite_portable_helpers(sql: str) -> str:
    """The Postgres form of the portable date helpers the runtime rewrites (`crates/db/src/lib.rs`,
    ADR-0007 §4a): `erp_date(x)` → `((x)::date)`; `erp_dow_mon0(x)` → ISODOW - 1 (0 = Monday).
    This module writes no helper today; the rewriter stays so the day a query needs one the
    harness does not silently ship raw `erp_date(` to Postgres."""
    sql = ERP_DATE.sub(lambda m: f"(({m.group(1)})::date)", sql)
    return ERP_DOW_MON0.sub(
        lambda m: f"((EXTRACT(ISODOW FROM ({m.group(1)})::timestamptz)::int) - 1)", sql
    )


def bind(sql: str, params: dict) -> str:
    return rewrite_portable_helpers(
        PARAM.sub(lambda m: literal(params.get(m.group(1))), sql)
    )


class DomainError(Exception):
    """What the runtime answers when a command's `expect_rows` gate rejects: the transaction is
    rolled back (nothing written, no event) and the module-declared code surfaces (hub#139)."""

    def __init__(self, code: str, affected: int):
        super().__init__(f"{code} (affected rows: {affected})")
        self.code = code
        self.affected = affected


def _affected_rows(psql_output: str) -> int:
    """Sum the command tags psql prints (`INSERT 0 1`, `UPDATE 3`) — the runtime's `sql_counts`."""
    total = 0
    for line in psql_output.splitlines():
        m = re.fullmatch(r"(INSERT \d+|UPDATE|DELETE) (\d+)", line.strip())
        if m:
            total += int(m.group(2))
    return total


class ScratchDb:
    """A throwaway database built from the manifest's Postgres migrations."""

    def __init__(self, prefix: str):
        self.name = f"{prefix}_{os.getpid()}"

    def psql(
        self, args: list[str], db: str | None = None, stdin: str | None = None
    ) -> str:
        cmd = [
            "docker",
            "exec",
            "-i",
            CONTAINER,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
        ]
        if db:
            cmd += ["-d", db]
        cmd += args
        res = subprocess.run(cmd, input=stdin, capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(res.stderr.strip() or res.stdout.strip())
        return res.stdout

    def create(self, upto: int | None = None) -> None:
        """Build the database from the declared migrations, in order. `upto` stops after the Nth
        one — that is how the backfill of a migration is tested: seed the OLD world, then apply
        the migration on top, exactly as a live hub does."""
        self.psql(["-c", f'DROP DATABASE IF EXISTS "{self.name}"'])
        self.psql(["-c", f'CREATE DATABASE "{self.name}"'])
        for rel in MANIFEST["migrations"]["postgres"][:upto]:
            self.psql([], db=self.name, stdin=(MODULE_DIR / rel).read_text())

    def migrate(self, index: int) -> None:
        """Apply ONE more declared migration (0-based) on the existing database."""
        rel = MANIFEST["migrations"]["postgres"][index]
        self.psql([], db=self.name, stdin=(MODULE_DIR / rel).read_text())

    def apply_seed(self, hub: str = HUB, now: str = NOW) -> None:
        """Apply the manifest's `seed.postgres` block, like `apply_module_seed` does after
        migrating: every declared file, with `:hub_id`/`:now`/`:current_user_id` bound. A module
        with no `seed` block is a no-op, exactly as the installer treats it."""
        for rel in MANIFEST.get("seed", {}).get("postgres", []):
            sql = (MODULE_DIR / rel).read_text()
            self.psql(
                [],
                db=self.name,
                stdin=bind(
                    sql, {"hub_id": hub, "now": now, "current_user_id": SEED_USER}
                ),
            )

    def drop(self) -> None:
        try:
            self.psql(["-c", f'DROP DATABASE IF EXISTS "{self.name}" WITH (FORCE)'])
        except RuntimeError as exc:
            print(f"  ! could not drop {self.name}: {exc}")

    def scalar(self, sql: str) -> str:
        return self.psql(["-tAc", sql], db=self.name).strip()

    def rows(self, sql: str) -> list[dict]:
        out = self.psql(
            ["-tAc", f"SELECT COALESCE(json_agg(t), '[]'::json) FROM ({sql}) t"],
            db=self.name,
        )
        return json.loads(out.strip() or "[]")

    def run_command(self, name: str, payload: dict, hub: str = HUB) -> int:
        """Execute a manifest command's `sql[]` the way the runtime does: one transaction, the
        system params injected, and — when the command declares `expect_rows` — the gate applied
        on the sum of affected rows: below `n` the transaction ROLLS BACK and `DomainError` is
        raised with the declared code. Returns the affected rows when it commits."""
        cmd = MANIFEST["commands"][name]
        if "sql" not in cmd:
            raise AssertionError(
                f"`{name}` is a Tier 2 command (WASM handler): it has no `sql[]`. Run the "
                f"INTENTIONS it returns (the `_`-prefixed commands) — the handler's own unit "
                f"tests in handler/src/lib.rs pin which ones, with which params."
            )
        params = dict(payload)
        params.setdefault("hub_id", hub)
        params.setdefault("current_user_id", USER)
        params.setdefault("now", NOW)
        script = ["BEGIN;"]
        for rel in cmd["sql"]:
            stmt_params = dict(params)
            stmt_params.setdefault("new_id", str(uuid.uuid4()))
            script.append(bind((MODULE_DIR / rel).read_text(), stmt_params))
        # Decide inside the transaction, like `execute_tx_gated`: count first, then commit or roll back.
        out = self.psql([], db=self.name, stdin="\n".join(script + ["ROLLBACK;"]))
        affected = _affected_rows(out)
        gate = cmd.get("expect_rows")
        if (
            gate is not None
            and gate.get("op", "min") == "min"
            and affected < int(gate["n"])
        ):
            raise DomainError(gate["error"], affected)
        self.psql([], db=self.name, stdin="\n".join(script + ["COMMIT;"]))
        return affected

    def run_intents(self, ops: list[tuple[str, dict]], hub: str = HUB) -> int:
        """Run a WASM handler's operations the way `persist_handler_output` does: every intention
        of the batch resolved to the SQL of its own module's command and executed in ONE
        transaction. `ops` is the `[(command, params)]` the handler returned."""
        script = ["BEGIN;"]
        for name, params in ops:
            cmd = MANIFEST["commands"][name]
            p = dict(params)
            p.setdefault("hub_id", hub)
            p.setdefault("current_user_id", USER)
            p.setdefault("now", NOW)
            for rel in cmd["sql"]:
                stmt = dict(p)
                stmt.setdefault("new_id", str(uuid.uuid4()))
                script.append(bind((MODULE_DIR / rel).read_text(), stmt))
        out = self.psql([], db=self.name, stdin="\n".join(script + ["COMMIT;"]))
        return _affected_rows(out)

    def run_query(
        self, name: str, params: dict | None = None, hub: str = HUB
    ) -> list[dict]:
        """Execute a manifest query's base SELECT (no list wrapper) and return rows as dicts."""
        q = MANIFEST["queries"][name]
        p = dict(params or {})
        p.setdefault("hub_id", hub)
        sql = (MODULE_DIR / q["sql"]).read_text().rstrip().rstrip(";")
        return self.rows(bind(sql, p))


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


# ── The runtime's setup-check evaluator, in miniature (schedules#42) ──────────────────────
#
# Mirrors `truthy` / `passes` / `is_configured` in hub/crates/runtime/src/setup_status.rs. It lives
# in the harness, not in one battery, because the checklist step and the Hours screen's «these are
# default hours» banner are TWO READINGS OF THE SAME STATE and must never drift: whoever asserts
# one has to be able to assert the other in the same breath.
#
# What is under test through these helpers is the DECLARED CONTRACT — the query AND its
# `configured_when` — not the SELECT on its own: a query that answers perfectly under a
# `configured_when` that can never pass is still a step nobody ever gets to tick.


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


def setup_rows(db, hub: str = HUB) -> list[dict]:
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


def screen_calls_the_week_ours(rows: list[dict]) -> bool:
    """`weekIsUnconfirmed` from `erp-schedules-hours.ts`, over the rows the SCREEN reads
    (`schedules.business_hours.list`): «there are rows and the installer wrote every one of them».

    The banner and the checklist step answer the same question — «has a person settled these
    hours?» — through two different code paths, so a test that pins one without the other lets
    them drift apart, which is a hub that either nags about a week it was given or stays silent
    about a week nobody chose."""
    return bool(rows) and all(r.get("created_by") == SEED_USER for r in rows)
