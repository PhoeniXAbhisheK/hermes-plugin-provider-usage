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

class HttpJsonGuardTest(unittest.TestCase):
    class FakeResp:
        def __init__(self, status, text):
            self.status_code = status
            self.text = text
        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError("HTTP %d" % self.status_code)

    def test_catchall_not_found_is_clear_error(self):
        # api.opencode.ai answers 200 with the literal text "Not Found".
        fake = HttpJsonGuardTest.FakeResp(200, '"Not Found"')
        with self.assertRaises(ValueError):
            API._decode_json_body(fake)

    def test_html_is_clear_error(self):
        with self.assertRaises(ValueError):
            API._decode_json_body(HttpJsonGuardTest.FakeResp(200, "<html>login</html>"))

    def test_json_object_parses(self):
        self.assertEqual(API._decode_json_body(HttpJsonGuardTest.FakeResp(200, '{"a":1}')), {"a": 1})

    def test_403_raises_permission_error(self):
        # Go entitlement errors come back 403; fetchers must be able to
        # distinguish them from generic failures. Monkeypatch the client.
        import httpx
        class FakeClient:
            def __init__(self, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def get(self, url, headers=None):
                return httpx.Response(403, request=httpx.Request("GET", url))
        orig = httpx.Client
        httpx.Client = FakeClient
        try:
            with self.assertRaises(PermissionError):
                API._http_json("https://x", {})
        finally:
            httpx.Client = orig
