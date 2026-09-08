# Conformance corpus

Every language slice reads these files in its tests. Add a case here first; a
slice that disagrees fails.

- `cases/advisory-key.json` — string key → FNV-1a 64 (unsigned) → signed
  `bigint`. Integers are strings so a JSON parser with 53-bit doubles cannot
  round them.
- `cases/lock-plan.json` — `(layers, pgScope, wait)` → ordered steps.
- `cases/fence-decision.json` — the compact reviewed decision corpus used by
  the normal language matrix.

The adversarial workflow generates a larger deterministic fencing corpus into
`target/adversarial/`, then temporarily projects it onto
`cases/fence-decision.json` inside the exact-head CI checkout so all five
language suites and both datastore adapters consume the same generated input.
Generated evidence is retained as an artifact and is never an editable contract
authority.

Generate and reproduce a pull-request corpus locally:

```sh
node scripts/generate-fence-adversarial.mjs \
  --profile pr \
  --output target/adversarial/fence-decision.json \
  --receipt target/adversarial/pr-receipt.json
node scripts/generate-fence-adversarial.mjs \
  --profile pr \
  --output target/adversarial/fence-decision.json \
  --check
```

Generate the larger scheduled corpus:

```sh
node scripts/generate-fence-adversarial.mjs \
  --profile scheduled \
  --output target/adversarial/fence-decision.json \
  --receipt target/adversarial/scheduled-receipt.json
```

Regenerate the advisory-key vectors (never edit the numbers by hand):

```python
def fnv1a64(s: str) -> int:
    h = 0xcbf29ce484222325
    for b in s.encode("utf-8"):
        h = ((h ^ b) * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return h


def advisory(s: str) -> int:
    u = fnv1a64(s)
    return u - (1 << 64) if u >= (1 << 63) else u
```
