#!/usr/bin/env python3
"""Fail closed when critical lock/fencing paths lack formal classification."""

from __future__ import annotations

import sys
import tomllib
from pathlib import Path

ALLOWED_RISKS = {"critical", "high", "medium", "low"}
ALLOWED_STATUSES = {"planned", "modeling", "active", "deferred"}


def nonempty_strings(value: object, *, allow_empty: bool = False) -> bool:
    return isinstance(value, list) and (allow_empty or bool(value)) and all(
        isinstance(item, str) and item.strip() for item in value
    )


def main() -> int:
    errors: list[str] = []
    path = Path("formal/coverage.toml")
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"could not parse {path}: {exc}", file=sys.stderr)
        return 1

    if data.get("schema_version") != 1:
        errors.append("schema_version must equal 1")
    if data.get("repository") != "ORESoftware/ores-locks-and-leases":
        errors.append("repository identity is incorrect")

    policy = data.get("policy", {})
    statuses = set(policy.get("statuses", []))
    claims = set(policy.get("claim_classes", []))
    if statuses != ALLOWED_STATUSES:
        errors.append("policy.statuses must enumerate the supported status vocabulary")
    if not claims:
        errors.append("policy.claim_classes must be non-empty")
    if not isinstance(policy.get("counterexamples"), str) or not policy["counterexamples"].strip():
        errors.append("policy.counterexamples must be non-empty")

    targets = data.get("target", [])
    if not isinstance(targets, list) or not targets:
        errors.append("at least one [[target]] is required")
        targets = []

    ids: set[str] = set()
    classified_sources: set[str] = set()
    for index, target in enumerate(targets, 1):
        prefix = f"target[{index}]"
        target_id = target.get("id")
        if not isinstance(target_id, str) or not target_id.strip() or target_id in ids:
            errors.append(f"{prefix}.id must be non-empty and unique")
        else:
            ids.add(target_id)
        if target.get("risk") not in ALLOWED_RISKS:
            errors.append(f"{prefix}.risk is invalid")
        status = target.get("status")
        if status not in ALLOWED_STATUSES:
            errors.append(f"{prefix}.status is invalid")
        target_claims = target.get("claim_classes")
        if not nonempty_strings(target_claims):
            errors.append(f"{prefix}.claim_classes must be non-empty")
        elif not set(target_claims).issubset(claims):
            errors.append(f"{prefix}.claim_classes contains an undeclared claim")

        for key in ("source_paths", "bounds", "assumptions"):
            if not nonempty_strings(target.get(key)):
                errors.append(f"{prefix}.{key} must be a non-empty string list")
        evidence = target.get("evidence_paths")
        if not nonempty_strings(evidence, allow_empty=True):
            errors.append(f"{prefix}.evidence_paths must be a string list")
        if status in {"modeling", "active"} and not evidence:
            errors.append(f"{prefix}.evidence_paths is required for {status} status")

        for source in target.get("source_paths", []):
            classified_sources.add(source)
            if not Path(source).exists():
                errors.append(f"{prefix} source path does not exist: {source}")
        for evidence_path in evidence or []:
            if not Path(evidence_path).exists():
                errors.append(f"{prefix} evidence path does not exist: {evidence_path}")

    required_sources = {
        "src/rust/fence.rs",
        "src/rust/plan.rs",
        "src/rust/lease.rs",
        "src/rust/coordinated.rs",
        "src/rust/maintained.rs",
        "persistence/postgres/fencing.sql",
        "persistence/redis/fenced-write.lua",
        "src/go/fence.go",
        "src/go/maintained.go",
        "src/ts/src/fence.ts",
        "src/ts/src/maintained.ts",
        "src/dart/lib/src/fence.dart",
        "src/dart/lib/src/maintained.dart",
        "src/gleam/src/ores_locks_and_leases/fence.gleam",
        "src/gleam/src/ores_locks_and_leases/maintained.gleam",
    }
    for source in sorted(required_sources - classified_sources):
        errors.append(f"critical source has no formal classification: {source}")

    if errors:
        print("\n".join(f"error: {error}" for error in errors), file=sys.stderr)
        return 1
    print(f"Validated {len(targets)} formal targets and {len(classified_sources)} source paths.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
