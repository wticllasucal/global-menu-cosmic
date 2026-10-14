import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("compositor_patch", ROOT / "tools/compositor_patch.py")
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        (self.repo / "example").write_text("before\n")
        self.git("add", "example")
        self.git("commit", "-qm", "fixture")
        self.base = self.git("rev-parse", "HEAD").strip()
        (self.repo / "example").write_text("after\n")
        self.patch = Path(self.temp.name) / "menu.patch"
        self.patch.write_text(self.git("diff", "--binary"))
        (self.repo / "example").write_text("before\n")
        self.manifest = {"example": {"before": hashlib.sha256(b"before\n").hexdigest(), "after": hashlib.sha256(b"after\n").hexdigest()}}

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True)

    def run_patcher(self, action, base=None):
        return patcher.run(action, self.repo, base or self.base, self.patch, self.manifest)

    def test_wrong_revision_is_rejected(self):
        with self.assertRaises(patcher.PatchError):
            self.run_patcher("apply", "0" * 40)
        self.assertEqual((self.repo / "example").read_text(), "before\n")

    def test_local_changes_are_never_overwritten(self):
        (self.repo / "user-work").write_text("keep me")
        with self.assertRaises(patcher.PatchError):
            self.run_patcher("apply")
        self.assertEqual((self.repo / "user-work").read_text(), "keep me")

    def test_check_is_read_only_and_revert_is_symmetric(self):
        self.run_patcher("check")
        self.assertEqual((self.repo / "example").read_text(), "before\n")
        self.run_patcher("apply")
        self.assertEqual((self.repo / "example").read_text(), "after\n")
        self.run_patcher("revert")
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_changed_patched_file_prevents_revert(self):
        self.run_patcher("apply")
        (self.repo / "example").write_text("user edits after patch\n")
        with self.assertRaises(patcher.PatchError):
            self.run_patcher("revert")
        self.assertEqual((self.repo / "example").read_text(), "user edits after patch\n")

    def test_symlink_is_not_followed(self):
        (self.repo / "example").unlink()
        external = Path(self.temp.name) / "external"
        external.write_text("after\n")
        (self.repo / "example").symlink_to(external)
        with self.assertRaises(patcher.PatchError):
            self.run_patcher("revert")
        self.assertEqual(external.read_text(), "after\n")

    def test_patch_installs_the_bundled_bridge_and_integration_sources(self):
        self.git("apply", "--include=src/wayland/handlers/global_menu.rs",
                 "--include=vendor/cosmic-global-menu-bridge/*",
                 str(ROOT / "compositor/global-menu.patch"))
        manifest = json.loads((ROOT / "compositor/manifest.json").read_text())
        sources = {"src/wayland/handlers/global_menu.rs": ROOT / "compositor/integration.rs"}
        prefix = "vendor/cosmic-global-menu-bridge/"
        sources.update({path: ROOT / "bridge-server" / path.removeprefix(prefix)
                        for path in manifest if path.startswith(prefix)})
        for path, source in sources.items():
            with self.subTest(path=path):
                installed = (self.repo / path).read_bytes()
                self.assertEqual(installed, source.read_bytes())
                self.assertEqual(hashlib.sha256(installed).hexdigest(), manifest[path]["after"])


if __name__ == "__main__":
    unittest.main()
