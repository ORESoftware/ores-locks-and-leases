#!/usr/bin/env python3
"""Check generated lock-catalog Schema A object-sealing spelling.

The TypeSpec JSON Schema emitter seals Draft 2020-12 object models with
`unevaluatedProperties`. Keeping a redundant `additionalProperties: false`
produces the same validation verdicts for these models but a different authored
contract spelling; TJSV correctly stops rather than choosing an authority.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import TextIO

EXPECTED_OBJECTS = ("LockLayers", "LockCatalogEntry", "LockCatalog")


def load(source: str) -> dict[str, object]:
    if source == "-":
        return json.load(sys.stdin)
    return json.loads(Path(source).read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <schema.json|->", file=sys.stderr)
        return 2

    document = load(argv[1])
    definitions = document.get("$defs")
    if not isinstance(definitions, dict):
        print("ERROR: generated schema has no $defs object", file=sys.stderr)
        return 1

    errors: list[str] = []
    for name in EXPECTED_OBJECTS:
        model = definitions.get(name)
        if not isinstance(model, dict):
            errors.append(f"{name}: missing object declaration")
            continue
        if model.get("type") != "object":
            errors.append(f"{name}: expected type=object")
        if "additionalProperties" in model:
            errors.append(
                f"{name}: redundant additionalProperties changes the authored spelling"
            )
        if model.get("unevaluatedProperties") is not False:
            errors.append(f"{name}: expected unevaluatedProperties=false")

    if errors:
        for message in errors:
            print(f"ERROR: {message}", file=sys.stderr)
        return 1

    print(
        "generated contract sealing: PASS "
        f"({', '.join(EXPECTED_OBJECTS)} use unevaluatedProperties=false only)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
