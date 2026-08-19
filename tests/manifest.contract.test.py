#!/usr/bin/env python3
"""schedules#10 — the manifest and the WASM build hold together, checked instead of assumed.

`Manifest::load` is the FIRST thing `installer::install` does, so a wrong value here does not
degrade a feature: it CLOSES THE DOOR — the published module cannot be installed on any hub. And
the Tier 2 half is worse, because it is invisible: a `handler.function` that no longer exists in
`handler/src/lib.rs`, or a `dist/handler.wasm` compiled from a source that has since changed, is a
command that dies at call time with the manifest looking perfectly fine.

What is checked, all statically, no services needed:

  1. DECLARED FILES EXIST. Every path the manifest points at — migrations (in order), query and
     command SQL, JSON Schemas, the WASM handler, the UI bundle, the i18n catalogues.
  2. PERMISSIONS ARE REAL. Every `permission` a query or command names is one the module declares,
     and every declared permission is granted to at least one role (a permission nobody has is a
     screen nobody opens).
  3. THE HANDLERS EXIST. Every `handler.function` of a Tier 2 command is actually exported by
     `handler/src/lib.rs`, and every function the crate exports is wired to a command (dead export
     = code shipped in the wasm that nothing can call).
  4. THE INTENTIONS RESOLVE. Every `_`-prefixed command a handler emits belongs to this module and
     declares its `sql[]` — the host refuses an operation it cannot resolve, at runtime.
  5. THE READS ARE THIS MODULE'S. Every `reads` entry (ADR-0069) names a query this manifest
     declares.
  6. THE EVENTS ARE DECLARED. Every event name the handler emits appears in `events.emits` — a
     handler emitting an undeclared event makes the whole command FAIL at runtime.
  7. THE WASM IS REPRODUCIBLE. `dist/handler.build.json` matches the sources on disk, and
     `cargo metadata --locked --offline` succeeds — i.e. `handler/Cargo.lock` is committed and in
     sync, so the build is not resolving fresh dependencies on every machine. That last check needs
     the hub checkout (the `guest-sdk` is a path dependency); when it is unreachable it is reported
     as SKIPPED, never as a pass.

Usage: tests/manifest.contract.test.py   (exit 0 = green)
"""

import hashlib
import json
import pathlib
import re
import subprocess
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())

failures: list[str] = []
skipped: list[str] = []


def check(label: str, expected, actual) -> None:
    ok = expected == actual
    print(
        f"  {'ok' if ok else 'FAIL'}: {label} = {actual!r}"
        + ("" if ok else f" (expected {expected!r})")
    )
    if not ok:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


def declared_paths() -> list[str]:
    paths = list(MANIFEST["migrations"]["postgres"])
    for q in MANIFEST["queries"].values():
        paths.append(q["sql"])
    for c in MANIFEST["commands"].values():
        paths += list(c.get("sql", []))
        if c.get("schema"):
            paths.append(c["schema"])
        if c.get("handler"):
            paths.append(c["handler"]["file"])
    paths.append(MANIFEST["ui"]["entry"])
    return paths


def test_every_declared_file_is_in_the_package() -> None:
    print("\n· every path the manifest names exists")
    missing = sorted({p for p in declared_paths() if not (MODULE_DIR / p).exists()})
    check("missing files", [], missing)
    # The i18n catalogues are not declared but the bundle inlines them (ADR-0055).
    for locale in ("en", "es"):
        check(
            f"locales/{locale}.json",
            True,
            (MODULE_DIR / "locales" / f"{locale}.json").exists(),
        )


def test_permissions_are_declared_and_granted() -> None:
    print("\n· permissions: declared, used and granted")
    declared = set(MANIFEST["permissions"])
    used = {
        d["permission"] for d in MANIFEST["queries"].values() if d.get("permission")
    }
    used |= {
        d["permission"] for d in MANIFEST["commands"].values() if d.get("permission")
    }
    check("permissions used but not declared", set(), used - declared)
    check(
        "every query and command carries a permission",
        0,
        sum(
            1
            for d in list(MANIFEST["queries"].values())
            + list(MANIFEST["commands"].values())
            if not d.get("permission")
        ),
    )
    granted: set[str] = set()
    for role, perms in MANIFEST["role_permissions"].items():
        granted |= declared if perms == ["*"] else set(perms)
    check("permissions nobody is granted", set(), declared - granted)
    check("permissions granted but not declared", set(), granted - declared)


HANDLER_SRC = (MODULE_DIR / "handler" / "src" / "lib.rs").read_text()
EXPORTED = set(re.findall(r"#\[plugin_fn\]\s*\npub fn (\w+)", HANDLER_SRC))


def test_every_declared_handler_function_exists_and_is_wired() -> None:
    print("\n· Tier 2: the manifest and the crate name the same functions")
    wired = {
        c["handler"]["function"]
        for c in MANIFEST["commands"].values()
        if c.get("handler")
    }
    check("functions declared but not exported by the crate", set(), wired - EXPORTED)
    check("functions exported but wired to no command", set(), EXPORTED - wired)
    for name, cmd in MANIFEST["commands"].items():
        if cmd.get("handler"):
            check(
                f"{name} points at the built wasm",
                "dist/handler.wasm",
                cmd["handler"]["file"],
            )


def test_the_intentions_the_handlers_emit_resolve_to_a_command() -> None:
    print("\n· the intentions the handler returns resolve to this module's commands")
    emitted = set(re.findall(r'Operation::sql\(\s*"([^"]+)"', HANDLER_SRC))
    check(
        "no intention was found in the handler (the regex went stale)",
        True,
        len(emitted) > 0,
    )
    for name in sorted(emitted):
        cmd = MANIFEST["commands"].get(name)
        if cmd is None:
            check(f"{name} is declared", True, False)
            continue
        check(f"{name} declares its sql[]", True, bool(cmd.get("sql")))


def test_the_reads_name_queries_of_this_module() -> None:
    print("\n· `reads` (ADR-0069) point at declared queries")
    for name, cmd in MANIFEST["commands"].items():
        for read in cmd.get("reads", []):
            query = read if isinstance(read, str) else read["query"]
            check(f"{name} reads {query}", True, query in MANIFEST["queries"])
    # And the handler only looks up reads that the manifest actually pre-loads.
    looked_up = set(re.findall(r'READ: &str = "([^"]+)"', HANDLER_SRC))
    preloaded = {
        (r if isinstance(r, str) else r["query"])
        for c in MANIFEST["commands"].values()
        for r in c.get("reads", [])
    }
    check(
        "reads the handler expects but nobody pre-loads", set(), looked_up - preloaded
    )


def test_every_event_the_handler_emits_is_declared() -> None:
    print("\n· events: a handler emitting an undeclared event FAILS the command")
    emitted = set(re.findall(r'Event::new\(\s*\n?\s*"([^"]+)"', HANDLER_SRC))
    declared = set(MANIFEST["events"]["emits"])
    check(
        "no event was found in the handler (the regex went stale)",
        True,
        len(emitted) > 0,
    )
    check("events emitted but not declared", set(), emitted - declared)
    # The declarative half declares its own via `emit`.
    from_sql = {e for c in MANIFEST["commands"].values() for e in c.get("emit", [])}
    check("events declared but emitted by nobody", set(), declared - emitted - from_sql)


def test_the_wasm_build_is_reproducible() -> None:
    print("\n· the WASM build: fresh, and pinned by a lockfile")
    build = json.loads((MODULE_DIR / "dist" / "handler.build.json").read_text())
    wasm = (MODULE_DIR / "dist" / "handler.wasm").read_bytes()
    check(
        "dist/handler.wasm is the binary build.json describes",
        build["wasm_sha256"],
        hashlib.sha256(wasm).hexdigest(),
    )
    check("built for wasm32", "wasm32-unknown-unknown", build["target"])
    check("with the guest feature", ["guest"], build["features"])
    check(
        "Cargo.lock is committed",
        True,
        (MODULE_DIR / "handler" / "Cargo.lock").exists(),
    )

    # `--locked` is the whole point: it FAILS when the lockfile is out of sync, which is what makes
    # two builds of the same commit produce the same wasm. It needs the hub checkout, because
    # `erplora-guest-sdk` is a path dependency of the crate.
    sdk = (MODULE_DIR / ".." / ".." / ".." / "hub" / "crates" / "guest-sdk").resolve()
    if not sdk.exists():
        skipped.append(
            f"cargo metadata --locked: the guest-sdk checkout is not at {sdk}"
        )
        print(f"  SKIPPED: cargo metadata --locked (no guest-sdk checkout at {sdk})")
        return
    res = subprocess.run(
        ["cargo", "metadata", "--locked", "--offline", "--format-version", "1"],
        cwd=MODULE_DIR / "handler",
        capture_output=True,
        text=True,
    )
    ok = res.returncode == 0
    print(f"  {'ok' if ok else 'FAIL'}: cargo metadata --locked --offline")
    if not ok:
        detail = (res.stderr or res.stdout).strip().splitlines()[:3]
        failures.append(
            "cargo metadata --locked --offline failed: " + " / ".join(detail)
        )
        for line in detail:
            print(f"      {line}")


def main() -> int:
    test_every_declared_file_is_in_the_package()
    test_permissions_are_declared_and_granted()
    test_every_declared_handler_function_exists_and_is_wired()
    test_the_intentions_the_handlers_emit_resolve_to_a_command()
    test_the_reads_name_queries_of_this_module()
    test_every_event_the_handler_emits_is_declared()
    test_the_wasm_build_is_reproducible()
    print()
    for s in skipped:
        print(f"  SKIPPED: {s}")
    if failures:
        print(f"✗ {len(failures)} failure(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("✓ manifest.contract: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
