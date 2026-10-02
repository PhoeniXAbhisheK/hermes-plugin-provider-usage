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


class SmokeTest(unittest.TestCase):
    def test_go_fetcher_registered(self):
        self.assertIn("opencode-go", API.FETCHERS)
        self.assertNotIn("opencode-zen", API.FETCHERS)
        self.assertEqual(API.PROVIDER_META["opencode-go"]["name"], "OpenCode Go")


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


CODING_URL = "https://api.kimi.com/coding/v1/usages"
AI_URL = "https://api.moonshot.ai/v1/users/me/balance"
CN_URL = "https://api.moonshot.cn/v1/users/me/balance"


class KimiFetcherTest(unittest.TestCase):
    """fetch_kimi() with mocked endpoints (unit tests never hit the network
    and never carry a real credential)."""

    BALANCE_AI = {"code": 0, "scode": "0x0", "status": True,
                  "data": {"available_balance": 18.02331,
                           "voucher_balance": 0, "cash_balance": 18.02331}}

    def setUp(self):
        self._orig_secret = API._secret
        self._orig_http = API._http_json
        self.calls = []
        self.headers_seen = []

    def tearDown(self):
        API._secret = self._orig_secret
        API._http_json = self._orig_http

    def _routes(self, routes):
        def fake(url, headers, **kw):
            self.calls.append(url)
            self.headers_seen.append(dict(headers))
            handler = routes.get(url, "MISS")
            if handler == "MISS":
                raise AssertionError("unexpected url: " + url)
            if isinstance(handler, Exception):
                raise handler
            return handler
        API._http_json = fake

    def _key(self, value="fake-key"):
        API._secret = lambda *names: value

    def test_reads_both_env_var_names(self):
        seen = []
        def fake_secret(*names):
            seen.append(names)
            return None
        API._secret = fake_secret
        with self.assertRaises(API._Skip):
            API.fetch_kimi()
        self.assertIn("KIMI_API_KEY", seen[0])
        self.assertIn("MOONSHOT_API_KEY", seen[0])

    def test_moonshot_env_var_alone_suffices(self):
        # users whose setup only provisioned MOONSHOT_API_KEY must get a card
        API._secret = lambda *names: "moonshot-key" if "MOONSHOT_API_KEY" in names else None
        self._routes({CODING_URL: PermissionError("HTTP 401"), AI_URL: self.BALANCE_AI})
        p = API.fetch_kimi()
        self.assertEqual(p["money"][0]["left"], 18.02)
        self.assertEqual(self.headers_seen[-1]["Authorization"], "Bearer moonshot-key")

    def test_international_region_probed_first(self):
        self._key()
        self._routes({CODING_URL: PermissionError("HTTP 401"), AI_URL: self.BALANCE_AI})
        p = API.fetch_kimi()
        self.assertEqual(self.calls, [CODING_URL, AI_URL])  # .cn never touched when .ai answers
        self.assertEqual(p["id"], "kimi-coding")
        row = p["money"][0]
        self.assertEqual(row["label"], "Balance")
        self.assertEqual(row["left"], 18.02)   # nested data.available_balance, rounded
        self.assertEqual(row["cur"], "CNY")

    def test_falls_back_to_cn_region_when_ai_rejects_key(self):
        self._key()
        cn = {"code": 0, "data": {"available_balance": 42.5}}
        self._routes({CODING_URL: PermissionError("HTTP 401"),
                      AI_URL: PermissionError("HTTP 401: Invalid Authentication"),
                      CN_URL: cn})
        p = API.fetch_kimi()
        self.assertEqual(self.calls, [CODING_URL, AI_URL, CN_URL])
        self.assertEqual(p["money"][0]["left"], 42.5)

    def test_both_regions_failing_surfaces_the_error(self):
        self._key()
        self._routes({CODING_URL: PermissionError("HTTP 401"),
                      AI_URL: PermissionError("HTTP 401"),
                      CN_URL: PermissionError("HTTP 401")})
        with self.assertRaises(PermissionError):
            API.fetch_kimi()

    def test_legacy_flat_available_still_parses(self):
        self._key()
        self._routes({CODING_URL: PermissionError("HTTP 401"),
                      AI_URL: {"available": 5.0}})
        p = API.fetch_kimi()
        self.assertEqual(p["money"][0]["left"], 5.0)

    def test_coding_windows_take_precedence_over_balance(self):
        self._key()
        self._routes({CODING_URL: {"usage": {"used": 1.0, "limit": 4.0, "resetTime": "2026-10-05T00:00:00Z"}}})
        p = API.fetch_kimi()
        self.assertEqual(self.calls, [CODING_URL])
        self.assertEqual(p["windows"][0]["percent"], 25.0)
        self.assertNotIn("money", p)

    def test_balance_body_without_number_raises(self):
        self._key()
        self._routes({CODING_URL: PermissionError("HTTP 401"),
                      AI_URL: {"code": 0, "data": {"voucher_balance": 0}},
                      CN_URL: {"code": 0, "data": {"voucher_balance": 0}}})
        with self.assertRaises(RuntimeError):
            API.fetch_kimi()

    def test_kimi_balance_parser(self):
        self.assertEqual(API._kimi_balance({"data": {"available_balance": "7.25"}}), 7.25)
        self.assertEqual(API._kimi_balance({"available": 3}), 3.0)
        self.assertIsNone(API._kimi_balance({"data": {"available_balance": None}}))
        self.assertIsNone(API._kimi_balance({}))


if __name__ == "__main__":
    unittest.main()
