#!/usr/bin/env python3
"""Exercise generator layout and preservation through its public command line."""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


GENERATOR = pathlib.Path(__file__).resolve().parents[1] / "templates/lib-core/gen_org_locks.py"
RUNTIMES = ("rust", "typescript", "dart", "gleam", "golang")


class GeneratorLayout(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="ores-locks-layout-")
        self.addCleanup(self.scratch.cleanup)
        self.repo = pathlib.Path(self.scratch.name).resolve()

    def generate(self, *args):
        return subprocess.run(
            [sys.executable, str(GENERATOR), "--repo", str(self.repo),
             "--org", "fixture-org", "--prefix", "fixture", *args],
            capture_output=True, text=True, timeout=30,
        )

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()

    def initialize(self):
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Generator layout fixture")
        self.git("config", "user.email", "generator@example.invalid")
        (self.repo / "README.md").write_text("preserve this checkout\n")
        self.git("add", "README.md")
        self.git("commit", "-qm", "fixture base")

    def assert_canonical(self):
        for runtime in RUNTIMES:
            self.assertTrue((self.repo / "locks/langs" / runtime).is_dir(), runtime)
            self.assertFalse((self.repo / "locks" / runtime).exists(), runtime)

    def test_fresh_generation_and_refresh_preserve_catalog_and_layout(self):
        result = self.generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_canonical()
        catalog_path = self.repo / "locks/catalog.json"
        catalog = json.loads(catalog_path.read_text())
        catalog["entries"][0]["description"] = "Reviewed custom catalog row"
        catalog_path.write_text(json.dumps(catalog))
        result = self.generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_canonical()
        self.assertEqual(json.loads(catalog_path.read_text()), catalog)
        rust = self.repo / "locks/langs/rust/lib.rs"
        self.assertIn("Reviewed custom catalog row", rust.read_text())
        manifest = (self.repo / "locks/.zpkg.toml").read_text()
        for runtime in RUNTIMES:
            self.assertIn('dir = "langs/' + runtime + '"', manifest)
        package = json.loads((self.repo / "locks/langs/typescript/package.json").read_text())
        dependency = package["dependencies"]["@oresoftware/locks-and-leases"]
        resolved = (self.repo / "locks/langs/typescript" / dependency.removeprefix("file:")).resolve()
        self.assertEqual(resolved, self.repo / "locks/.vendor/.zed/oresoftware/ores-locks-and-leases/src/ts")
        go_module = (self.repo / "locks/langs/golang/go.mod").read_text().splitlines()[0]
        self.assertEqual(go_module, "module github.com/fixture-org/fixture-lib-core/locks/langs/golang")

    def test_legacy_worktree_layout_refuses_before_any_writes(self):
        for runtime in RUNTIMES:
            with self.subTest(runtime=runtime):
                legacy = self.repo / "locks" / runtime
                legacy.mkdir(parents=True)
                marker = legacy / "unique-source.txt"
                marker.write_text("unique reviewed source\n")
                result = self.generate()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("reviewed migration", result.stderr)
                self.assertEqual(marker.read_text(), "unique reviewed source\n")
                self.assertFalse((self.repo / ".zpkg.toml").exists())
                self.assertFalse((self.repo / "locks/langs").exists())
                marker.unlink()
                legacy.rmdir()

    def test_legacy_dangling_symlink_is_not_overwritten(self):
        (self.repo / "locks").mkdir()
        legacy = self.repo / "locks/rust"
        legacy.symlink_to("missing-original")
        result = self.generate()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(legacy.is_symlink())
        self.assertFalse((self.repo / "locks/langs").exists())

    def test_commit_refuses_legacy_base_and_preserves_refs_and_checkout(self):
        self.initialize()
        legacy = self.repo / "locks/rust"
        legacy.mkdir(parents=True)
        (legacy / "lib.rs").write_text("// unique legacy implementation\n")
        self.git("add", "locks/rust/lib.rs")
        self.git("commit", "-qm", "legacy runtime")
        original_refs = self.git("show-ref")
        result = self.generate("--commit", "--base-ref", "main", "--branch", "DEN-2050/layout")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("reviewed migration", result.stderr)
        self.assertEqual(self.git("show-ref"), original_refs)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_commit_reads_base_layout_instead_of_parked_checkout(self):
        self.initialize()
        base = self.git("rev-parse", "main")
        self.git("switch", "-qc", "parked")
        legacy = self.repo / "locks/rust"
        legacy.mkdir(parents=True)
        (legacy / "lib.rs").write_text("// parked unique implementation\n")
        self.git("add", "locks/rust/lib.rs")
        self.git("commit", "-qm", "parked implementation")
        parked = self.git("rev-parse", "HEAD")
        result = self.generate("--commit", "--base-ref", "main", "--branch", "DEN-2050/layout")
        self.assertEqual(result.returncode, 0, result.stderr)
        files = self.git("ls-tree", "-r", "--name-only", "DEN-2050/layout").splitlines()
        self.assertIn("locks/langs/rust/lib.rs", files)
        self.assertNotIn("locks/rust/lib.rs", files)
        self.assertEqual(self.git("rev-parse", "DEN-2050/layout^"), base)
        self.assertEqual(self.git("rev-parse", "HEAD"), parked)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_preview_is_read_only_and_lists_canonical_paths(self):
        result = self.generate("--stdout")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("locks/langs/rust/lib.rs\n", result.stdout)
        self.assertEqual(list(self.repo.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
