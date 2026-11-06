"""Manifest tests: both package manifests must name the same version."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_YAML = ROOT / "plugin.yaml"
DASHBOARD_MANIFEST = ROOT / "dashboard" / "manifest.json"


def _scalar(path, key):
    """Return a top-level ``key: value`` pair from a flat YAML file."""
    pattern = re.compile(r"^%s:\s*(.+?)\s*$" % re.escape(key))
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            return match.group(1).strip().strip("\"'")
    return None


class ManifestVersionTest(unittest.TestCase):
    def test_plugin_yaml_and_dashboard_manifest_agree(self):
        plugin_version = _scalar(PLUGIN_YAML, "version")
        manifest_version = json.loads(DASHBOARD_MANIFEST.read_text(encoding="utf-8")).get("version")
        self.assertTrue(plugin_version, "plugin.yaml carries no version")
        self.assertTrue(manifest_version, "dashboard/manifest.json carries no version")
        self.assertEqual(
            plugin_version,
            manifest_version,
            "plugin.yaml and dashboard/manifest.json must name the same version",
        )

    def test_version_is_a_release_number(self):
        plugin_version = _scalar(PLUGIN_YAML, "version") or ""
        self.assertRegex(plugin_version, r"^\d+\.\d+\.\d+$")


if __name__ == "__main__":
    unittest.main()
