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
        # ledger tests exercise the spend fallback; the cookie-scrape seam is
        # forced off here and covered in ZenConsoleBalanceTest
        self._orig_console = API._zen_console_balance
        API._zen_console_balance = lambda: None

    def tearDown(self):
        API.HOME = self._orig_home
        API._zen_console_balance = self._orig_console
        self._tmp.cleanup()

    def test_console_balance_preferred_as_balance_row(self):
        API._zen_console_balance = lambda: 4.32
        p = API.fetch_opencode_zen()
        self.assertEqual(p["id"], "opencode-zen")
        self.assertEqual(p["status"], "ok")
        self.assertEqual(p["money"], [{"label": "Balance", "left": 4.32, "cur": "USD"}])

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


class ZenConsoleBalanceTest(unittest.TestCase):
    """Cookie-scrape helpers: pure parsing/envelope tests plus the no-network
    guards (unit tests never hit the console and never carry a real cookie)."""

    def setUp(self):
        self._orig_secret = API._secret
        self._orig_home = API.HOME

    def tearDown(self):
        API._secret = self._orig_secret
        API.HOME = self._orig_home

    def test_seroval_args_payload_shape(self):
        got = API._seroval_args("ws_abc")
        self.assertEqual(
            got,
            '{"t":{"t":0,"i":0,"l":1,"a":[{"t":1,"s":"ws_abc"}],"o":0},"f":0,"m":[]}',
        )

    def test_balance_parsed_from_rpc_text(self):
        # 4.32 USD carried as micro-cents inside an arbitrary minified envelope
        text = 'x{"balance":432000000,"monthlyLimit":1000000000}y'
        self.assertAlmostEqual(API._zen_balance_from_text(text), 4.32)

    def test_balance_absent_or_bogus_returns_none(self):
        self.assertIsNone(API._zen_balance_from_text("Not Found"))
        self.assertIsNone(API._zen_balance_from_text('{"balance":"x"}'))
        self.assertIsNone(API._zen_balance_from_text(None))

    def test_console_balance_none_without_cookie(self):
        API._secret = lambda *names: None
        self.assertIsNone(API._zen_console_balance())

    def test_console_balance_none_without_workspace(self):
        API._secret = lambda *names: "fake-cookie" if "CONSOLE_COOKIE" in names[0] else None
        import tempfile
        from pathlib import Path
        API.HOME = Path(tempfile.mkdtemp()) / "nope"  # no opencode.db anywhere
        self.assertIsNone(API._zen_console_balance())

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

ANTHROPIC_URL = "https://api.anthropic.com/api/oauth/usage"

class AnthropicFetcherTest(unittest.TestCase):
    """fetch_anthropic() with a mocked credentials file and mocked HTTP:
    Hermes' helper first, Claude Code OAuth fallback. Fixtures carry a
    placeholder token only — never real credential material."""

    LIVE_BODY = {  # shape verified live against the OAuth usage endpoint
        "five_hour": {"utilization": 40.3, "resets_at": "2026-10-02T07:06:00.000000+00:00"},
        "seven_day": {"utilization": 0.0, "resets_at": "2026-10-07T00:59:59.000000+00:00"},
        "seven_day_opus": None,
    }

    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self.creds = self.home / ".claude" / ".credentials.json"
        self._orig_home = API.HOME
        API.HOME = self.home
        self._orig_http = API._http_json
        self._orig_hermes = API._hermes_usage
        self.calls = []
        self.headers_seen = []

    def tearDown(self):
        API.HOME = self._orig_home
        API._http_json = self._orig_http
        API._hermes_usage = self._orig_hermes
        self._tmp.cleanup()

    def _no_hermes(self):
        # the desktop plugin host: Hermes' helper resolves nothing here
        API._hermes_usage = lambda provider: None

    def _write_creds(self, payload):
        self.creds.parent.mkdir(parents=True, exist_ok=True)
        self.creds.write_text(json.dumps(payload) if not isinstance(payload, str) else payload)

    def _mock_http(self, body):
        def fake(url, headers, **kw):
            self.calls.append(url)
            self.headers_seen.append(dict(headers))
            return body
        API._http_json = fake

    def test_hermes_result_takes_precedence(self):
        API._hermes_usage = lambda provider: {"id": provider, "status": "ok", "windows": []}
        p = API.fetch_anthropic()
        self.assertEqual(self.calls, [])  # no fallback HTTP when Hermes answers

    def test_oauth_fallback_ratio_windows(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": "test-token", "subscriptionType": "pro"}})
        self._mock_http(self.LIVE_BODY)
        p = API.fetch_anthropic()
        self.assertEqual(p["id"], "anthropic")
        self.assertEqual(p["status"], "ok")
        self.assertNotIn("money", p)  # ratio windows, never money rows
        self.assertEqual(p["windows"][0]["label"], "5h")
        self.assertEqual(p["windows"][0]["percent"], 40.3)
        self.assertEqual(p["windows"][0]["resets_at"], "2026-10-02T07:06:00.000000+00:00")
        self.assertEqual(p["windows"][1]["label"], "7d")
        self.assertEqual(p["windows"][1]["percent"], 0.0)  # real 0%, not fabricated

    def test_fallback_headers(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": "test-token"}})
        self._mock_http(self.LIVE_BODY)
        API.fetch_anthropic()
        self.assertEqual(self.calls, [ANTHROPIC_URL])
        hdr = self.headers_seen[0]
        self.assertEqual(hdr["Authorization"], "Bearer test-token")
        self.assertEqual(hdr["anthropic-beta"], "oauth-2025-04-20")

    def test_missing_credentials_file_graceful_error(self):
        self._no_hermes()
        with self.assertRaises(RuntimeError) as cm:
            API.fetch_anthropic()
        self.assertEqual(str(cm.exception), "Claude Code credentials not found")

    def test_malformed_credentials_file_graceful_error(self):
        self._no_hermes()
        self._write_creds("{not json")
        with self.assertRaises(RuntimeError) as cm:
            API.fetch_anthropic()
        self.assertEqual(str(cm.exception), "Claude Code credentials not found")

    def test_wrong_shape_credentials_graceful_error(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": ""}})  # empty token
        with self.assertRaises(RuntimeError):
            API.fetch_anthropic()
        self._write_creds({"mcpOAuth": {}})  # no claudeAiOauth entry
        with self.assertRaises(RuntimeError):
            API.fetch_anthropic()

    def test_token_from_other_entries_never_used(self):
        # mcpOAuth entries are unrelated server tokens; only claudeAiOauth counts
        self._no_hermes()
        self._write_creds({"mcpOAuth": {"x|1": {"accessToken": "mcp-token"}}})
        with self.assertRaises(RuntimeError):
            API.fetch_anthropic()

    def test_window_without_utilization_is_skipped(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": "test-token"}})
        self._mock_http({"five_hour": {"resets_at": "2026-10-02T07:06:00+00:00"}})
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()

    def test_partial_windows_only_render_present_rows(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": "test-token"}})
        self._mock_http({"five_hour": {"utilization": 120.5, "resets_at": None}})
        p = API.fetch_anthropic()
        self.assertEqual(len(p["windows"]), 1)
        self.assertEqual(p["windows"][0]["percent"], 100.0)  # clamped to a sane bar
        self.assertIsNone(p["windows"][0]["resets_at"])
