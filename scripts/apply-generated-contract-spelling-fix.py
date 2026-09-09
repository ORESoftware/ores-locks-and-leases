#!/usr/bin/env python3
"""Apply one deterministic branch-local generator repair, then remove itself."""

from __future__ import annotations

from pathlib import Path

GENERATOR = Path("templates/lib-core/gen_org_locks.py")
SAFETY = Path("scripts/test-generator-safety.sh")
WORKFLOW = Path(".github/workflows/apply-generated-contract-spelling-fix.yml")
SELF = Path(__file__)


def main() -> None:
    generator = GENERATOR.read_text(encoding="utf-8")
    old = (
        '                    "additionalProperties": False,\n'
        '                    "unevaluatedProperties": False,'
    )
    count = generator.count(old)
    if count != 3:
        raise SystemExit(
            f"expected exactly three redundant object-sealing pairs, found {count}"
        )
    GENERATOR.write_text(
        generator.replace(
            old,
            '                    "unevaluatedProperties": False,',
        ),
        encoding="utf-8",
    )

    safety = SAFETY.read_text(encoding="utf-8")
    marker = (
        'git -C "$fixture" show '
        '"$generated_commit:locks/rust/Cargo.toml" \\\n'
        '  | grep -q \'^resolver = "3"$\'\n'
    )
    addition = marker + (
        "# The authored Draft 2020-12 peer must use the same sealing spelling as\n"
        "# TypeSpec Schema B. `additionalProperties: false` is behaviorally redundant\n"
        "# beside `unevaluatedProperties: false`, but TJSV intentionally rejects the\n"
        "# structural mismatch instead of choosing one authority as the winner.\n"
        'git -C "$fixture" show '
        '"$generated_commit:locks/contracts/json-schema/contract.schema.json" \\\n'
        '  | python3 "$repo_root/scripts/check-generated-contract-sealing.py" -\n'
    )
    if safety.count(marker) != 1:
        raise SystemExit("generator-safety insertion marker drifted")
    SAFETY.write_text(safety.replace(marker, addition), encoding="utf-8")

    WORKFLOW.unlink()
    SELF.unlink()


if __name__ == "__main__":
    main()
