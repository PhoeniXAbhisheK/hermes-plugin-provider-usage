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

class GoFetcherTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        (self.home / ".local" / "share" / "opencode").mkdir(parents=True)
        self.auth = self.home / ".local" / "share" / "opencode" / "auth.json"
        self._orig_home = API.HOME
        API.HOME = self.home
        API._secret = lambda *names: None  # no Hermes-scoped key in tests
        self._orig_http = API._http_json

    def tearDown(self):
        API.HOME = self._orig_home
        API._http_json = self._orig_http
        self._tmp.cleanup()

    def _write_auth(self, payload):
        self.auth.write_text(json.dumps(payload))

    def test_zen_key_is_never_sent_to_go_endpoint(self):
        # auth.json with ONLY a Zen key (entry id "opencode") must skip,
        # not 403 the Go endpoint with the wrong credential.
        self._write_auth({"opencode": {"type": "api", "key": "zen-key"}})
        with self.assertRaises(API._Skip):
            API.fetch_opencode_go()

    def test_no_key_no_file_skips(self):
        with self.assertRaises(API._Skip):
            API.fetch_opencode_go()

    def test_403_entitlement_hides_silently(self):
        self._write_auth({"opencode-go": {"type": "api", "key": "go-key"}})
        def boom(url, headers, **kw):
            raise PermissionError("HTTP 403: credential rejected or entitlement missing")
        API._http_json = boom
        with self.assertRaises(API._Skip):
            API.fetch_opencode_go()

    def test_windows_without_any_percent_are_skipped(self):
        # missing metric must never render as a 0% bar
        self._write_auth({"opencode-go": {"type": "api", "key": "go-key"}})
        API._http_json = lambda url, headers, **kw: {"usage": {}}
        with self.assertRaises(API._Skip):
            API.fetch_opencode_go()

    def test_ok_windows_payload(self):
        self._write_auth({"opencode-go": {"type": "api", "key": "go-key"}})
        API._http_json = lambda url, headers, **kw: {
            "usage": {"rolling": {"percent": 12.5, "resetsAt": "2026-10-01T12:00:00Z", "status": "ok"}}
        }
        p = API.fetch_opencode_go()
        self.assertEqual(p["id"], "opencode-go")
        self.assertEqual(p["windows"][0]["label"], "5h")
        self.assertEqual(p["windows"][0]["percent"], 12.5)

class ZenFetcherTest(unittest.TestCase):
    def setUp(self):
        import sqlite3, tempfile, datetime
        from pathlib import Path
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        db_dir = self.home / ".local" / "share" / "opencode"
        db_dir.mkdir(parents=True)
        con = sqlite3.connect(db_dir / "opencode.db")
        con.execute("create table session (model text, cost real, time_created integer)")
        now_ms = int(datetime.datetime.now().timestamp() * 1000)
        zen = '{"providerID":"opencode","id":"x"}'
        con.executemany(
            "insert into session values (?,?,?)",
            [
                (zen, 1.00, now_ms),                                  # Zen, this month
                (zen, 2.50, now_ms - 60_000),                         # Zen, this month
                (zen, 0.00, now_ms - 120_000),                        # Zen free model
                (zen, 99.00, now_ms - 40 * 86_400_000),               # Zen, previous months
                ('{"providerID":"anthropic","id":"y"}', 7.00, now_ms),  # not Zen
                (None, 5.00, now_ms),                                 # unparseable model json
            ],
        )
        con.commit()
        con.close()
        self._orig_home = API.HOME
        API.HOME = self.home

    def tearDown(self):
        API.HOME = self._orig_home
        self._tmp.cleanup()

    def test_month_to_date_zen_spend_only(self):
        p = API.fetch_opencode_zen()
        self.assertEqual(p["id"], "opencode-zen")
        self.assertEqual(p["status"], "ok")
        row = p["money"][0]
        self.assertEqual(row["label"], "Spend (month)")
        self.assertEqual(row["left"], 3.50)   # 1.00 + 2.50 + 0.00, excludes other months/providers
        self.assertEqual(row["cur"], "USD")
        self.assertNotIn("total", row)        # pure spend row, no quota bar

    def test_missing_db_skips(self):
        API.HOME = self.home.parent / "nope"
        with self.assertRaises(API._Skip):
            API.fetch_opencode_zen()
