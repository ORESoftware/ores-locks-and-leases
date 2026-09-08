#!/usr/bin/env python3
"""Write a machine-readable cross-runtime fencing conformance receipt."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib


def parse_result(value: str) -> tuple[str, str]:
    name, separator, status = value.partition("=")
    if not separator or not name or not status:
        raise argparse.ArgumentTypeError("results must be NAME=STATUS")
    return name, status


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--mode", choices=("pull_request", "main", "scheduled", "local"), required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--result", action="append", type=parse_result, default=[])
    args = parser.parse_args()

    raw = args.corpus.read_bytes()
    corpus = json.loads(raw)
    checks = {name: status for name, status in args.result}
    required = {"rust", "go", "typescript", "dart", "gleam", "persistence", "contracts"}
    missing = sorted(required - checks.keys())
    unsuccessful = sorted(name for name, status in checks.items() if status != "success")
    passed = not missing and not unsuccessful

    receipt = {
        "schema": "ores.locks.fence-adversarial-receipt/v1",
        "status": "passed" if passed else "stopped_for_evaluation",
        "mode": args.mode,
        "revision": args.revision,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "corpus": {
            "path": args.corpus.as_posix(),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "schema": corpus.get("schema"),
            "generator": corpus.get("generator"),
            "seed": corpus.get("seed"),
            "randomDecisionCases": corpus.get("randomDecisionCases"),
            "counts": corpus.get("counts"),
        },
        "checks": checks,
        "missingChecks": missing,
        "unsuccessfulChecks": unsuccessful,
        "zeroUnexplainedMismatches": passed,
        "authority": {
            "typeSpec": "contracts/typespec/main.tsp",
            "jsonSchema": "contracts/json-schema/contract.schema.json",
            "precedence": "none",
            "generatedCorpusIsAuthority": False,
        },
        "datastoreBoundary": {
            "postgres": "watermark admission and protected mutation share one transaction",
            "redis": "watermark and protected state share one validated script and cluster slot",
            "crossStoreAtomicityClaimed": False,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
