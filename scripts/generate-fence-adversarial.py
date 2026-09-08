#!/usr/bin/env python3
"""Generate the deterministic cross-runtime fencing adversarial corpus.

The generator deliberately uses a tiny specified SplitMix64 implementation
rather than Python's random module, so the same seed is stable across Python
versions and can be replayed from a CI receipt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
from dataclasses import dataclass
from typing import Any

MASK64 = (1 << 64) - 1
DEFAULT_SEED = 0x4F5245534C4F434B  # ASCII-ish "ORESLOCK"
DEFAULT_RANDOM_CASES = 128
MAX_TOKEN = MASK64


@dataclass
class SplitMix64:
    state: int

    def next(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return (z ^ (z >> 31)) & MASK64


def digest(label: str) -> str:
    return hashlib.sha256(label.encode("utf-8")).hexdigest()


def request(
    token: int,
    operation: str,
    payload: str,
    *,
    tenant: str = "tenant/acme",
    resource: str = "example/jobs/rebuild",
    holder: str | None = "worker-a",
    lease: str | None = "lease-a",
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "tenantScope": tenant,
        "resourceKey": resource,
        "fencingToken": str(token),
        "operationId": operation,
        "payloadSha256": payload,
    }
    if holder is not None:
        value["holder"] = holder
    if lease is not None:
        value["leaseId"] = lease
    return value


def decision(
    current: dict[str, Any] | None,
    incoming: dict[str, Any],
) -> dict[str, Any]:
    if current is None:
        token = incoming["fencingToken"]
        return {
            "kind": "advanced",
            "shouldApply": True,
            "incomingToken": token,
            "currentToken": token,
            "previousToken": None,
        }
    if (
        current["tenantScope"] != incoming["tenantScope"]
        or current["resourceKey"] != incoming["resourceKey"]
    ):
        return {"error": "identity_mismatch"}
    old = int(current["fencingToken"])
    new = int(incoming["fencingToken"])
    if new > old:
        kind = "advanced"
        apply = True
        current_token = str(new)
    elif new < old:
        kind = "stale"
        apply = False
        current_token = str(old)
    elif (
        current["operationId"] == incoming["operationId"]
        and current["payloadSha256"] == incoming["payloadSha256"]
    ):
        kind = "replay"
        apply = False
        current_token = str(old)
    else:
        kind = "token_reuse"
        apply = False
        current_token = str(old)
    return {
        "kind": kind,
        "shouldApply": apply,
        "incomingToken": str(new),
        "currentToken": current_token,
        "previousToken": str(old),
    }


def token_cases(rng: SplitMix64) -> list[dict[str, Any]]:
    boundaries = [
        0,
        1,
        9,
        10,
        99,
        100,
        (1 << 32) - 1,
        (1 << 53) - 1,
        1 << 53,
        (1 << 53) + 1,
        (1 << 63) - 1,
        1 << 63,
        (1 << 63) + 1,
        MAX_TOKEN - 1,
        MAX_TOKEN,
    ]
    cases = [
        {
            "name": f"valid-token-{index:03d}",
            "value": str(value),
            "expected": {"ok": True, "canonical": str(value)},
        }
        for index, value in enumerate(boundaries)
    ]
    for index in range(16):
        value = rng.next()
        cases.append(
            {
                "name": f"valid-random-token-{index:03d}",
                "value": str(value),
                "expected": {"ok": True, "canonical": str(value)},
            }
        )
    invalid = [
        "",
        "00",
        "01",
        "+1",
        "-1",
        " 1",
        "1 ",
        "\t1",
        "1\n",
        "1.0",
        "1e3",
        "1E3",
        "٠",
        "０",
        "¹",
        "1\u0000",
        "18446744073709551616",
        "99999999999999999999",
        "000000000000000000001",
        "not-a-token",
    ]
    cases.extend(
        {
            "name": f"invalid-token-{index:03d}",
            "value": value,
            "expected": {"ok": False, "error": "invalid_fencing_token"},
        }
        for index, value in enumerate(invalid)
    )
    return cases


def request_cases() -> list[dict[str, Any]]:
    good = digest("request-good")
    base = request(1, "op-1", good)

    def case(
        name: str,
        changes: dict[str, Any],
        *,
        ok: bool = False,
        error: str | None = None,
    ) -> dict[str, Any]:
        incoming = dict(base)
        incoming.update(changes)
        expected: dict[str, Any] = {"ok": ok}
        if error is not None:
            expected["error"] = error
        return {"name": name, "incoming": incoming, "expected": expected}

    return [
        case(
            "valid-ascii-byte-boundaries",
            {
                "tenantScope": "t" * 256,
                "operationId": "o" * 128,
                "holder": "h" * 256,
                "leaseId": "l" * 256,
            },
            ok=True,
        ),
        case(
            "valid-two-byte-utf8-boundaries",
            {
                "tenantScope": "é" * 128,
                "operationId": "é" * 64,
                "holder": "é" * 128,
                "leaseId": "é" * 128,
            },
            ok=True,
        ),
        case(
            "valid-four-byte-utf8-tenant-boundary",
            {"tenantScope": "🙂" * 64},
            ok=True,
        ),
        case("tenant-empty", {"tenantScope": ""}, error="empty_field"),
        case("tenant-ascii-overlong", {"tenantScope": "t" * 257}, error="too_long"),
        case(
            "tenant-two-byte-utf8-overlong",
            {"tenantScope": "é" * 129},
            error="too_long",
        ),
        case(
            "tenant-four-byte-utf8-overlong",
            {"tenantScope": "🙂" * 65},
            error="too_long",
        ),
        case("operation-empty", {"operationId": ""}, error="empty_field"),
        case(
            "operation-ascii-overlong",
            {"operationId": "o" * 129},
            error="too_long",
        ),
        case(
            "operation-two-byte-utf8-overlong",
            {"operationId": "é" * 65},
            error="too_long",
        ),
        case("holder-empty-is-not-absence", {"holder": ""}, error="empty_field"),
        case("holder-overlong", {"holder": "é" * 129}, error="too_long"),
        case("lease-empty-is-not-absence", {"leaseId": ""}, error="empty_field"),
        case("lease-overlong", {"leaseId": "🙂" * 65}, error="too_long"),
        case(
            "payload-too-short",
            {"payloadSha256": "a" * 63},
            error="invalid_payload_sha256",
        ),
        case(
            "payload-too-long",
            {"payloadSha256": "a" * 65},
            error="invalid_payload_sha256",
        ),
        case(
            "payload-uppercase",
            {"payloadSha256": "A" * 64},
            error="invalid_payload_sha256",
        ),
        case(
            "payload-non-hex",
            {"payloadSha256": "g" * 64},
            error="invalid_payload_sha256",
        ),
    ]


def decision_cases(rng: SplitMix64, random_cases: int) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    explicit = [
        (None, 0, "first-zero"),
        (0, 1, "zero-to-one"),
        ((1 << 53) - 1, 1 << 53, "js-safe-boundary"),
        (1 << 53, (1 << 53) + 1, "js-unsafe-neighbor"),
        ((1 << 63) - 1, 1 << 63, "signed-boundary"),
        (MAX_TOKEN - 1, MAX_TOKEN, "uint64-maximum"),
        (MAX_TOKEN, MAX_TOKEN - 1, "stale-below-maximum"),
    ]
    for index, (old, new, label) in enumerate(explicit):
        incoming = request(new, f"op-{label}-new", digest(f"{label}-new"))
        current = (
            None
            if old is None
            else request(old, f"op-{label}-old", digest(f"{label}-old"))
        )
        cases.append(
            {
                "name": f"boundary-{index:03d}-{label}",
                "current": current,
                "incoming": incoming,
                "expected": decision(current, incoming),
            }
        )

    for index in range(random_cases):
        current_token = rng.next()
        selector = rng.next() % 7
        if selector == 0:
            incoming_token = current_token
        elif selector == 1:
            incoming_token = (current_token + 1) & MASK64
        elif selector == 2:
            incoming_token = (current_token - 1) & MASK64
        elif selector == 3:
            incoming_token = rng.next()
        elif selector == 4:
            incoming_token = 1 << 53
        elif selector == 5:
            incoming_token = 1 << 63
        else:
            incoming_token = MAX_TOKEN

        op_current = f"op-{index:04d}-{rng.next():016x}"
        payload_current = digest(f"current:{index}:{rng.next()}")
        same_op = bool(rng.next() & 1)
        same_payload = bool(rng.next() & 1)
        op_incoming = (
            op_current
            if same_op
            else f"op-next-{index:04d}-{rng.next():016x}"
        )
        payload_incoming = (
            payload_current
            if same_payload
            else digest(f"incoming:{index}:{rng.next()}")
        )
        current = request(
            current_token,
            op_current,
            payload_current,
            holder=f"worker-{rng.next():016x}",
            lease=f"lease-{rng.next():016x}",
        )
        incoming = request(
            incoming_token,
            op_incoming,
            payload_incoming,
            holder=f"worker-{rng.next():016x}",
            lease=f"lease-{rng.next():016x}",
        )
        if index % 29 == 0:
            current["tenantScope"] = "tenant/other"
        elif index % 31 == 0:
            current["resourceKey"] = "example/jobs/other"
        expected = decision(current, incoming)
        item: dict[str, Any] = {
            "name": f"generated-{index:04d}",
            "current": current,
            "incoming": incoming,
        }
        if "error" in expected:
            item["expectedError"] = expected["error"]
        else:
            item["expected"] = expected
        cases.append(item)
    return cases


def build(seed: int, random_cases: int) -> dict[str, Any]:
    if not 1 <= random_cases <= 100_000:
        raise ValueError("random case count must be in 1..100000")
    rng = SplitMix64(seed & MASK64)
    tokens = token_cases(rng)
    requests = request_cases()
    decisions = decision_cases(rng, random_cases)
    return {
        "$comment": (
            "Deterministic adversarial fencing corpus. Generated; edit "
            "scripts/generate-fence-adversarial.py, not this file."
        ),
        "schema": "ores.locks.fence-adversarial/v1",
        "generator": "splitmix64-v1",
        "seed": f"0x{seed & MASK64:016x}",
        "randomDecisionCases": random_cases,
        "counts": {
            "tokenCases": len(tokens),
            "requestCases": len(requests),
            "decisionCases": len(decisions),
            "total": len(tokens) + len(requests) + len(decisions),
        },
        "tokenCases": tokens,
        "requestCases": requests,
        "decisionCases": decisions,
    }


def smoke_profile(value: dict[str, Any]) -> dict[str, Any]:
    """Keep a small checked-in corpus for direct per-runtime smoke tests."""
    selected_tokens = [
        value["tokenCases"][0],
        value["tokenCases"][8],
        value["tokenCases"][14],
        value["tokenCases"][31],
        value["tokenCases"][32],
        value["tokenCases"][47],
    ]
    selected_requests = [
        value["requestCases"][1],
        value["requestCases"][5],
        value["requestCases"][10],
        value["requestCases"][11],
        value["requestCases"][16],
    ]
    selected_decisions = value["decisionCases"][:8]
    result = dict(value)
    result["profile"] = "smoke"
    result["tokenCases"] = selected_tokens
    result["requestCases"] = selected_requests
    result["decisionCases"] = selected_decisions
    result["counts"] = {
        "tokenCases": len(selected_tokens),
        "requestCases": len(selected_requests),
        "decisionCases": len(selected_decisions),
        "total": len(selected_tokens) + len(selected_requests) + len(selected_decisions),
    }
    return result


def canonical_bytes(value: dict[str, Any]) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    ).encode("utf-8")


def parse_seed(value: str) -> int:
    try:
        parsed = int(value, 0)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"invalid seed: {value}") from error
    if not 0 <= parsed <= MASK64:
        raise argparse.ArgumentTypeError("seed must fit uint64")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=parse_seed, default=DEFAULT_SEED)
    parser.add_argument("--cases", type=int, default=DEFAULT_RANDOM_CASES)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--check", type=pathlib.Path)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    if (args.output is None) == (args.check is None):
        parser.error("provide exactly one of --output or --check")
    corpus = build(args.seed, args.cases)
    if args.smoke:
        corpus = smoke_profile(corpus)
    payload = canonical_bytes(corpus)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(payload)
        return 0
    assert args.check is not None
    try:
        actual = args.check.read_bytes()
    except FileNotFoundError:
        print(f"missing generated corpus: {args.check}", file=sys.stderr)
        return 1
    if actual != payload:
        smoke = "--smoke " if args.smoke else ""
        print(
            f"generated corpus drift: rerun {pathlib.Path(__file__).name} "
            f"--seed 0x{args.seed:016x} --cases {args.cases} "
            f"{smoke}--output {args.check}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
