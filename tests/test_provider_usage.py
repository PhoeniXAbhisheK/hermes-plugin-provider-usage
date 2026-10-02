"""Loader + unit tests for dashboard/plugin_api.py (stdlib unittest only)."""
import importlib.util
import json
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

    def test_error_never_echoes_response_body(self):
        # _collect() turns exceptions into {"error": str(exc)[:160]} and the
        # panel renders that. A provider that reflects a rejected credential
        # back in a non-JSON body must not put that credential in the UI.
        for body in (
            "Not Found",
            "unauthorized: token sk-live-ABCDEFGHIJKLMNOP invalid",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        ):
            with self.assertRaises(ValueError) as cm:
                API._decode_json_body(HttpJsonGuardTest.FakeResp(200, body))
            msg = str(cm.exception)
            for secret in ("sk-live-", "eyJhbGciOi", "Bearer"):
                self.assertNotIn(secret, msg, "error message leaked %r" % secret)
            # the shape is still reported, so the error stays diagnosable
            self.assertIn("non-JSON response", msg)
            self.assertIn("200", msg)

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


if __name__ == "__main__":
    unittest.main()
