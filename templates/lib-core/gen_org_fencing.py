#!/usr/bin/env python3
"""Add reproducible application-side fencing assets to a generated lib-core.

Run this immediately after `gen_org_locks.py`:

    gen_org_fencing.py --repo ~/codes/fanwaave/fanwaave-lib-core \
        --org fanwaave --prefix fanwaave

For dirty/parked checkouts, `--commit` builds a fast-forward commit from the
existing DEN-backed rollout branch without touching the working tree:

    gen_org_fencing.py --repo ... --org ... --prefix ... \
        --branch DEN-2050/ores-locks-and-leases --base-ref origin/main --commit

The output is sourced from the reviewed persistence and conformance assets in
ORESoftware/ores-locks-and-leases. PostgreSQL schema names and Redis examples
are deterministically namespaced for the target org.
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

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
README_MARKER = "<!-- ores-locks-and-leases:fencing-assets:v1 -->"


def ident(value: str) -> str:
    parts = [part for part in re.split(r"[^A-Za-z0-9]+", value) if part]
    if not parts:
        raise SystemExit("prefix must contain at least one alphanumeric character")
    result = "_".join(part.lower() for part in parts)
    if result[0].isdigit():
        result = "org_" + result
    if not re.fullmatch(r"[a-z][a-z0-9_]*", result):
        raise SystemExit(f"prefix {value!r} does not produce a safe PostgreSQL identifier")
    return result


def read_source(relative: str) -> str:
    return (REPO_ROOT / relative).read_text(encoding="utf-8")


def patch_nested_manifest(text: str) -> str:
    blocks: list[str] = []
    if "[targets.persistence]" not in text:
        blocks.extend(
            [
                "",
                "# Application-side fencing migrations/scripts generated from",
                "# ORESoftware/ores-locks-and-leases.",
                "[targets.persistence]",
                'dir = "persistence"',
                'adapter = "none"',
            ]
        )
    if "[targets.fence-conformance]" not in text:
        blocks.extend(
            [
                "",
                "[targets.fence-conformance]",
                'dir = "conformance"',
                'name = "fence-conformance"',
                'adapter = "none"',
            ]
        )
    if not blocks:
        return text

    lines = text.splitlines()
    script_index = next(
        (index for index, line in enumerate(lines) if line.strip() == "[scripts]"),
        len(lines),
    )
    lines[script_index:script_index] = blocks + [""]
    return "\n".join(lines).rstrip() + "\n"


def patch_readme(text: str, org: str, schema: str) -> str:
    if README_MARKER in text:
        return text
    section = f"""
{README_MARKER}
## Application-side fencing

The Fiducia token is authority only when the datastore rejects older holders.
This generated package includes:

- `persistence/postgres/fencing.sql`: install independently in every Supabase,
  Neon, or other PostgreSQL database that stores protected **{org}** state;
- `persistence/redis/fenced-write.lua`: atomic compare-and-`SET` for
  Redis-resident state whose two keys share one cluster hash tag;
- `conformance/cases/fence-decision.json`: `advanced`, `replay`, `stale`, and
  `token_reuse` vectors shared with the upstream runtime helpers.

The PostgreSQL schema is `{schema}`. The fence function and the protected
business mutation must run in the same transaction. Redis cannot be the sole
fence for a later PostgreSQL write. Tokens remain canonical unsigned-64
decimal strings at JSON/Redis boundaries and `NUMERIC(20,0)` in PostgreSQL.
"""
    return text.rstrip() + "\n\n" + section.lstrip()




def validate_existing_metadata(text: str | None, org: str, prefix: str) -> None:
    if text is None:
        return
    try:
        metadata = json.loads(text)
    except json.JSONDecodeError as error:
        raise SystemExit(f"existing fencing.config.json is invalid JSON: {error}") from error
    expected_schema = f"{ident(prefix)}_locks"
    if metadata.get("org") != org or metadata.get("postgresSchema") != expected_schema:
        raise SystemExit(
            "existing fencing assets belong to "
            f"{metadata.get('org')!r}/{metadata.get('postgresSchema')!r}, not "
            f"{org!r}/{expected_schema!r}; refusing to overwrite them"
        )


def render(org: str, prefix: str, nested_manifest: str, readme: str) -> dict[str, str]:
    snake = ident(prefix)
    schema = f"{snake}_locks"
    redis_prefix = f"{org.lower()}-locks"

    sql = read_source("persistence/postgres/fencing.sql").replace("ores_locks", schema)
    sql_test = read_source("persistence/postgres/test-fencing.sql").replace(
        "ores_locks", schema
    )
    persistence_readme = read_source("persistence/README.md").replace(
        "ores_locks", schema
    )
    fencing_doc = read_source("docs/fencing-tokens.md").replace("ores_locks", schema)
    redis_lua = read_source("persistence/redis/fenced-write.lua").replace(
        "ores-locks:", f"{redis_prefix}:"
    )
    redis_test = read_source("persistence/redis/test-fenced-write.sh").replace(
        "ores-locks:", f"{redis_prefix}:"
    )

    metadata = {
        "$comment": "Generated by ORESoftware/ores-locks-and-leases/templates/lib-core/gen_org_fencing.py. Do not hand-edit generated persistence assets.",
        "org": org,
        "keyPrefix": org,
        "postgresSchema": schema,
        "tokenWireFormat": "canonical-uint64-decimal-string",
        "postgresTokenType": "NUMERIC(20,0)",
        "decisions": ["advanced", "replay", "stale", "token_reuse"],
        "source": "ORESoftware/ores-locks-and-leases",
    }

    return {
        "locks/.zpkg.toml": patch_nested_manifest(nested_manifest),
        "locks/README.md": patch_readme(readme, org, schema),
        "locks/persistence/fencing.config.json": json.dumps(metadata, indent=2)
        + "\n",
        "locks/persistence/README.md": (
            f"<!-- generated for {org}; PostgreSQL schema: {schema} -->\n\n"
            + persistence_readme
        ),
        "locks/persistence/postgres/fencing.sql": sql,
        "locks/persistence/postgres/test-fencing.sql": sql_test,
        "locks/persistence/redis/fenced-write.lua": redis_lua,
        "locks/persistence/redis/test-fenced-write.sh": redis_test,
        "locks/docs/fencing-tokens.md": fencing_doc,
        "locks/conformance/cases/fence-decision.json": read_source(
            "conformance/cases/fence-decision.json"
        ),
    }


def git(
    repo: pathlib.Path,
    *args: str,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        env=env,
    )
    if check and result.returncode != 0:
        raise SystemExit(
            f"git {' '.join(args)} failed in {repo}:\n{result.stderr}"
        )
    return result.stdout


def ref_file(repo: pathlib.Path, ref: str, path: str) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(repo), "show", f"{ref}:{path}"],
        capture_output=True,
        text=True,
    )
    return result.stdout if result.returncode == 0 else None


def commit_without_touching_worktree(
    repo: pathlib.Path,
    files: dict[str, str],
    branch: str,
    base_ref: str,
    message: str,
) -> str:
    with tempfile.TemporaryDirectory() as temporary:
        index = os.path.join(temporary, "index")
        env = dict(os.environ, GIT_INDEX_FILE=index)

        existing = git(
            repo,
            "rev-parse",
            "-q",
            "--verify",
            f"refs/heads/{branch}^{{commit}}",
            check=False,
        ).strip()
        parent = existing or git(
            repo, "rev-parse", f"{base_ref}^{{commit}}"
        ).strip()

        if ref_file(repo, parent, "locks/catalog.json") is None:
            raise SystemExit(
                "locks/catalog.json is absent; run gen_org_locks.py before "
                "gen_org_fencing.py"
            )

        git(repo, "read-tree", parent, env=env)
        for relative, content in files.items():
            blob = subprocess.run(
                ["git", "-C", str(repo), "hash-object", "-w", "--stdin"],
                input=content,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            git(
                repo,
                "update-index",
                "--add",
                "--cacheinfo",
                f"100644,{blob},{relative}",
                env=env,
            )

        tree = git(repo, "write-tree", env=env).strip()
        parent_tree = git(repo, "rev-parse", f"{parent}^{{tree}}").strip()
        if tree == parent_tree:
            print(f"[fencing] {repo.name}: assets already current")
            return parent

        commit = subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "commit-tree",
                tree,
                "-p",
                parent,
                "-m",
                message,
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

        if existing:
            git(
                repo,
                "update-ref",
                f"refs/heads/{branch}",
                commit,
                existing,
            )
        else:
            git(
                repo,
                "update-ref",
                f"refs/heads/{branch}",
                commit,
                "0000000000000000000000000000000000000000",
            )

        print(
            f"[fencing] {repo.name}: {branch} -> {commit[:12]} "
            f"({len(files)} files)"
        )
        return commit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--org", required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--branch", default="")
    parser.add_argument("--base-ref", default="HEAD")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args()

    repo = pathlib.Path(args.repo).expanduser().resolve()
    if args.commit:
        if not (repo / ".git").exists():
            raise SystemExit(f"{repo} is not a git repository")
        if not re.search(
            r"(?:^|/)DEN-[0-9]+(?:/|$)", args.branch, re.IGNORECASE
        ):
            raise SystemExit(
                "--branch must contain a Linear identifier such as DEN-123"
            )
        existing = git(
            repo,
            "rev-parse",
            "-q",
            "--verify",
            f"refs/heads/{args.branch}^{{commit}}",
            check=False,
        ).strip()
        source_ref = existing or args.base_ref
        nested_manifest = ref_file(repo, source_ref, "locks/.zpkg.toml")
        readme = ref_file(repo, source_ref, "locks/README.md")
        existing_metadata = ref_file(
            repo, source_ref, "locks/persistence/fencing.config.json"
        )
    else:
        nested_path = repo / "locks/.zpkg.toml"
        readme_path = repo / "locks/README.md"
        metadata_path = repo / "locks/persistence/fencing.config.json"
        nested_manifest = (
            nested_path.read_text(encoding="utf-8") if nested_path.exists() else None
        )
        readme = (
            readme_path.read_text(encoding="utf-8") if readme_path.exists() else None
        )
        existing_metadata = (
            metadata_path.read_text(encoding="utf-8")
            if metadata_path.exists()
            else None
        )

    if nested_manifest is None or readme is None:
        raise SystemExit(
            "generated locks/.zpkg.toml and locks/README.md are required; "
            "run gen_org_locks.py first"
        )

    validate_existing_metadata(existing_metadata, args.org, args.prefix)
    files = render(args.org, args.prefix, nested_manifest, readme)
    if args.stdout:
        for path in sorted(files):
            print(path)
        return 0

    message = (
        "feat(locks): add application-side fencing persistence\n\n"
        "Adds org-namespaced PostgreSQL/Supabase/Neon fencing, the atomic "
        "Redis script, and the shared decision corpus generated from "
        "ORESoftware/ores-locks-and-leases.\n\n"
        "Linear: DEN-2050"
    )
    if args.commit:
        commit_without_touching_worktree(
            repo,
            files,
            args.branch,
            args.base_ref,
            message,
        )
        return 0

    for relative, content in files.items():
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    print(f"[fencing] wrote {len(files)} files into {repo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
