"""Release boundary tests: secrets, missing runtime files, and reproducibility."""

import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path

from package_extension import ROOT, release_files, write_candidate


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "extension"
        shutil.copytree(ROOT / "extension", self.source, ignore=shutil.ignore_patterns("node_modules", "tests"))

    def test_release_is_byok_only_and_cannot_ship_development_files(self):
        (self.source / ".env").write_text("API_KEY=private")
        (self.source / "secrets.js").write_text("private")
        files = release_files(self.source)
        manifest = json.loads(files["manifest.json"])
        self.assertEqual(manifest["permissions"], ["storage"])
        self.assertEqual(manifest["host_permissions"], ["https://*.youtube.com/*", "https://api.typesafe.ai/*"])
        self.assertNotIn("optional_host_permissions", manifest)
        for group in manifest["content_scripts"]:
            self.assertEqual(group["matches"], ["https://*.youtube.com/*"])
        self.assertNotIn(".env", files)
        self.assertNotIn("secrets.js", files)
        self.assertNotIn("package.json", files)
        self.assertIn(b'var DEFAULT_CLASSIFIER_ENDPOINT = "https://api.typesafe.ai";', files["background.js"])
        self.assertIn(b'var DEFAULT_ENDPOINT = "https://api.typesafe.ai";', files["popup/popup.js"])
        first, second = self.root / "first.zip", self.root / "second.zip"
        self.assertEqual(write_candidate(files, first), write_candidate(files, second))
        with zipfile.ZipFile(first) as archive:
            self.assertIn("manifest.json", archive.namelist())
            self.assertFalse(any(name.startswith("extension/") for name in archive.namelist()))

    def test_missing_or_escaped_runtime_dependencies_stop_the_build(self):
        source = self.source / "byok-client.js"
        source.unlink()
        with self.assertRaises(FileNotFoundError):
            release_files(self.source)
        outside = self.root / "private.js"
        outside.write_text("private")
        source.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlink"):
            release_files(self.source)

    def test_unreviewed_permission_or_bootstrap_changes_stop_the_build(self):
        manifest = json.loads((self.source / "manifest.json").read_text())
        manifest["permissions"].append("tabs")
        (self.source / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "permissions"):
            release_files(self.source)


if __name__ == "__main__":
    unittest.main()
