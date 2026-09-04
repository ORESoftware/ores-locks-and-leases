# Conformance corpus

Every language slice reads these files in its tests. Add a case here first;
a slice that disagrees fails.

- `cases/advisory-key.json` — string key → FNV-1a 64 (unsigned) → signed
  `bigint`. Integers are strings so a JSON parser with 53-bit doubles cannot
  round them.
- `cases/lock-plan.json` — `(layers, pgScope, wait)` → ordered steps.

Regenerate the key vectors (never edit the numbers by hand):

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
