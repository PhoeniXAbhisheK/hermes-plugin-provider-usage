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


ANTHROPIC_URL = "https://api.anthropic.com/api/oauth/usage"


class AnthropicFetcherTest(unittest.TestCase):
    """fetch_anthropic() with a mocked credentials file and mocked HTTP:
    Hermes' helper first, Claude Code OAuth fallback. Fixtures carry a
    placeholder token only; never real credential material."""

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

    def test_missing_credentials_file_skips(self):
        self._no_hermes()
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()

    def test_malformed_credentials_file_skips(self):
        self._no_hermes()
        self._write_creds("{not json")
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()

    def test_wrong_shape_credentials_skips(self):
        self._no_hermes()
        self._write_creds({"claudeAiOauth": {"accessToken": ""}})  # empty token
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()
        self._write_creds({"mcpOAuth": {}})  # no claudeAiOauth entry
        with self.assertRaises(API._Skip):
            API.fetch_anthropic()

    def test_token_from_other_entries_never_used(self):
        # mcpOAuth entries are unrelated server tokens; only claudeAiOauth counts
        self._no_hermes()
        self._write_creds({"mcpOAuth": {"x|1": {"accessToken": "mcp-token"}}})
        with self.assertRaises(API._Skip):
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


class EnvEncodingTest(unittest.TestCase):
    """GBK/cp936 Windows: any read without an explicit encoding raised
    UnicodeDecodeError. Regression tests for the UTF-8 read sweep."""

    def _point_home(self, home):
        import types
        hc = types.ModuleType("hermes_constants")
        hc.get_hermes_home = lambda: home
        sys.modules["hermes_constants"] = hc
        self.addCleanup(lambda: sys.modules.pop("hermes_constants", None))

    def test_env_read_specifies_encoding(self):
        # A non-UTF-8 platform locale makes any encoding-less read fail; the
        # .env read must pass its own encoding. Simulated with a strict reader
        # (verbatim the Windows failure: no encoding kwarg -> UnicodeDecodeError).
        import pathlib
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            (home / ".env").write_text(
                "# note \u2014 with an em dash\nDEEPSEEK_API_KEY=test-key\n",
                encoding="utf-8",
            )
            self._point_home(home)
            orig = pathlib.Path.read_text

            def strict_locale_read(self, *args, **kwargs):
                if "encoding" not in kwargs:
                    raise UnicodeDecodeError("gbk", b"\x94", 0, 1, "illegal multibyte sequence")
                return orig(self, *args, **kwargs)

            pathlib.Path.read_text = strict_locale_read
            self.addCleanup(lambda: setattr(pathlib.Path, "read_text", orig))
            self.assertEqual(API._hermes_env_value("DEEPSEEK_API_KEY"), "test-key")

    def test_env_read_tolerates_undecodable_bytes(self):
        import pathlib
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            (home / ".env").write_bytes(b"# \x94 broken comment\nZAI_API_KEY=zz\n")
            self._point_home(home)
            self.assertEqual(API._hermes_env_value("ZAI_API_KEY"), "zz")


class ContextPropagationTest(unittest.TestCase):
    """A multiplexed host binds the profile secret scope and profile home in
    contextvars on the request; bare pool workers drop them, so fetchers
    either fail closed (UnscopedSecretError) or read the launch profile
    (#8, #9). Each pool task must run in a copy of the caller's context."""

    def test_collect_copies_context_into_workers(self):
        import contextvars
        marker = contextvars.ContextVar("provider_usage_test_marker", default="unset")
        seen = {}

        def probe():
            seen["marker"] = marker.get()
            return {"id": "deepseek", "status": "ok"}

        orig_order, orig_fetchers = API.FETCH_ORDER, API.FETCHERS
        API.FETCH_ORDER = ("deepseek",)
        API.FETCHERS = dict(API.FETCHERS, deepseek=probe)
        self.addCleanup(lambda: setattr(API, "FETCH_ORDER", orig_order))
        self.addCleanup(lambda: setattr(API, "FETCHERS", orig_fetchers))
        token = marker.set("visible")
        self.addCleanup(lambda: marker.reset(token))

        out = API._collect()
        self.assertEqual(seen.get("marker"), "visible",
                         "collect worker lost the caller's context")
        self.assertEqual([p["id"] for p in out["providers"]], ["deepseek"])

    def test_nous_pool_copies_context_into_workers(self):
        import contextvars
        import types
        marker = contextvars.ContextVar("provider_usage_test_marker_nous", default="unset")
        seen = {}

        def fake_get_nous_portal_account_info(force_fresh=False):
            seen["marker"] = marker.get()
            return {"ok": True}

        class FakeWindow:
            label = "Credits"
            used_percent = 12.5
            reset_at = None

        class FakeSnapshot:
            available = True
            windows = (FakeWindow(),)

        agent_pkg = types.ModuleType("agent")
        agent_mod = types.ModuleType("agent.account_usage")
        agent_mod.build_nous_credits_snapshot = lambda info: FakeSnapshot()
        agent_pkg.account_usage = agent_mod
        cli_pkg = types.ModuleType("hermes_cli")
        cli_mod = types.ModuleType("hermes_cli.nous_account")
        cli_mod.get_nous_portal_account_info = fake_get_nous_portal_account_info
        cli_pkg.nous_account = cli_mod
        for name, mod in (
            ("agent", agent_pkg),
            ("agent.account_usage", agent_mod),
            ("hermes_cli", cli_pkg),
            ("hermes_cli.nous_account", cli_mod),
        ):
            orig = sys.modules.get(name)
            sys.modules[name] = mod
            if orig is None:
                self.addCleanup(lambda n=name: sys.modules.pop(n, None))
            else:
                self.addCleanup(lambda n=name, m=orig: sys.modules.__setitem__(n, m))

        token = marker.set("visible")
        self.addCleanup(lambda: marker.reset(token))

        p = API.fetch_nous()
        self.assertEqual(seen.get("marker"), "visible",
                         "nous pool worker lost the caller's context")
        self.assertEqual(p["id"], "nous")
        self.assertEqual(p["windows"][0]["percent"], 12.5)


if __name__ == "__main__":
    unittest.main()
