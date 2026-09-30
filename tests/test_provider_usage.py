"""Loader + unit tests for dashboard/plugin_api.py (stdlib unittest only)."""
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load_api():
    # dash in the folder name makes a normal import impossible; load by path.
    spec = importlib.util.spec_from_file_location(
        "provider_usage_api", ROOT / "dashboard" / "plugin_api.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_api"] = mod
    spec.loader.exec_module(mod)
    return mod

API = load_api()

class SmokeTest(unittest.TestCase):
    def test_split_fetchers_registered(self):
        self.assertIn("opencode-zen", API.FETCHERS)
        self.assertIn("opencode-go", API.FETCHERS)
        self.assertEqual(API.PROVIDER_META["opencode-zen"]["name"], "OpenCode Zen")
        self.assertEqual(API.PROVIDER_META["opencode-go"]["name"], "OpenCode Go")
        self.assertIn("opencode-zen", API.FETCH_ORDER)

if __name__ == "__main__":
    unittest.main()
