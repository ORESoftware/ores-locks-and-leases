#!/usr/bin/env python3
"""Generate (or refresh) an org's `locks/` package inside its `*-lib-core`.

    gen_org_locks.py --repo ~/codes/fanwaave/fanwaave-lib-core --org fanwaave --prefix fanwaave \
                     [--branch feat/ores-locks-and-leases] [--commit] [--stdout]

The `locks/` package is a nested zed package that wraps
ORESoftware/ores-locks-and-leases with the org's key prefix and lock catalog,
in every runtime the fleet's lib-cores ship: Rust, TypeScript, Dart, Gleam and
Go. It also carries the org's lock catalog as a dual TypeSpec + JSON Schema
contract (ores-contracts), and depends on the org's `*-interfaces` package so
the catalog can reference shared interface types as it grows.

Two modes:

* default — write the files into the working tree (for a clean checkout).
* `--commit` — never touch the working tree: build a tree from `HEAD` plus the
  generated files with a temporary index, commit it, and point `--branch` at
  the commit. Safe on a dirty checkout or one parked on another branch, which
  is how most `~/codes` repos are found. Push the branch and open a PR after.

Idempotent: running twice produces the same files; the root `.zpkg.toml` gets
the two dependency lines added once.

Python 3.10+, standard library only (no tomllib: the manifest edit is textual).
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

SHARED_PACKAGE_ORG = "oresoftware"
SHARED_NAME = "ores-locks-and-leases"
SHARED_REQ = "^0.1.0"
SHARED_GIT = "https://github.com/ORESoftware/ores-locks-and-leases.git"
SHARED_TAG = "v0.1.0"
VENDOR = "../.vendor/.zed/oresoftware/ores-locks-and-leases/src"

# The catalog every org starts with. Orgs add their own rows to
# locks/catalog.json; the generator re-emits every runtime from it.
DEFAULT_CATALOG = [
    {
        "domain": "migrations",
        "name": "apply",
        "layers": {"fiducia": True, "pgAdvisory": True},
        "pgScope": "session",
        "wait": False,
        "description": "One migration runner at a time. Session scope because some DDL cannot run inside a transaction; fail fast so a second runner exits instead of queueing.",
    },
    {
        "domain": "jobs",
        "name": "singleton:{job}",
        "layers": {"fiducia": True, "pgAdvisory": True},
        "pgScope": "transaction",
        "wait": False,
        "description": "A named job that must not overlap itself across replicas. Skip the run when it is already held.",
    },
    {
        "domain": "outbox",
        "name": "drain",
        "layers": {"fiducia": False, "pgAdvisory": True},
        "pgScope": "transaction",
        "wait": False,
        "description": "Transactional-outbox drainer: single-database exclusion is enough, and the transaction that reads the batch is the one that holds the lock.",
    },
    {
        "domain": "tenant",
        "name": "{tenant_id}/mutate",
        "layers": {"fiducia": True, "pgAdvisory": True},
        "pgScope": "transaction",
        "wait": True,
        "description": "Serialize mutations of one tenant's aggregate across every server that can write it. Waits; contention here is normal.",
    },
]


def entry_ident(e: dict, style: str) -> str:
    """Identifier for a catalog entry: <domain>_<name without placeholders>."""
    return ident(e["domain"] + "_" + e["name"].replace("{", "").replace("}", ""), style)


def camel(s: str) -> str:
    return re.sub(r"_(\w)", lambda m: m.group(1).upper(), s)


def ident(prefix: str, style: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", prefix)
    parts = [p for p in parts if p]
    if style == "snake":
        return "_".join(p.lower() for p in parts)
    if style == "pascal":
        return "".join(p[:1].upper() + p[1:] for p in parts)
    if style == "kebab":
        return "-".join(p.lower() for p in parts)
    raise ValueError(style)


def render(org: str, prefix: str, catalog: list[dict], interfaces_name: str) -> dict[str, str]:
    package_org = org.lower()
    snake = ident(prefix, "snake")
    pascal = ident(prefix, "pascal")
    kebab = ident(prefix, "kebab")
    domains = sorted({row["domain"] for row in catalog})
    files: dict[str, str] = {}

    files["locks/catalog.json"] = json.dumps(
        {
            "$comment": f"{org} lock catalog. `name` may contain {{placeholders}} filled by callers. Every runtime slice under locks/ is generated from this file by ORESoftware/ores-locks-and-leases/templates/lib-core/gen_org_locks.py — edit here, then re-run.",
            "org": org,
            "prefix": prefix,
            "entries": catalog,
        },
        indent=2,
    ) + "\n"

    files["locks/.zpkg.toml"] = f'''[package]
org = "{package_org}"
name = "{kebab}-locks"
version = "0.1.0"
description = "{org} lock routines: ORESoftware/ores-locks-and-leases (fiducia lease around a Postgres advisory lock) wrapped with the {org} key prefix and lock catalog"
license = "MIT"
keywords = ["lock", "lease", "postgres", "fiducia", "polyglot"]

[package.repository]
vcs = "git"
url = "https://github.com/{org}/{prefix}-lib-core"

# The shared routines, and the org's interfaces so catalog entries can
# reference shared types (tenant ids, job names) instead of bare strings.
[dependencies]
"{SHARED_PACKAGE_ORG}/{SHARED_NAME}" = "{SHARED_REQ}"
"{package_org}/{interfaces_name}" = "^0.1.0"
"{SHARED_PACKAGE_ORG}/ores-contracts" = "^0.1.0"

[install]
dir = ".vendor/.zed"

[targets.rust]
dir = "rust"
adapter = "rust"

[targets.typescript]
dir = "typescript"
adapter = "node"

[targets.dart]
dir = "dart"
adapter = "dart"

[targets.gleam]
dir = "gleam"
adapter = "none"

[targets.golang]
dir = "golang"
adapter = "none"

[scripts]
test = "npx --yes --package=https://github.com/ORESoftware/ores-contracts/archive/f79ea8d8d94d7a9e78c15f7e46ecae8e4b584d2e.tar.gz ores-contracts check --config contracts/contracts.config.json"
'''

    entry_rows = "\n".join(
        f"| `{e['domain']}` | `{e['name']}` | fiducia={str(e['layers']['fiducia']).lower()} pg={str(e['layers']['pgAdvisory']).lower()} | {e['pgScope']} | {str(e['wait']).lower()} | {e['description']} |"
        for e in catalog
    )
    files["locks/README.md"] = f'''# {prefix}-locks

Lock routines for **{org}**, wrapping
[`ORESoftware/ores-locks-and-leases`](https://github.com/ORESoftware/ores-locks-and-leases)
— a fiducia-cloud lease around a Postgres advisory lock, each layer
switchable, fencing tokens threaded through — with this org's key prefix and
lock catalog. One nested zed package, five runtimes:

| Path | Package |
| --- | --- |
| `rust` | `{kebab}-locks` crate |
| `typescript` | `@{org.lower()}/locks` |
| `dart` | `{snake}_locks` |
| `gleam` | `{snake}_locks` |
| `golang` | `github.com/{org}/{prefix}-lib-core/locks/golang` |

Every key this org locks is `{org}/<domain>/<name>`; the prefix is applied
by `key(domain, name)` in each runtime so two orgs sharing a database cannot
collide, and `advisory_key` is the shared FNV-1a derivation so every runtime
locks the same `bigint`.

## Catalog

`catalog.json` is the source; each runtime's constants are generated from it
(`gen_org_locks.py` in the shared repo's `templates/lib-core`). Add a row
there, re-run, commit the result.

| domain | name | layers | pg scope | wait | purpose |
| --- | --- | --- | --- | --- | --- |
{entry_rows}

The catalog is also a contract: `contracts/typespec/main.tsp` and
`contracts/json-schema/contract.schema.json` are the dual authorities checked
by `npx ores-contracts check --config contracts/contracts.config.json`.

## Resolving the shared package

`.zpkg.toml` declares the dependency; run `zed install` from `locks/` to vendor
it under `locks/.vendor/.zed/oresoftware/ores-locks-and-leases`. The Rust crate pins the
shared crate by git tag and Go by module path, so they resolve without the
vendor step; TypeScript, Dart and Gleam point at the vendored slice.
'''

    # --- contracts ------------------------------------------------------------
    domain_enum_tsp = "\n".join(f"  {ident(d, 'snake')}: \"{d}\"," for d in domains)
    files["locks/contracts/typespec/main.tsp"] = f'''// {org} lock catalog — TypeSpec authority. Peer of
// ../json-schema/contract.schema.json (ORESoftware/ores-contracts); neither is
// generated from the other. The lock vocabulary itself (LockLayers, PgScope,
// LockStep, LockErrorKind) is owned by ORESoftware/ores-locks-and-leases.

@doc("{org} lock catalog: the named locks this org takes, with their default layers and scope.")
namespace {pascal}.Locks;

@doc("The lock domains this org uses; a key is `{org}/<domain>/<name>`.")
enum LockDomain {{
{domain_enum_tsp}
}}

@doc("Whether the fiducia lease and/or the Postgres advisory lock are engaged for an entry.")
model LockLayers {{
  fiducia: boolean;
  pgAdvisory: boolean;
}}

@doc("Postgres advisory-lock scope: inside a transaction the routine commits, or on one dedicated session with no transaction.")
enum PgScope {{
  transaction: "transaction",
  session: "session",
}}

@doc("One catalog row. `name` may contain {{placeholders}} callers fill in.")
model LockCatalogEntry {{
  domain: LockDomain;
  @maxLength(256)
  name: string;
  layers: LockLayers;
  pgScope: PgScope;
  @doc("true: block up to the wait budget; false: fail fast with `contention`.")
  wait: boolean;
  description: string;
}}

@doc("The catalog: `locks/catalog.json` conforms to this.")
model LockCatalog {{
  @maxLength(64)
  org: string;
  @maxLength(64)
  prefix: string;
  entries: LockCatalogEntry[];
}}
'''

    files["locks/contracts/json-schema/contract.schema.json"] = json.dumps(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"https://github.com/{org}/{prefix}-lib-core/locks/contracts/json-schema/contract.schema.json",
            "$comment": f"{org} lock catalog — JSON Schema authority. Peer of ../typespec/main.tsp (ORESoftware/ores-contracts); neither is generated from the other.",
            "x-ores-namespace": f"{pascal}.Locks",
            "$defs": {
                "LockDomain": {
                    "type": "string",
                    "enum": domains,
                    "description": f"The lock domains this org uses; a key is `{org}/<domain>/<name>`.",
                },
                "LockLayers": {
                    "type": "object",
                    "additionalProperties": False,
                    "description": "Whether the fiducia lease and/or the Postgres advisory lock are engaged for an entry.",
                    "properties": {"fiducia": {"type": "boolean"}, "pgAdvisory": {"type": "boolean"}},
                    "required": ["fiducia", "pgAdvisory"],
                },
                "PgScope": {
                    "type": "string",
                    "enum": ["transaction", "session"],
                    "description": "Postgres advisory-lock scope: inside a transaction the routine commits, or on one dedicated session with no transaction.",
                },
                "LockCatalogEntry": {
                    "type": "object",
                    "additionalProperties": False,
                    "description": "One catalog row. `name` may contain {placeholders} callers fill in.",
                    "properties": {
                        "domain": {"$ref": "#/$defs/LockDomain"},
                        "name": {"type": "string", "maxLength": 256},
                        "layers": {"$ref": "#/$defs/LockLayers"},
                        "pgScope": {"$ref": "#/$defs/PgScope"},
                        "wait": {"type": "boolean", "description": "true: block up to the wait budget; false: fail fast with `contention`."},
                        "description": {"type": "string"},
                    },
                    "required": ["domain", "name", "layers", "pgScope", "wait", "description"],
                },
                "LockCatalog": {
                    "type": "object",
                    "additionalProperties": False,
                    "description": "The catalog: `locks/catalog.json` conforms to this.",
                    "properties": {
                        "org": {"type": "string", "maxLength": 64},
                        "prefix": {"type": "string", "maxLength": 64},
                        "entries": {"type": "array", "items": {"$ref": "#/$defs/LockCatalogEntry"}},
                    },
                    "required": ["org", "prefix", "entries"],
                },
            },
        },
        indent=2,
    ) + "\n"

    files["locks/contracts/contracts.config.json"] = json.dumps(
        {
            "$comment": "ores-contracts: both authorities are human-authored peers. Run from locks/: `npx ores-contracts check --config contracts/contracts.config.json`.",
            "typespec": "contracts/typespec/main.tsp",
            "jsonSchema": "contracts/json-schema/contract.schema.json",
            "out": "generated",
            "target": "target/ores-contracts",
            "artifacts": ["rust/types.rs", "typescript/types.d.ts", "typescript/validate.mjs", "dart/models.dart"],
            "tspCompile": True,
        },
        indent=2,
    ) + "\n"

    # --- rust ------------------------------------------------------------------
    rust_domains = "\n".join(f"    {ident(d, 'pascal')}," for d in domains)
    rust_domain_str = "\n".join(f"            Self::{ident(d, 'pascal')} => \"{d}\"," for d in domains)
    rust_entries = "\n".join(
        f'''    /// {e['description']}
    pub const {entry_ident(e, 'snake').upper()}: Entry = Entry {{
        domain: Domain::{ident(e['domain'], 'pascal')},
        name: "{e['name']}",
        layers: LockLayers {{ fiducia: {str(e['layers']['fiducia']).lower()}, pg_advisory: {str(e['layers']['pgAdvisory']).lower()} }},
        pg_scope: PgScope::{'Transaction' if e['pgScope'] == 'transaction' else 'Session'},
        wait: {str(e['wait']).lower()},
    }};'''
        for e in catalog
    )
    files["locks/rust/Cargo.toml"] = f'''[package]
name = "{kebab}-locks"
version = "0.1.0"
edition = "2024"
rust-version = "1.85"
license = "MIT"
description = "{org} lock routines: ores-locks-and-leases with the {org} key prefix and lock catalog"
repository = "https://github.com/{org}/{prefix}-lib-core"

[lib]
path = "lib.rs"

[features]
default = []
pg = ["ores-locks-and-leases/pg"]
fiducia = ["ores-locks-and-leases/fiducia"]
full = ["pg", "fiducia"]

[dependencies]
ores-locks-and-leases = {{ git = "{SHARED_GIT}", tag = "{SHARED_TAG}" }}

[lints.rust]
unsafe_code = "forbid"
'''
    files["locks/rust/lib.rs"] = f'''//! {org} lock routines.
//!
//! Re-exports [`ores_locks_and_leases`] and adds the org's key prefix and lock
//! catalog. Every key this crate builds is `{org}/<domain>/<name>`.
//! Generated from `../catalog.json` by ores-locks-and-leases'
//! `templates/lib-core/gen_org_locks.py`; edit the catalog, not this file.

pub use ores_locks_and_leases::*;

/// This org's key prefix.
pub const ORG: &str = "{org}";

/// The lock domains this org uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Domain {{
{rust_domains}
}}

impl Domain {{
    pub fn as_str(self) -> &'static str {{
        match self {{
{rust_domain_str}
        }}
    }}
}}

/// Build `{org}/<domain>/<name>`.
pub fn key(domain: Domain, name: &str) -> Result<LockKey, key::InvalidLockKey> {{
    LockKey::new(format!("{{ORG}}/{{}}/{{name}}", domain.as_str()))
}}

/// One catalog row: the defaults a call site should use for a named lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {{
    pub domain: Domain,
    /// May contain `{{placeholders}}`; see [`Entry::key`].
    pub name: &'static str,
    pub layers: LockLayers,
    pub pg_scope: PgScope,
    pub wait: bool,
}}

impl Entry {{
    /// The key for this entry with `{{placeholders}}` filled from `fill`, in
    /// order of appearance.
    pub fn key(&self, fill: &[&str]) -> Result<LockKey, key::InvalidLockKey> {{
        let mut name = String::new();
        let mut rest = self.name;
        let mut fills = fill.iter();
        while let Some(open) = rest.find('{{') {{
            name.push_str(&rest[..open]);
            let after = &rest[open..];
            let close = after.find('}}').map(|i| i + 1).unwrap_or(after.len());
            name.push_str(fills.next().copied().unwrap_or(""));
            rest = &after[close..];
        }}
        name.push_str(rest);
        key(self.domain, &name)
    }}

    /// The plan this entry's defaults produce.
    pub fn plan(&self) -> LockPlan {{
        plan(self.layers, self.pg_scope, self.wait)
    }}
}}

/// The catalog, as constants.
pub mod catalog {{
    use super::*;

{rust_entries}
}}

#[cfg(test)]
mod tests {{
    use super::*;

    #[test]
    fn keys_carry_the_org_prefix() {{
        let k = key(Domain::{ident(domains[0], 'pascal')}, "x").unwrap();
        assert!(k.as_str().starts_with("{org}/{domains[0]}/"));
    }}

    #[test]
    fn placeholders_are_filled_in_order() {{
        let entry = Entry {{
            domain: Domain::{ident(domains[0], 'pascal')},
            name: "{{a}}/x/{{b}}",
            layers: LockLayers::BOTH,
            pg_scope: PgScope::Transaction,
            wait: true,
        }};
        assert_eq!(entry.key(&["1", "2"]).unwrap().as_str(), "{org}/{domains[0]}/1/x/2");
        assert_eq!(entry.plan().steps.first(), Some(&LockStep::FiduciaAcquire));
    }}
}}
'''

    # --- typescript ------------------------------------------------------------
    ts_domains = " | ".join(f'"{d}"' for d in domains)
    ts_entries = ",\n".join(
        f'''  /** {e['description']} */
  {entry_ident(e, 'snake')}: {{ domain: "{e['domain']}", name: "{e['name']}", layers: {{ fiducia: {str(e['layers']['fiducia']).lower()}, pgAdvisory: {str(e['layers']['pgAdvisory']).lower()} }}, pgScope: "{e['pgScope']}", wait: {str(e['wait']).lower()} }}'''
        for e in catalog
    )
    files["locks/typescript/package.json"] = json.dumps(
        {
            "name": f"@{org.lower()}/locks",
            "version": "0.1.0",
            "description": f"{org} lock routines: @oresoftware/locks-and-leases with the {org} key prefix and lock catalog",
            "license": "MIT",
            "type": "module",
            "main": "./dist/index.js",
            "types": "./dist/index.d.ts",
            "files": ["dist"],
            "scripts": {
                "build:shared": f"npm --prefix {VENDOR}/ts ci --no-audit --no-fund && npm --prefix {VENDOR}/ts run build",
                "build": "npm run build:shared && tsc -p tsconfig.json",
                "test": "npm run build && node --test test/*.test.mjs",
            },
            "dependencies": {"@oresoftware/locks-and-leases": f"file:{VENDOR}/ts"},
            "devDependencies": {"typescript": "^5.4.0"},
        },
        indent=2,
    ) + "\n"
    files["locks/typescript/tsconfig.json"] = json.dumps(
        {
            "compilerOptions": {
                "target": "ES2022",
                "module": "NodeNext",
                "moduleResolution": "NodeNext",
                "lib": ["ES2022"],
                "declaration": True,
                "strict": True,
                "outDir": "dist",
                "rootDir": "src",
                "types": [],
            },
            "include": ["src/**/*.ts"],
        },
        indent=2,
    ) + "\n"
    files["locks/typescript/src/index.ts"] = f'''/**
 * {org} lock routines. Re-exports `@oresoftware/locks-and-leases` and adds
 * the org's key prefix and lock catalog. Generated from `../catalog.json`
 * by ores-locks-and-leases' `templates/lib-core/gen_org_locks.py`.
 */
import {{ lockKey, plan, type LockKey, type LockLayers, type LockPlan, type PgScope }} from "@oresoftware/locks-and-leases";

export * from "@oresoftware/locks-and-leases";

/** This org's key prefix. */
export const ORG = "{org}";

/** The lock domains this org uses. */
export type Domain = {ts_domains};

/** Build `{org}/<domain>/<name>`. */
export function key(domain: Domain, name: string): LockKey {{
  return lockKey(`${{ORG}}/${{domain}}/${{name}}`);
}}

/** One catalog row: the defaults a call site should use for a named lock. */
export interface Entry {{
  readonly domain: Domain;
  /** May contain `{{placeholders}}`; see `entryKey`. */
  readonly name: string;
  readonly layers: LockLayers;
  readonly pgScope: PgScope;
  readonly wait: boolean;
}}

/** The key for `entry` with `{{placeholders}}` filled from `fill`, in order of appearance. */
export function entryKey(entry: Entry, ...fill: string[]): LockKey {{
  let i = 0;
  return key(entry.domain, entry.name.replace(/\\{{[^}}]*\\}}/g, () => fill[i++] ?? ""));
}}

/** The plan an entry's defaults produce. */
export function entryPlan(entry: Entry): LockPlan {{
  return plan(entry.layers, entry.pgScope, entry.wait);
}}

/** The catalog, as constants. */
export const catalog = {{
{ts_entries},
}} as const satisfies Record<string, Entry>;
'''
    files["locks/typescript/test/catalog.test.mjs"] = f'''import assert from "node:assert/strict";
import {{ test }} from "node:test";
import {{ ORG, catalog, entryKey, entryPlan, key }} from "../dist/index.js";

test("keys carry the org prefix", () => {{
  assert.equal(key("{domains[0]}", "x"), "{org}/{domains[0]}/x");
  assert.equal(ORG, "{org}");
}});

test("placeholders are filled in order and every entry plans", () => {{
  assert.equal(entryKey({{ domain: "{domains[0]}", name: "{{a}}/x/{{b}}", layers: {{ fiducia: true, pgAdvisory: true }}, pgScope: "transaction", wait: true }}, "1", "2"), "{org}/{domains[0]}/1/x/2");
  for (const entry of Object.values(catalog)) assert.ok(entryPlan(entry).steps.includes("work"));
}});
'''

    # --- dart ------------------------------------------------------------------
    dart_domains = ",\n".join(f"  {ident(d, 'snake').replace('_', '')}('{d}')" for d in domains)
    dart_entries = "\n\n".join(
        f'''  /// {e['description']}
  static const {camel(entry_ident(e, 'snake'))} = Entry(
    domain: Domain.{ident(e['domain'], 'snake').replace('_', '')},
    name: '{e['name']}',
    layers: LockLayers(fiducia: {str(e['layers']['fiducia']).lower()}, pgAdvisory: {str(e['layers']['pgAdvisory']).lower()}),
    pgScope: PgScope.{e['pgScope']},
    wait: {str(e['wait']).lower()},
  );'''
        for e in catalog
    )
    files["locks/dart/pubspec.yaml"] = f'''name: {snake}_locks
description: "{org} lock routines: ores_locks_and_leases with the {org} key prefix and lock catalog."
version: 0.1.0
repository: https://github.com/{org}/{prefix}-lib-core
publish_to: none

environment:
  sdk: ">=3.3.0 <4.0.0"

dependencies:
  ores_locks_and_leases:
    path: {VENDOR}/dart

dev_dependencies:
  lints: ^4.0.0
  test: ^1.25.0
'''
    files["locks/dart/analysis_options.yaml"] = "include: package:lints/recommended.yaml\n"
    files[f"locks/dart/lib/{snake}_locks.dart"] = f'''/// {org} lock routines. Re-exports `ores_locks_and_leases` and adds the
/// org's key prefix and lock catalog. Generated from `../catalog.json` by
/// ores-locks-and-leases' `templates/lib-core/gen_org_locks.py`.
library;

import 'package:ores_locks_and_leases/ores_locks_and_leases.dart';

export 'package:ores_locks_and_leases/ores_locks_and_leases.dart';

/// This org's key prefix.
const String org = '{org}';

/// The lock domains this org uses.
enum Domain {{
{dart_domains};

  final String wire;
  const Domain(this.wire);
}}

/// Build `{org}/<domain>/<name>`.
LockKey key(Domain domain, String name) => LockKey('$org/${{domain.wire}}/$name');

/// One catalog row: the defaults a call site should use for a named lock.
final class Entry {{
  final Domain domain;

  /// May contain `{{placeholders}}`; see [key].
  final String name;
  final LockLayers layers;
  final PgScope pgScope;
  final bool wait;

  const Entry({{
    required this.domain,
    required this.name,
    required this.layers,
    required this.pgScope,
    required this.wait,
  }});

  /// The key for this entry with `{{placeholders}}` filled from [fill], in order of appearance.
  LockKey key(List<String> fill) {{
    var i = 0;
    final filled = name.replaceAllMapped(
      RegExp(r'\\{{[^}}]*\\}}'),
      (_) => i < fill.length ? fill[i++] : '',
    );
    return LockKey('$org/${{domain.wire}}/$filled');
  }}

  /// The plan this entry's defaults produce.
  LockPlan get plan => planFor(layers, pgScope, wait);
}}

LockPlan planFor(LockLayers layers, PgScope scope, bool wait) =>
    plan(layers, scope, wait);

/// The catalog, as constants.
abstract final class Catalog {{
{dart_entries}
}}
'''
    files["locks/dart/test/catalog_test.dart"] = f'''import 'package:{snake}_locks/{snake}_locks.dart';
import 'package:test/test.dart';

void main() {{
  test('keys carry the org prefix', () {{
    expect(key(Domain.{ident(domains[0], 'snake').replace('_', '')}, 'x').value, '{org}/{domains[0]}/x');
  }});

  test('placeholders are filled in order', () {{
    const entry = Entry(
      domain: Domain.{ident(domains[0], 'snake').replace('_', '')},
      name: '{{a}}/x/{{b}}',
      layers: LockLayers.both,
      pgScope: PgScope.transaction,
      wait: true,
    );
    expect(entry.key(['1', '2']).value, '{org}/{domains[0]}/1/x/2');
    expect(entry.plan.steps.first, LockStep.fiduciaAcquire);
  }});
}}
'''

    # --- gleam -----------------------------------------------------------------
    gleam_domains = "\n".join(f"  {ident(d, 'pascal')}" for d in domains)
    gleam_domain_str = "\n".join(f"    {ident(d, 'pascal')} -> \"{d}\"" for d in domains)
    gleam_entries = "\n\n".join(
        f'''/// {e['description']}
pub const {entry_ident(e, 'snake')} = Entry(
  domain: {ident(e['domain'], 'pascal')},
  name: "{e['name']}",
  layers: locks.Layers(fiducia: {e['layers']['fiducia']}, pg_advisory: {e['layers']['pgAdvisory']}),
  pg_scope: locks.{'Transaction' if e['pgScope'] == 'transaction' else 'Session'},
  wait: {e['wait']},
)'''
        for e in catalog
    )
    files["locks/gleam/gleam.toml"] = f'''name = "{snake}_locks"
version = "0.1.0"
description = "{org} lock routines: ores_locks_and_leases with the {org} key prefix and lock catalog."
licences = ["MIT"]
target = "erlang"

gleam = ">= 1.6.0"

[dependencies]
gleam_stdlib = ">= 0.44.0 and < 2.0.0"
ores_locks_and_leases = {{ path = "{VENDOR}/gleam" }}

[dev-dependencies]
gleeunit = ">= 1.0.0 and < 2.0.0"
'''
    files[f"locks/gleam/src/{snake}_locks.gleam"] = f'''//// {org} lock routines: `ores_locks_and_leases` with the org's key prefix
//// and lock catalog. Generated from `../catalog.json` by
//// ores-locks-and-leases' `templates/lib-core/gen_org_locks.py`.

import gleam/list
import gleam/string
import ores_locks_and_leases as locks

/// This org's key prefix.
pub const org = "{org}"

/// The lock domains this org uses.
pub type Domain {{
{gleam_domains}
}}

pub fn domain_to_string(domain: Domain) -> String {{
  case domain {{
{gleam_domain_str}
  }}
}}

/// Build `{org}/<domain>/<name>`.
pub fn key(domain: Domain, name: String) -> Result(locks.LockKey, String) {{
  locks.lock_key(org <> "/" <> domain_to_string(domain) <> "/" <> name)
}}

/// One catalog row: the defaults a call site should use for a named lock.
pub type Entry {{
  Entry(
    domain: Domain,
    /// May contain `{{placeholders}}`; see `entry_key`.
    name: String,
    layers: locks.Layers,
    pg_scope: locks.PgScope,
    wait: Bool,
  )
}}

/// The key for `entry` with `{{placeholders}}` filled from `fill`, in order.
pub fn entry_key(
  entry: Entry,
  fill: List(String),
) -> Result(locks.LockKey, String) {{
  key(entry.domain, fill_placeholders(entry.name, fill))
}}

fn fill_placeholders(name: String, fill: List(String)) -> String {{
  case string.split_once(name, "{{") {{
    Error(Nil) -> name
    Ok(#(before, rest)) -> {{
      let after = case string.split_once(rest, "}}") {{
        Ok(#(_, after)) -> after
        Error(Nil) -> ""
      }}
      let #(value, remaining) = case fill {{
        [first, ..remaining] -> #(first, remaining)
        [] -> #("", [])
      }}
      before <> value <> fill_placeholders(after, remaining)
    }}
  }}
}}

/// The plan an entry's defaults produce.
pub fn entry_plan(entry: Entry) -> locks.Plan {{
  locks.plan(entry.layers, entry.pg_scope, entry.wait)
}}

{gleam_entries}

/// Every catalog entry.
pub fn catalog() -> List(Entry) {{
  [{", ".join(entry_ident(e, 'snake') for e in catalog)}]
}}

/// Every catalog entry plans to something that runs `work` exactly once.
pub fn catalog_is_well_formed() -> Bool {{
  list.all(catalog(), fn(entry) {{
    list.filter(entry_plan(entry).steps, fn(step) {{ step == locks.Work }})
    |> list.length
    == 1
  }})
}}
'''
    files[f"locks/gleam/test/{snake}_locks_test.gleam"] = f'''import gleeunit
import gleeunit/should
import ores_locks_and_leases as locks
import {snake}_locks as org_locks

pub fn main() {{
  gleeunit.main()
}}

pub fn keys_carry_the_org_prefix_test() {{
  let assert Ok(key) = org_locks.key(org_locks.{ident(domains[0], 'pascal')}, "x")
  locks.key_to_string(key) |> should.equal("{org}/{domains[0]}/x")
}}

pub fn placeholders_are_filled_in_order_test() {{
  let entry =
    org_locks.Entry(
      domain: org_locks.{ident(domains[0], 'pascal')},
      name: "{{a}}/x/{{b}}",
      layers: locks.layers_both,
      pg_scope: locks.Transaction,
      wait: True,
    )
  let assert Ok(key) = org_locks.entry_key(entry, ["1", "2"])
  locks.key_to_string(key) |> should.equal("{org}/{domains[0]}/1/x/2")
  org_locks.catalog_is_well_formed() |> should.be_true
}}
'''

    # --- go --------------------------------------------------------------------
    width = max(len("Domain" + ident(d, "pascal")) for d in domains)
    go_domains = "\n".join(f"\t{('Domain' + ident(d, 'pascal')).ljust(width)} Domain = \"{d}\"" for d in domains)
    go_entries = "\n".join(
        f'''\t// {e['description']}
\t{entry_ident(e, 'pascal')} = Entry{{Domain: Domain{ident(e['domain'], 'pascal')}, Name: "{e['name']}", Layers: oreslocks.Layers{{Fiducia: {str(e['layers']['fiducia']).lower()}, PgAdvisory: {str(e['layers']['pgAdvisory']).lower()}}}, PgScope: oreslocks.{'ScopeTransaction' if e['pgScope'] == 'transaction' else 'ScopeSession'}, Wait: {str(e['wait']).lower()}}}'''
        for e in catalog
    )
    files["locks/golang/go.mod"] = f'''module github.com/{org}/{prefix}-lib-core/locks/golang

go 1.22

require github.com/ORESoftware/ores-locks-and-leases/src/go v0.1.0
'''
    # Pin the immutable nested-module release. This keeps generated consumers
    # reproducible even while a freshly published version is still propagating
    # through proxy.golang.org and sum.golang.org caches.
    files["locks/golang/go.sum"] = '''github.com/ORESoftware/ores-locks-and-leases/src/go v0.1.0 h1:ukOGh6w3yz4vgQry8+ADiGWxha66zATdrAmpOfWBKhA=
github.com/ORESoftware/ores-locks-and-leases/src/go v0.1.0/go.mod h1:L5hcHZjI6AjJa0swONnyu5lMQwNp74krvEyoKSUN66g=
'''
    files["locks/golang/locks.go"] = f'''// Package {snake}locks wraps ORESoftware/ores-locks-and-leases with the {org}
// key prefix and lock catalog. Generated from ../catalog.json by
// ores-locks-and-leases' templates/lib-core/gen_org_locks.py.
package {snake}locks

import (
\t"regexp"

\toreslocks "github.com/ORESoftware/ores-locks-and-leases/src/go"
)

// Org is this org's key prefix.
const Org = "{org}"

// Domain is one of the lock domains this org uses.
type Domain string

const (
{go_domains}
)

// Key builds {org}/<domain>/<name>.
func Key(domain Domain, name string) (oreslocks.LockKey, error) {{
\treturn oreslocks.NewLockKey(Org + "/" + string(domain) + "/" + name)
}}

// Entry is one catalog row: the defaults a call site should use for a named lock.
type Entry struct {{
\tDomain Domain
\t// Name may contain {{placeholders}}; see Entry.Key.
\tName    string
\tLayers  oreslocks.Layers
\tPgScope oreslocks.PgScope
\tWait    bool
}}

var placeholder = regexp.MustCompile(`\\{{[^}}]*\\}}`)

// Key returns the entry's key with {{placeholders}} filled from fill, in order.
func (e Entry) Key(fill ...string) (oreslocks.LockKey, error) {{
\ti := 0
\tname := placeholder.ReplaceAllStringFunc(e.Name, func(string) string {{
\t\tif i < len(fill) {{
\t\t\tv := fill[i]
\t\t\ti++
\t\t\treturn v
\t\t}}
\t\treturn ""
\t}})
\treturn Key(e.Domain, name)
}}

// Plan is the plan the entry's defaults produce.
func (e Entry) Plan() oreslocks.Plan {{ return oreslocks.MakePlan(e.Layers, e.PgScope, e.Wait) }}

// The catalog, as constants.
var (
{go_entries}
)
'''
    files["locks/golang/locks_test.go"] = f'''package {snake}locks

import (
\t"testing"

\toreslocks "github.com/ORESoftware/ores-locks-and-leases/src/go"
)

func TestKeysCarryTheOrgPrefix(t *testing.T) {{
\tk, err := Key(Domain{ident(domains[0], 'pascal')}, "x")
\tif err != nil || string(k) != "{org}/{domains[0]}/x" {{
\t\tt.Fatalf("%q %v", k, err)
\t}}
}}

func TestPlaceholdersAreFilledInOrder(t *testing.T) {{
\te := Entry{{Domain: Domain{ident(domains[0], 'pascal')}, Name: "{{a}}/x/{{b}}", Layers: oreslocks.LayersBoth, PgScope: oreslocks.ScopeTransaction, Wait: true}}
\tk, err := e.Key("1", "2")
\tif err != nil || string(k) != "{org}/{domains[0]}/1/x/2" {{
\t\tt.Fatalf("%q %v", k, err)
\t}}
\tif e.Plan().Steps[0] != oreslocks.StepFiduciaAcquire {{
\t\tt.Fatal("fiducia must be outermost")
\t}}
}}
'''
    return files


def patch_root_manifest(text: str | None, org: str, prefix: str, interfaces_name: str) -> str:
    """Add the shared-package and interfaces dependencies to the root .zpkg.toml, once."""
    package_org = org.lower()
    wanted = {
        f'"{SHARED_PACKAGE_ORG}/{SHARED_NAME}"': f'"{SHARED_PACKAGE_ORG}/{SHARED_NAME}" = "{SHARED_REQ}"',
        f'"{package_org}/{interfaces_name}"': f'"{package_org}/{interfaces_name}" = "^0.1.0"',
    }
    if text is None:
        text = f'''[package]
org = "{package_org}"
name = "{prefix}-lib-core"
version = "0.1.0"
description = "Canonical {org} core library"
license = "MIT"

[package.repository]
vcs = "git"
url = "https://github.com/{org}/{prefix}-lib-core"

[dependencies]

[install]
dir = ".vendor/.zed"

[targets.repository]
dir = "."

[targets.locks]
dir = "locks"
name = "{ident(prefix, 'kebab')}-locks"
adapter = "none"
'''
    lines = text.split("\n")
    present = {k for k in wanted if any(re.match(rf"\s*{re.escape(k)}\s*=", ln) for ln in lines)}
    missing = [wanted[k] for k in wanted if k not in present]
    if missing:
        # Insert after the [dependencies] header, creating one before the first
        # other table if absent.
        idx = next((i for i, ln in enumerate(lines) if ln.strip() == "[dependencies]"), None)
        if idx is None:
            first_table = next((i for i, ln in enumerate(lines) if ln.startswith("[") and not ln.startswith("[package")), len(lines))
            # place after [package] / [package.repository] blocks
            insert_at = first_table
            lines[insert_at:insert_at] = ["[dependencies]"] + missing + [""]
        else:
            lines[idx + 1 : idx + 1] = missing
    if "[targets.locks]" not in text:
        block = ["", "# The org's lock routines: ORESoftware/ores-locks-and-leases wrapped with", "# this org's key prefix and catalog. Nested zed package; see locks/README.md.", "[targets.locks]", 'dir = "locks"', f'name = "{ident(prefix, "kebab")}-locks"', 'adapter = "none"']
        # append before [scripts] if present, else at end
        sidx = next((i for i, ln in enumerate(lines) if ln.strip() == "[scripts]"), None)
        if sidx is None:
            lines = [ln for ln in lines]
            while lines and lines[-1] == "":
                lines.pop()
            lines += block + [""]
        else:
            lines[sidx:sidx] = block + [""]
    return "\n".join(lines)


def git(repo: pathlib.Path, *args: str, env: dict | None = None, check: bool = True) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=env)
    if check and result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed in {repo}:\n{result.stderr}")
    return result.stdout


def head_file(repo: pathlib.Path, path: str) -> str | None:
    result = subprocess.run(["git", "-C", str(repo), "show", f"HEAD:{path}"], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


def commit_without_touching_worktree(repo: pathlib.Path, files: dict[str, str], branch: str, message: str) -> str:
    """Build HEAD + files in a temporary index, commit, and point `branch` at it."""
    with tempfile.TemporaryDirectory() as tmp:
        index = os.path.join(tmp, "index")
        env = dict(os.environ, GIT_INDEX_FILE=index)
        head = git(repo, "rev-parse", "HEAD").strip()
        git(repo, "read-tree", head, env=env)
        for rel, content in files.items():
            blob = subprocess.run(["git", "-C", str(repo), "hash-object", "-w", "--stdin"], input=content, capture_output=True, text=True, check=True).stdout.strip()
            git(repo, "update-index", "--add", "--cacheinfo", f"100644,{blob},{rel}", env=env)
        tree = git(repo, "write-tree", env=env).strip()
        if tree == git(repo, "rev-parse", f"{head}^{{tree}}").strip():
            print(f"[gen] {repo.name}: nothing to commit (HEAD already carries the package)")
            return head
        existing = git(repo, "rev-parse", "-q", "--verify", f"refs/heads/{branch}^{{tree}}", check=False).strip()
        if existing == tree:
            print(f"[gen] {repo.name}: {branch} already carries exactly this package; leaving it alone")
            return git(repo, "rev-parse", f"refs/heads/{branch}").strip()
        commit = subprocess.run(["git", "-C", str(repo), "commit-tree", tree, "-p", head, "-m", message], capture_output=True, text=True, check=True).stdout.strip()
        git(repo, "branch", "-f", branch, commit)
        print(f"[gen] {repo.name}: {branch} -> {commit[:12]} ({len(files)} files)")
        return commit


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, help="path to the *-lib-core checkout")
    ap.add_argument("--org", required=True, help="GitHub org, e.g. fanwaave")
    ap.add_argument("--prefix", required=True, help="repo prefix, e.g. fanwaave (repos are <prefix>-lib-core, <prefix>-interfaces)")
    ap.add_argument("--interfaces", help="interfaces package name; default <prefix>-interfaces")
    ap.add_argument("--branch", default="feat/ores-locks-and-leases")
    ap.add_argument("--commit", action="store_true", help="commit to --branch via a temporary index without touching the working tree")
    ap.add_argument("--stdout", action="store_true", help="print the file list and exit")
    args = ap.parse_args()

    repo = pathlib.Path(args.repo).expanduser().resolve()
    interfaces_name = args.interfaces or f"{args.prefix}-interfaces"
    catalog_text = head_file(repo, "locks/catalog.json") if args.commit else (
        (repo / "locks/catalog.json").read_text() if (repo / "locks/catalog.json").exists() else None
    )
    catalog = json.loads(catalog_text)["entries"] if catalog_text else DEFAULT_CATALOG

    files = render(args.org, args.prefix, catalog, interfaces_name)
    root_manifest = head_file(repo, ".zpkg.toml") if args.commit else ((repo / ".zpkg.toml").read_text() if (repo / ".zpkg.toml").exists() else None)
    files[".zpkg.toml"] = patch_root_manifest(root_manifest, args.org, args.prefix, interfaces_name)

    if args.stdout:
        for path in sorted(files):
            print(path)
        return 0

    message = (
        "feat(locks): consume ORESoftware/ores-locks-and-leases with the org key prefix and lock catalog\n\n"
        f"Adds the nested `locks/` zed package — Rust, TypeScript, Dart, Gleam and Go\n"
        f"wrappers over the shared fiducia-lease + Postgres-advisory-lock routines, every\n"
        f"key prefixed `{args.org}/<domain>/<name>` — plus the org lock catalog as a dual\n"
        f"TypeSpec + JSON Schema contract (ores-contracts), and the root .zpkg.toml\n"
        f"dependencies on ORESoftware/ores-locks-and-leases and {args.org}/{interfaces_name}.\n\n"
        "Generated by ores-locks-and-leases/templates/lib-core/gen_org_locks.py; edit\n"
        "locks/catalog.json and re-run rather than editing the runtime slices by hand.\n\n"
        "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n"
        "Claude-Session: https://claude.ai/code/session_01P6vFcfS49sFvXjKFeWf2Kz"
    )
    if args.commit:
        if not (repo / ".git").exists():
            raise SystemExit(f"{repo} is not a git repository")
        commit_without_touching_worktree(repo, files, args.branch, message)
        return 0

    for rel, content in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    print(f"[gen] wrote {len(files)} files into {repo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
